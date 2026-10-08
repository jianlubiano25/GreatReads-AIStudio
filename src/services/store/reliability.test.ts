import test from 'node:test';
import assert from 'node:assert/strict';
import type { CuratedShelf } from '../../data/storeCatalog';
import { cleanSeeds, dynamicCuratedSource, dynamicInfo, mergeAppend, refreshShelf, type DynamicSpec } from './dynamic';
import { seedId, seedPlaceholders } from './curated';
import { cleanAuthorName, cleanTitle, fetchWikiPicks, mergePicks, parseWhen, parseWikiTables, picksFromTables, type ColumnRule } from './wikiLists';
import { bestsellerSource, NYT_EXTRA_SHELVES } from './bestsellers';
import { forgetNytList, lastNytFailure, loadNytList, nytTuning } from '../books/sources/nyt';
import { resolveBook } from '../books/resolve';
import { nytList, routeFetch } from './testkit';
// @ts-ignore plain JS module with no type declarations
import { onRequestGet as nytFunction } from '../../../functions/api/nyt.js';

type Seed = [string, string, string?];

/* NOTE: wikitext fixtures below imitate the markup problems Wikipedia tables have (flags, small-print notes, footnotes, line breaks).
   They were written for these tests; run `npm run check:shelves` to see what the real pages give today. */

/* ------------------------------ author names: the Women's Prize bug ------------------------------ */

test('cleanAuthorName removes everything that is not the name, so a cover search can find the book', () => {
  const cases: [string, string][] = [
    ['Madeline Miller (US)', 'Madeline Miller'],
    ['Maggie O’Farrell†', 'Maggie O’Farrell'],
    ['Ali Smith[a]', 'Ali Smith'],
    ['Ann Patchett *', 'Ann Patchett'],
    ['Lionel Shriver, American novelist', 'Lionel Shriver'],
    ['Kamila Shamsie (shortlisted)', 'Kamila Shamsie'],
    ['Andrea Levy <!-- c --> ', 'Andrea Levy'],
    ['Han Kang 한강', 'Han Kang'],
    ['Jenny Erpenbeck, Michael Hofmann', 'Jenny Erpenbeck & Michael Hofmann'],
    ['Jhumpa Lahiri – translated by Someone Else', 'Jhumpa Lahiri'],
    ['Tayari‎ Jones‏', 'Tayari Jones'],
    ['Martin Luther King, Jr.', 'Martin Luther King'],
    ['King, Lily', 'King, Lily'], // Last, First is a name, not two authors
    ['Zadie Smith', 'Zadie Smith'],
  ];
  for (const [raw, want] of cases) assert.equal(cleanAuthorName(raw), want, raw);
  assert.equal(cleanTitle('The Safekeep[1]†'), 'The Safekeep');
});

const PRIZE: ColumnRule = { title: /^(title|novel|book)/i, author: /^(author|writer|winner)/i, when: /^(year|date)/i, result: /^(result|status|outcome)/i, winner: /winner/i, onePerYear: true };
const dirtyPrize = (rows: [number, string, string][]) => `{| class="wikitable"
! Year !! Author !! Title !! Result !! Ref
|-
${rows.map(([y, a, t]) => `| ${y} || ${a} || ''${t}'' || Winner || <ref>x</ref>`).join('\n|-\n')}
|}`;

test('a prize table with flags, small-print notes and footnotes gives clean authors and titles', () => {
  const wikitext = dirtyPrize([
    [2026, '{{flagicon|UK}} [[Virginia Evans]] {{small|(US)}}', 'The Correspondent'],
    [2025, '[[Yael van der Wouden]]{{efn|Dutch}}', 'The Safekeep'],
    [2024, '[[Barbara Kingsolver]]<sup>†</sup>', 'Demon Copperhead'],
    [2023, '[[Ann Patchett]]<br />[[Someone Else]]', 'Tom Lake'],
    [2022, '[[Ali Smith]] <small>(shortlisted before)</small>', 'The Accidental'],
    [2021, '[[Susanna Clarke]][a]', 'Piranesi'],
  ]);
  const picks = picksFromTables(parseWikiTables(wikitext), PRIZE)!;
  assert.deepEqual(picks.map(p => p.author), ['Virginia Evans', 'Yael van der Wouden', 'Barbara Kingsolver', 'Ann Patchett & Someone Else', 'Ali Smith', 'Susanna Clarke']);
  assert.equal(picks[0].title, 'The Correspondent');
});

test('saved lists written by an earlier version are repaired when read, and the repaired book is not added twice', () => {
  const dirty: Seed[] = [['The Correspondent', 'Virginia Evans (US)', "Women's Prize 2026"], ['Piranesi', 'Susanna Clarke[a]', "Women's Prize 2021"], ['Piranesi', 'Susanna Clarke', 'dup']];
  assert.deepEqual(cleanSeeds(dirty), [['The Correspondent', 'Virginia Evans', "Women's Prize 2026"], ['Piranesi', 'Susanna Clarke', "Women's Prize 2021"]]);
  // a refresh that now reads the clean name must not leave the dirty one behind next to it
  const merged = mergeAppend([['The Correspondent', 'Virginia Evans', 'Women’s Prize 2026']], [['The Correspondent', 'Virginia Evans (US)', 'old'], ['Older', 'Old Author']]);
  assert.deepEqual(merged.map(s => s[0]), ['The Correspondent', 'Older']);
});

test('numeric and template dates are read (month included), so newest-first ordering is right', () => {
  assert.deepEqual(parseWhen('2026-03-17'), { at: 2026 * 12 + 2, year: 2026, label: 'Mar 2026' });
  assert.deepEqual(parseWhen('2026 11 04'), { at: 2026 * 12 + 10, year: 2026, label: 'Nov 2026' });
  assert.equal(parseWhen('2026')?.label, '2026');
  assert.equal(parseWhen('1996 was a year')?.label, '1996');
});

/* ------------------------------ Oprah: several pages are combined ------------------------------ */

const OPRAH: ColumnRule = { title: /^(title|book|selection)/i, author: /^author/i, when: /(date|month|year|selected|announced)/i };
const club = (rows: [string, string, string][]) => `{| class="wikitable"\n! Date !! Title !! Author\n|-\n${rows.map(([d, t, a]) => `| ${d} || ''${t}'' || ${a}`).join('\n|-\n')}\n|}`;

test('every candidate page counts: a stale main article cannot hide newer picks listed on another page', async () => {
  const older: [string, string, string][] = Array.from({ length: 6 }, (_, i) => [`May ${i + 1}, 2020`, `Old ${i}`, `Author ${i}`]);
  const newer: [string, string, string][] = [['April 2, 2026', 'Newest', 'N Author'], ...older.slice(0, 5)];
  routeFetch([
    u => (u.hostname === 'en.wikipedia.org' && u.searchParams.get('page') === 'Main' ? { body: { parse: { wikitext: club(older) } } } : undefined),
    u => (u.hostname === 'en.wikipedia.org' && u.searchParams.get('page') === 'List' ? { body: { parse: { wikitext: club(newer) } } } : undefined),
  ]);
  const picks = await fetchWikiPicks(['Main', 'List'], OPRAH);
  assert.equal(picks?.[0].title, 'Newest');
  assert.equal(picks?.filter(p => p.title === 'Old 0').length, 1); // the book on both pages counts once
  routeFetch([u => ({ status: 500 })]);
  assert.equal(await fetchWikiPicks(['Main', 'List'], OPRAH), null);
  assert.equal(mergePicks([]), null);
});

test('a source that cannot be read is reported on the shelf so a shelf stuck on its hand-picked list explains itself', async () => {
  const sh: CuratedShelf = { id: 't-status', title: 'Club', emoji: '⭐', genre: 'Club', seeds: [['A', 'B C'], ['D', 'E F']] };
  const spec: DynamicSpec = { source: 'Test source', kind: 'fallback', refreshMs: 1000, minSeeds: 2, fetch: async () => null, merge: 'append' };
  assert.doesNotMatch(dynamicInfo(sh, spec).source, /last check failed/);
  assert.equal(await refreshShelf(sh, spec, 5_000), null);
  assert.match(dynamicInfo(sh, spec).source, /last check failed .* hand-picked/);
  await refreshShelf(sh, { ...spec, fetch: async () => ({ seeds: [['New', 'N One'], ['New 2', 'N Two']] }) }, 6_000);
  assert.doesNotMatch(dynamicInfo(sh, spec).source, /last check failed/);
});

/* ------------------------------ covers when a list refreshes ------------------------------ */

test('a placeholder id belongs to the book, not the slot (a refreshed list never reuses another book\'s id)', () => {
  const a = seedPlaceholders({ id: 't-ids', title: 't', emoji: '', genre: 'x', seeds: [['Alpha', 'Ann One'], ['Beta', 'Bo Two']] });
  const b = seedPlaceholders({ id: 't-ids', title: 't', emoji: '', genre: 'x', seeds: [['Gamma', 'Cy Three'], ['Alpha', 'Ann One']] });
  assert.notEqual(a[0].id, b[0].id); // slot 0 now holds another book
  assert.equal(a[0].id, b[1].id); // the same book keeps its id when it moves
  assert.equal(seedId('s', 'The Safekeep: A Novel', 'Yael van der Wouden'), seedId('s', 'Safekeep', 'Yael Van Der Wouden'));
});

test('while a refresh swaps the list in, the OLD list\'s late cover lookups never overwrite the new list on screen', async () => {
  const base: CuratedShelf = { id: 't-race', title: 'Race', emoji: '📚', genre: 'Club', seeds: [['Race Base 1', 'Some Author'], ['Race Base 2', 'Some Author']] };
  const old = Date.now() - 10 * 24 * 3600_000;
  await refreshShelf(base, { source: 't', refreshMs: 1, minSeeds: 2, fetch: async () => ({ seeds: [['Race Old 1', 'Some Author'], ['Race Old 2', 'Some Author']] }), merge: undefined }, old);

  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  (globalThis as any).fetch = async (input: any) => {
    const url = new URL(String(input), 'https://greatreads.test');
    const title = url.searchParams.get('title') || '';
    if (title.startsWith('Race Old')) await gate; // the old list's lookups are slow
    const docs = url.hostname === 'openlibrary.org' && title ? [{ key: `/works/OL${title.length}W`, title, author_name: ['Some Author'], cover_i: 42, first_publish_year: 2020 }] : [];
    return { ok: true, status: 200, json: async () => (url.hostname === 'openlibrary.org' ? { docs } : {}) };
  };

  const src = dynamicCuratedSource(base, { source: 't', refreshMs: 1000, minSeeds: 2, fetch: async () => ({ seeds: [['Race New 1', 'Some Author', 'fresh'], ['Race New 2', 'Some Author', 'fresh']] }) });
  const updates: string[][] = [];
  const first = src.load(b => updates.push(b.map(x => x.title)));
  await new Promise(r => setTimeout(r, 60)); // the refreshed list arrives and its covers resolve; the old list's lookups are still blocked
  assert.deepEqual(updates.at(-1), ['Race New 1', 'Race New 2']);
  release();
  await first;
  await new Promise(r => setTimeout(r, 60));
  for (const u of updates.slice(updates.findIndex(x => x[0] === 'Race New 1'))) assert.deepEqual(u, ['Race New 1', 'Race New 2'], 'only the new list may appear once it has been shown');
  assert.equal(src.cached()?.[0].title, 'Race New 1');
});

test('a book no source could place is remembered only briefly, and a found book is reused', async () => {
  const calls = routeFetch([u => (u.hostname === 'openlibrary.org' ? { body: { docs: [] } } : { body: {} })]);
  assert.equal(await resolveBook({ title: 'Missing Miss Book', author: 'Nobody Here' }), null);
  const n = calls.length;
  assert.equal(await resolveBook({ title: 'Missing Miss Book', author: 'Nobody Here' }), null);
  assert.equal(calls.length, n, 'asked again straight away: no new requests');

  routeFetch([u => (u.hostname === 'openlibrary.org' ? { body: { docs: [{ key: '/works/OL77W', title: 'Found Fine Book', author_name: ['Fi Nder'], cover_i: 9 }] } } : { body: {} })]);
  const first = await resolveBook({ title: 'Found Fine Book', author: 'Fi Nder' });
  assert.equal(first?.book.coverId, 9);
  const after = routeFetch([]);
  assert.equal((await resolveBook({ title: 'Found Fine Book', author: 'Fi Nder' }))?.book.coverId, 9);
  assert.equal(after.length, 0);
});

/* ------------------------------ NYT: rate limits ------------------------------ */

const FICTION = [['Space Tale', 'Ann One', '9780306406157'], ['Quiet House', 'Bo Two', '9780306406164']] as [string, string, string][];

test('a rate-limited NYT list is waited out and asked again; the reason is remembered until it loads', async () => {
  const tuning = nytTuning.backoffMs;
  nytTuning.backoffMs = [0, 0];
  try {
    forgetNytList('t-rate');
    let hits = 0;
    routeFetch([u => (u.pathname === '/api/nyt' ? (++hits < 3 ? { status: 429, body: { error: 'rate_limited' } } : { body: nytList(FICTION) }) : undefined)]);
    const r = await loadNytList('t-rate');
    assert.equal(r.entries?.length, 2);
    assert.equal(hits, 3);
    assert.equal(lastNytFailure('t-rate'), undefined);

    forgetNytList('t-rate-2');
    routeFetch([u => (u.pathname === '/api/nyt' ? { status: 429, body: { error: 'rate_limited' } } : undefined)]);
    const bad = await loadNytList('t-rate-2');
    assert.equal(bad.entries, null);
    assert.equal(bad.failure, 'rate_limited');
    assert.equal(lastNytFailure('t-rate-2'), 'rate_limited');
  } finally {
    nytTuning.backoffMs = tuning;
  }
});

test('when a NYT list is unavailable its shelf says why (a hidden shelf cannot)', async () => {
  const shelf = NYT_EXTRA_SHELVES.find(s => s.id === 'nyt-paperback-nonfiction')!;
  const tuning = nytTuning.backoffMs;
  nytTuning.backoffMs = [0];
  try {
    forgetNytList(shelf.list);
    routeFetch([u => (u.pathname === '/api/nyt' ? { status: 429, body: { error: 'rate_limited' } } : undefined)]);
    const src = bestsellerSource(shelf);
    await assert.rejects(() => src.load(() => {}));
    assert.match(src.info?.().source || '', /not loading right now: the NYT rate limit/);
  } finally {
    nytTuning.backoffMs = tuning;
  }
});

/* ------------------------------ NYT Pages function: last good copy ------------------------------ */

function fakeCaches() {
  const saved = new Map<string, Response>();
  (globalThis as any).caches = {
    default: {
      match: async (req: Request) => saved.get(req.url)?.clone(),
      put: async (req: Request, res: Response) => { saved.set(req.url, res); },
    },
  };
  return saved;
}
const upstream = (status: number, body: unknown) => {
  (globalThis as any).fetch = async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
};
const ask = (list = 'paperback-nonfiction') => nytFunction({ request: new Request(`https://greatreads.pages.dev/api/nyt?list=${list}`), env: { NYT_API_KEY: 'k' }, waitUntil: () => {} });

test('NYT function: a rate limit or outage serves the last good list; a bad key or missing setup is never hidden by it', async () => {
  const saved = fakeCaches();
  try {
    upstream(200, { results: { books: [{ rank: 1, title: 'GOOD' }] } });
    assert.equal((await ask()).status, 200);
    assert.equal(saved.size, 1);

    upstream(429, { fault: 'rate' });
    const limited = await ask();
    assert.equal(limited.status, 200);
    assert.equal(limited.headers.get('x-nyt-stale'), '1');
    assert.equal((await limited.json()).results.books[0].title, 'GOOD');

    upstream(500, {});
    assert.equal((await ask()).status, 200);
    (globalThis as any).fetch = async () => { throw new Error('boom'); };
    assert.equal((await ask()).headers.get('x-nyt-stale'), '1');

    upstream(401, {});
    const unauthorized = await ask();
    assert.equal(unauthorized.status, 502);
    assert.equal((await unauthorized.json()).error, 'unauthorized');

    upstream(429, {});
    const other = await ask('hardcover-fiction'); // a list nothing is saved for
    assert.equal(other.status, 429);
  } finally {
    delete (globalThis as any).caches;
  }
});
