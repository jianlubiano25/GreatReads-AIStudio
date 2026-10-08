import test from 'node:test';
import assert from 'node:assert/strict';
import type { CuratedShelf } from '../../data/storeCatalog';
import type { Hit } from '../books/sources/types';
import { makeBook } from '../books/model';
import { DYNAMIC_SPECS, cleanSeeds, dynamicCuratedSource, isDue, rankDiscovery, refreshShelf, RETRY_MS, type DynamicSpec } from './dynamic';
import { cleanWiki, fetchWikiPicks, parseWhen, parseWikiTables, picksFromTables, type ColumnRule } from './wikiLists';
import { nytList, routeFetch } from './testkit';
import { NYT_EXTRA_SHELVES, NYT_SHELVES, bestsellerSource } from './bestsellers';
import { forgetNytList } from '../books/sources/nyt';
import { CURATED_SHELVES } from '../../data/storeCatalog';

/* NOTE: these fixtures imitate MediaWiki table syntax. They were written for the tests, not copied from a live page; run
   `npm run check:shelves` to see what each real source returns today. */

const OPRAH: ColumnRule = { title: /^(title|book|selection)/i, author: /^author/i, when: /(date|month|year|selected|announced)/i };
const PRIZE: ColumnRule = { title: /^(title|novel|book)/i, author: /^(author|writer|winner)/i, when: /^(year|date)/i, result: /^(result|status|outcome)/i, winner: /winner/i, onePerYear: true };

const oprahWikitext = (rows: [string, string, string][]) => `Intro text.
{| class="wikitable sortable"
|+ Selections
|-
! scope="col" | Date !! scope="col" | Title !! scope="col" | Author !! class="unsortable" | Ref
|-
${rows.map(([d, t, a]) => `| ${d} || ''[[${t}]]''<ref>cite</ref> || [[${a}|${a.split(' ').pop()}]] || {{cite web|url=x}}`).join('\n|-\n')}
|}
== After ==
`;

/* ------------------------------ wikitext reading ------------------------------ */

test('cleanWiki strips links, italics, references, templates and HTML', () => {
  assert.equal(cleanWiki("''[[The Safekeep]]''<ref name=a>x</ref>"), 'The Safekeep');
  assert.equal(cleanWiki('[[Banu Mushtaq|Banu&nbsp;Mushtaq]]<br />[[Deepa Bhasthi]]'), 'Banu Mushtaq, Deepa Bhasthi');
  assert.equal(cleanWiki('{{nowrap|Yael van der Wouden}} {{efn|note}}'), 'Yael van der Wouden');
  assert.equal(cleanWiki('{{sortname|Tara|Westover}}'), 'Tara Westover');
  assert.equal(cleanWiki('[https://x.org Title Here] [1]'), 'Title Here');
  assert.equal(cleanWiki('<!-- hidden -->Visible †'), 'Visible');
});

test('parseWhen reads full dates, month + year and bare years', () => {
  assert.deepEqual(parseWhen('March 17, 2026'), { at: 2026 * 12 + 2, year: 2026, label: 'Mar 2026' });
  assert.deepEqual(parseWhen('17 September 1996'), { at: 1996 * 12 + 8, year: 1996, label: 'Sep 1996' });
  assert.deepEqual(parseWhen('2025'), { at: 2025 * 12, year: 2025, label: '2025' });
  assert.equal(parseWhen('TBA'), null);
});

test('parseWikiTables: header names, attributes, multi-line cells and rowspan', () => {
  const [t] = parseWikiTables(`{| class="wikitable"
! Year !! Author !! Title !! Result
|-
| rowspan="2" style="x" | 2026
| [[A One]]
| ''First'' line
continues here
| Winner
|-
| B Two || ''Second'' || Shortlisted
|}`);
  assert.deepEqual(t.headers, ['Year', 'Author', 'Title', 'Result']);
  assert.deepEqual(t.rows[0], ['2026', 'A One', 'First line continues here', 'Winner']);
  assert.deepEqual(t.rows[1], ['2026', 'B Two', 'Second', 'Shortlisted']); // the year carried down from the rowspan
});

test('parseWikiTables ignores tables nested in cells and pages with no tables', () => {
  assert.deepEqual(parseWikiTables('Just prose, no tables.'), []);
  const tables = parseWikiTables(`{| class="wikitable"
! Title !! Author
|-
| X || {| nested
|-
| ignored
|}
|}`);
  assert.equal(tables.length, 1);
});

/* ------------------------------ picks ------------------------------ */

test('Oprah-style table: newest picks first, labelled by their own dates', () => {
  const rows: [string, string, string][] = [
    ['September 17, 1996', 'The Deep End of the Ocean', 'Jacquelyn Mitchard'],
    ['June 2, 2004', 'Cane River', 'Lalita Tademy'],
    ['March 4, 2024', 'Familiaris', 'David Wroblewski'],
    ['January 6, 2026', 'Old Book', 'Some Writer'],
    ['April 9, 2026', 'Newest Book', 'Latest Author'],
    ['May 5, 2015', 'Middle Book', 'Mid Author'],
  ];
  const picks = picksFromTables(parseWikiTables(oprahWikitext(rows)), OPRAH)!;
  assert.deepEqual(picks.slice(0, 3).map(p => [p.title, p.when]), [['Newest Book', 'Apr 2026'], ['Old Book', 'Jan 2026'], ['Familiaris', 'Mar 2024']]);
  assert.equal(picks.length, 6);
});

test('prize table: only the winner of each year, shortlisted rows and "no award" years left out', () => {
  const wikitext = `{| class="wikitable"
! Year !! Author !! Title !! Result
|-
| rowspan=3 | 2026 || Winner Wendy || ''Win Book'' || Winner
|-
| Short Sam || ''Short Book'' || Shortlisted
|-
| Short Sue || ''Another'' || Shortlisted
|-
| 2025 || Yael One || ''Safe'' || Winner
|-
| 2024 || Third Three || ''Third Book'' || Winner
|-
| 2023 || Fourth Four || ''Fourth Book'' || Winner
|-
| 2022 || Fifth Five || ''Fifth Book'' || Winner
|-
| 2021 || — || No award || Winner
|}`;
  const picks = picksFromTables(parseWikiTables(wikitext), PRIZE)!;
  assert.deepEqual(picks.map(p => p.title), ['Win Book', 'Safe', 'Third Book', 'Fourth Book', 'Fifth Book']);
  assert.equal(picks[0].when, '2026');
});

test('a prize table without a result column keeps the first row of each year', () => {
  const rows = [2026, 2026, 2025, 2025, 2024, 2023, 2022].map((y, i) => `| ${y} || Author ${i} || Book ${i}`).join('\n|-\n');
  const picks = picksFromTables(parseWikiTables(`{| class="wikitable"\n! Year !! Author !! Title\n|-\n${rows}\n|}`), { ...PRIZE, result: undefined, winner: undefined })!;
  assert.deepEqual(picks.map(p => p.title), ['Book 0', 'Book 2', 'Book 4', 'Book 5', 'Book 6']);
});

test('a page that cannot be read safely gives no picks (so the shelf keeps its saved list)', () => {
  assert.equal(picksFromTables(parseWikiTables('no tables'), OPRAH), null);
  // no date column: nothing says which picks are newest
  const undated = `{| class="wikitable"\n! Title !! Author\n|-\n${Array.from({ length: 8 }, (_, i) => `| B${i} || A${i}`).join('\n|-\n')}\n|}`;
  assert.equal(picksFromTables(parseWikiTables(undated), OPRAH), null);
  // too few usable rows
  assert.equal(picksFromTables(parseWikiTables(oprahWikitext([['May 5, 2015', 'Only', 'One Author']])), OPRAH), null);
});

test('fetchWikiPicks tries the next page when the first has no usable table', async () => {
  const rows: [string, string, string][] = Array.from({ length: 6 }, (_, i) => [`May ${i + 1}, 20${10 + i}`, `Book ${i}`, `Author ${i}`]);
  const calls = routeFetch([
    u => (u.hostname === 'en.wikipedia.org' && u.searchParams.get('page') === 'Page One' ? { body: { parse: { wikitext: 'prose only' } } } : undefined),
    u => (u.hostname === 'en.wikipedia.org' && u.searchParams.get('page') === 'Page Two' ? { body: { parse: { wikitext: oprahWikitext(rows) } } } : undefined),
  ]);
  const picks = await fetchWikiPicks(['Page One', 'Page Two'], OPRAH);
  assert.equal(picks?.[0].title, 'Book 5');
  assert.equal(calls.length, 2);
  assert.ok(calls[0].includes('origin=*') || calls[0].includes('origin=%2A')); // lets the browser read it
  routeFetch([u => ({ status: 500 })]);
  assert.equal(await fetchWikiPicks(['Page One'], OPRAH), null);
});

/* ------------------------------ Open Library discovery ------------------------------ */

const hit = (title: string, author: string, o: Partial<{ ratings: number; avg: number; year: number; cover: number | null; subjects: string[] }> = {}): Hit => ({
  book: makeBook({ id: `ol_${title}`, title, author, year: String(o.year ?? 2025), coverId: o.cover === null ? undefined : o.cover ?? 5, ratingCount: o.ratings ?? 200, ratingAverage: o.avg ?? 4.1, source: 'openlibrary' }),
  flags: { subjects: o.subjects },
});

test('rankDiscovery: covers only, one book per author, no study guides, box sets or explicit books', () => {
  const hits = [
    hit('Good One', 'Ann Author'),
    hit('Good Two', 'Ann Author'), // same author: only one survives
    hit('No Cover', 'Bo Writer', { cover: null }),
    hit('Summary of Good One', 'Bot Press'),
    hit('The Complete Box Set', 'Cy Seller'),
    hit('Steamy Thing', 'Di Erotic', { subjects: ['Erotica'] }),
    hit('Fine Book', 'Eve Real', { ratings: 900, avg: 4.4 }),
    hit('Another Fine', 'Fay Real', { ratings: 50 }),
  ];
  const out = rankDiscovery(hits, { year: 2026, limit: 12, minRatings: 3 });
  const titles = out.map(s => s[0]);
  assert.ok(titles.includes('Fine Book') && titles.includes('Another Fine') && titles.includes('Good One'));
  for (const bad of ['Good Two', 'No Cover', 'Summary of Good One', 'The Complete Box Set', 'Steamy Thing']) assert.ok(!titles.includes(bad), bad);
  assert.equal(new Set(out.map(s => s[1])).size, out.length);
});

test('rankDiscovery: well-read, well-rated books outrank thin ones; a young list keeps its unrated books', () => {
  const out = rankDiscovery([hit('Thin', 'A A', { ratings: 4, avg: 3 }), hit('Beloved', 'B B', { ratings: 5000, avg: 4.5 })], { year: 2026, limit: 2 });
  assert.equal(out[0][0], 'Beloved');
  const young = rankDiscovery([hit('New A', 'A A', { ratings: 0 }), hit('New B', 'B B', { ratings: 0 })], { year: 2026, limit: 5 });
  assert.equal(young.length, 2);
});

test('cleanSeeds drops blanks, unknown authors and repeats', () => {
  assert.deepEqual(cleanSeeds([['A', 'X Y'], ['The A', 'X Y'], ['', 'Z'], ['B', 'Unknown Author'], ['C', 'Q R', 'label']]), [['A', 'X Y'], ['C', 'Q R', 'label']]);
});

/* ------------------------------ refresh engine ------------------------------ */

const shelf = (id: string, n = 12): CuratedShelf => ({ id, title: 'Test shelf', emoji: '📚', genre: 'Fiction', seeds: Array.from({ length: n }, (_, i) => [`Base ${i}`, `Base Author ${i}`] as [string, string]) });
const freshSeeds = (tag: string, n = 10) => Array.from({ length: n }, (_, i) => [`${tag} ${i}`, `${tag} Author ${i}`, `label ${i}`] as [string, string, string]);
const spec = (fetch: DynamicSpec['fetch'], refreshMs = 1000): DynamicSpec => ({ source: 'test', refreshMs, minSeeds: 8, fetch });

test('refreshShelf saves a good list, rejects a short one, and keeps the old list when the source fails', async () => {
  const sh = shelf('t-engine');
  const good = await refreshShelf(sh, spec(async () => ({ seeds: freshSeeds('Good') })));
  assert.equal(good?.seeds.length, 10);
  assert.equal(good?.seeds[0][0], 'Good 0');

  // a source that answers with too little is a failed refresh: the saved list stays
  assert.equal(await refreshShelf(sh, spec(async () => ({ seeds: freshSeeds('Short', 3) }))), null);
  // a source that throws or returns nothing: same
  assert.equal(await refreshShelf(sh, spec(async () => { throw new Error('down'); })), null);
  assert.equal(await refreshShelf(sh, spec(async () => null)), null);

  // the saved list is still the good one, and the failed tries did not make it look newer or retry-able at once
  let calls = 0;
  const src = dynamicCuratedSource(sh, spec(async () => { calls++; return { seeds: freshSeeds('Never') }; }, 10 * 60 * 1000));
  routeFetch([]);
  await src.load(() => {});
  assert.equal(calls, 0); // saved list is fresh enough: no request at all
  assert.equal(src.cached()?.[0].title, 'Good 0');
});

test('isDue: waits for the schedule, and after a failure waits an hour before trying again', () => {
  const s = { seeds: [], at: 1_000_000, tried: 1_000_000 };
  const sp = { refreshMs: 24 * 3600_000 };
  assert.equal(isDue(undefined, sp, 5), true);
  assert.equal(isDue(s, sp, 1_000_000 + 23 * 3600_000), false);
  assert.equal(isDue(s, sp, 1_000_000 + 25 * 3600_000), true);
  assert.equal(isDue({ ...s, tried: 1_000_000 + 24.5 * 3600_000 }, sp, 1_000_000 + 25 * 3600_000), false); // failed a moment ago
  assert.equal(isDue({ ...s, tried: 1_000_000 + 24.5 * 3600_000 }, sp, 1_000_000 + 24.5 * 3600_000 + RETRY_MS + 1), true);
});

test('dynamic shelf, first visit: fetches once, shows the fresh list with the source\'s labels, and does not fetch again until due', async () => {
  const sh = shelf('t-first');
  let calls = 0;
  const sp = spec(async () => { calls++; return { seeds: freshSeeds('Fresh'), title: 'Fresh title' }; }, 60 * 60 * 1000);
  routeFetch([]);
  const src = dynamicCuratedSource(sh, sp);
  assert.equal(src.cached()?.[0].title, 'Base 0'); // before any refresh the hand-picked list shows
  const books = await src.load(() => {});
  assert.equal(calls, 1);
  assert.equal(books[0].title, 'Fresh 0');
  assert.equal(books[0].awardLabel, 'label 0');
  assert.equal(src.label?.(), '📚 Fresh title');
  await dynamicCuratedSource(sh, sp).load(() => {});
  assert.equal(calls, 1);
});

test('dynamic shelf, first visit with the source down: the hand-picked list is the shelf', async () => {
  const sh = shelf('t-down');
  routeFetch([]);
  const books = await dynamicCuratedSource(sh, spec(async () => null)).load(() => {});
  assert.equal(books[0].title, 'Base 0');
  assert.equal(books.length, 12);
});

test('dynamic shelf, due: shows the saved list at once, then swaps in the fresh one; a failing refresh changes nothing', async () => {
  const sh = shelf('t-due');
  const old = Date.now() - 5 * 24 * 3600_000;
  await refreshShelf(sh, spec(async () => ({ seeds: freshSeeds('Old') })), old);

  routeFetch([]);
  const updates: string[] = [];
  const src = dynamicCuratedSource(sh, spec(async () => ({ seeds: freshSeeds('New') }), 24 * 3600_000));
  const first = await src.load(b => updates.push(b[0].title));
  assert.equal(first[0].title, 'Old 0'); // the saved list is what load() resolves with: no waiting for the network
  await new Promise(r => setTimeout(r, 50));
  assert.ok(updates.includes('New 0'), 'the fresh list is pushed to the shelf');
  assert.equal(src.cached()?.[0].title, 'New 0');

  // now failing, and due again: the saved (new) list stays
  const sh2 = shelf('t-due-fail');
  await refreshShelf(sh2, spec(async () => ({ seeds: freshSeeds('Kept') })), old);
  const failing = dynamicCuratedSource(sh2, spec(async () => { throw new Error('down'); }, 24 * 3600_000));
  const kept = await failing.load(() => {});
  await new Promise(r => setTimeout(r, 50));
  assert.equal(kept[0].title, 'Kept 0');
  assert.equal(failing.cached()?.[0].title, 'Kept 0');
});

test('the registry only names shelves that exist, and every dynamic shelf has a schedule and a source', () => {
  const ids = new Set(CURATED_SHELVES.map(s => s.id));
  for (const [id, sp] of Object.entries(DYNAMIC_SPECS)) {
    assert.ok(ids.has(id), `${id} is a shelf`);
    assert.ok(sp.refreshMs >= 24 * 3600_000 && sp.source && sp.minSeeds >= 5, id);
  }
  assert.equal(DYNAMIC_SPECS.new2026.title?.(new Date(2027, 0, 5)), 'New in 2027');
  // hand-picked on purpose: no reliable public source (Reese's and Service95 now have one: Wikipedia's tables of every pick)
  for (const id of ['inklingsclub', 'inklings', 'classics']) assert.equal(DYNAMIC_SPECS[id], undefined, id);
});

/* ------------------------------ extra NYT lists ------------------------------ */

test('extra NYT lists are official-or-nothing, show 10, and do not duplicate the two combined lists', async () => {
  const main = new Set(NYT_SHELVES.map(s => s.list));
  assert.ok(NYT_EXTRA_SHELVES.length >= 3);
  for (const s of NYT_EXTRA_SHELVES) {
    assert.equal(s.fallback, false);
    assert.ok(!main.has(s.list) && !/^(hardcover|combined)/.test(s.list), s.list); // hardcover/combined lists repeat the two main shelves
  }
  assert.equal(new Set(NYT_EXTRA_SHELVES.map(s => s.list)).size, NYT_EXTRA_SHELVES.length);

  const ya = NYT_EXTRA_SHELVES[0];
  forgetNytList(ya.list);
  routeFetch([u => (u.pathname === '/api/nyt' ? { status: 503, body: { error: 'not_configured' } } : undefined)]);
  await assert.rejects(() => bestsellerSource(ya).load(() => {})); // no GreatReads-made stand-in for a niche list

  const rows = Array.from({ length: 15 }, (_, i) => [`Book ${i}`, `Author ${i}`, `97803064061${String(i).padStart(2, '0')}`.slice(0, 13)] as [string, string, string]);
  forgetNytList(ya.list);
  routeFetch([u => (u.pathname === '/api/nyt' && u.searchParams.get('list') === ya.list ? { body: nytList(rows) } : undefined)]);
  const books = await bestsellerSource(ya).load(() => {});
  assert.equal(books.length, 10);
  assert.equal(books[0].title, 'Book 0');
  assert.match(books[0].awardLabel || '', /^NYT bestseller/);
});

/* ------------------------------ International Booker's "Work" column ------------------------------ */

test('stripNativeTitle drops an original-language title in another script and keeps real titles', async () => {
  const { stripNativeTitle } = await import('./wikiLists');
  assert.equal(stripNativeTitle('The Vegetarian 채식주의자'), 'The Vegetarian');
  assert.equal(stripNativeTitle('Taiwan Travelogue 臺灣漫遊錄'), 'Taiwan Travelogue');
  assert.equal(stripNativeTitle('Heart Lamp: Selected Stories ಎದೆಯ ಹಣತೆ'), 'Heart Lamp: Selected Stories');
  assert.equal(stripNativeTitle('A Horse Walks into a Bar סוס אחד נכנס לבר\u200e'), 'A Horse Walks into a Bar');
  assert.equal(stripNativeTitle('Celestial Bodies سيدات القمر'), 'Celestial Bodies');
  assert.equal(stripNativeTitle("Don't Look Back: A Café Story"), "Don't Look Back: A Café Story");
  assert.equal(stripNativeTitle('채식주의자'), '채식주의자'); // nothing but native script: left alone
});

test('International Booker table: the book column is "Work", the year is in each row, the other tables are ignored', async () => {
  const winners = `{| class="wikitable"
! Year !! Author !! Home country !! Translator !! Translation published in (country) !! Work !! Language !! Ref.
|-
| 2022 || Geetanjali Shree || India || Daisy Rockwell || United States || ''Tomb of Sand'' <br />रेत समाधि || Hindi ||
|-
| 2023 || Georgi Gospodinov || Bulgaria || Angela Rodel || UK || ''Time Shelter'' Времеубежище || Bulgarian ||
|-
| 2024 || Jenny Erpenbeck || Germany || Michael Hofmann || Germany || ''Kairos'' || German ||
|-
| 2025 || Banu Mushtaq || India || Deepa Bhasthi || India || ''Heart Lamp: Selected Stories'' ಎದೆಯ ಹಣತೆ || Kannada ||
|-
| 2026 || Yang Shuang-zi || Taiwan || Lin King || UK || ''Taiwan Travelogue'' 臺灣漫遊錄 || Mandarin Chinese ||
|}
{| class="wikitable"
! Award !! Author !! Country !! Translator !! Title !! Publisher
|-
| Winner || Han Kang || South Korea || Deborah Smith || The Vegetarian || Portobello Books
|}`;
  const rule: ColumnRule = { title: /^(title|novel|book|work|winning (book|work))/i, author: /^(author|writer|winner)/i, when: /^(year|date)/i, result: /^(result|status|outcome)/i, winner: /winner/i, onePerYear: true };
  const picks = picksFromTables(parseWikiTables(winners), rule)!;
  assert.deepEqual(picks.map(p => [p.title, p.author, p.when]), [
    ['Taiwan Travelogue', 'Yang Shuang-zi', '2026'],
    ['Heart Lamp: Selected Stories', 'Banu Mushtaq', '2025'],
    ['Kairos', 'Jenny Erpenbeck', '2024'],
    ['Time Shelter', 'Georgi Gospodinov', '2023'],
    ['Tomb of Sand', 'Geetanjali Shree', '2022'],
  ]);
  // and the shelf's own spec uses this rule
  assert.ok(DYNAMIC_SPECS.intbooker && DYNAMIC_SPECS.womens);
});
