import test from 'node:test';
import assert from 'node:assert/strict';
import type { CuratedShelf } from '../../data/storeCatalog';
import { CURATED_SHELVES } from '../../data/storeCatalog';
import { DYNAMIC_SPECS, dynamicCuratedSource, dynamicInfo, mergeAppend, refreshShelf, type DynamicSpec } from './dynamic';
import { prefetchedFor, seedPlaceholders } from './curated';
import { fetchWikiPicks, parseWikiTables, picksFromTables, type ColumnRule } from './wikiLists';
import { routeFetch } from './testkit';

type Seed = [string, string, string?];
const shelf = (id: string, titles: string[]): CuratedShelf => ({ id, title: id, emoji: '📚', genre: 'Club', seeds: titles.map(t => [t, 'Some Author', 'old label'] as Seed) });
const spec = (fetch: DynamicSpec['fetch'], merge?: 'append'): DynamicSpec => ({ source: 'test', refreshMs: 24 * 3600_000, minSeeds: 2, fetch, merge });

/* ------------------------------ a refresh APPENDS to a book club ------------------------------ */

test('mergeAppend: new picks go in front, earlier ones stay, repeats keep the fresh label, the oldest fall off the cap', () => {
  const existing: Seed[] = [['Old A', 'A'], ['Old B', 'B'], ['Shared', 'S', 'old label']];
  const found: Seed[] = [['Brand New', 'N', 'Oct 2026'], ['Shared', 'S', 'Sep 2026']];
  assert.deepEqual(mergeAppend(found, existing), [['Brand New', 'N', 'Oct 2026'], ['Shared', 'S', 'Sep 2026'], ['Old A', 'A'], ['Old B', 'B']]);
  assert.equal(mergeAppend(found, existing, 3).length, 3);
});

test('refreshing an appending shelf keeps the hand-picked list and adds the new picks, again and again', async () => {
  const sh = shelf('t-club', ['Base 1', 'Base 2', 'Base 3']);
  let round = 0;
  const sp = spec(async () => ({ seeds: round++ === 0 ? [['New 1', 'N', 'Sep 2026'], ['New 2', 'N', 'Aug 2026']] : [['New 0', 'N', 'Oct 2026'], ['New 1', 'N', 'Sep 2026'], ['New 2', 'N', 'Aug 2026']] }), 'append');
  const first = await refreshShelf(sh, sp, 1_000);
  assert.deepEqual(first?.seeds.map(s => s[0]), ['New 1', 'New 2', 'Base 1', 'Base 2', 'Base 3']);
  const second = await refreshShelf(sh, sp, 2_000);
  assert.deepEqual(second?.seeds.map(s => s[0]), ['New 0', 'New 1', 'New 2', 'Base 1', 'Base 2', 'Base 3']);
});

test('a REPLACING shelf still replaces (discovery shelves show what is popular now)', async () => {
  const sh = shelf('t-replace', ['Base 1', 'Base 2', 'Base 3']);
  const r = await refreshShelf(sh, spec(async () => ({ seeds: [['X', 'a'], ['Y', 'b'], ['Z', 'c']] })), 1_000);
  assert.deepEqual(r?.seeds.map(s => s[0]), ['X', 'Y', 'Z']);
});

test('a failed refresh of an appending shelf changes nothing and the manual refresh says so', async () => {
  const sh = shelf('t-club-fail', ['Base 1', 'Base 2']);
  const src = dynamicCuratedSource(sh, spec(async () => null, 'append'));
  routeFetch([]);
  assert.equal(await src.refresh?.(), 'failed');
  assert.equal(src.cached()?.[0].title, 'Base 1');
  assert.match(dynamicCuratedSource(sh, spec(async () => null, 'append')).info?.().source || '', /new picks are added to the top/);
  assert.doesNotMatch(dynamicCuratedSource(sh, spec(async () => null)).info?.().source || '', /added to the top/);
});

test('an appending shelf shows its saved/hand-picked list at once (no waiting for the source) and swaps in the grown list', async () => {
  const sh = shelf('t-club-live', ['Base 1', 'Base 2', 'Base 3']);
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const src = dynamicCuratedSource(sh, spec(async () => { await gate; return { seeds: [['Fresh 1', 'F', 'Oct 2026'], ['Fresh 2', 'F', 'Sep 2026']] }; }, 'append'));
  routeFetch([u => (u.hostname === 'openlibrary.org' ? { body: { docs: [] } } : undefined), u => (u.hostname !== 'openlibrary.org' ? { body: {} } : undefined)]);
  const updates: string[][] = [];
  const shown = await src.load(b => updates.push(b.map(x => x.title)));
  assert.deepEqual(shown.map(b => b.title), ['Base 1', 'Base 2', 'Base 3']); // resolved without waiting for the (still blocked) source
  release();
  await new Promise(r => setTimeout(r, 30));
  assert.deepEqual(updates.at(-1)?.slice(0, 3), ['Fresh 1', 'Fresh 2', 'Base 1']);
});

/* ------------------------------ Reese's and Service95 ------------------------------ */

const REESE_RULE = DYNAMIC_SPECS.reeses;

test('Reese\'s, Oprah and the prizes are dynamic, append, and say they are a Wikipedia stand-in; Service95 is official', () => {
  for (const id of ['reeses', 'service95', 'oprah', 'womens', 'intbooker']) assert.equal(DYNAMIC_SPECS[id].merge, 'append', id);
  for (const id of ['reeses', 'womens', 'intbooker']) {
    const sp = DYNAMIC_SPECS[id];
    assert.ok(sp.source.startsWith('Wikipedia'), id);
    assert.equal(dynamicInfo(CURATED_SHELVES.find(s => s.id === id)!, sp).kind, 'fallback', id); // never presented as the official list
  }
  // Service95 reads the club's own page; Wikipedia is only its labelled fallback
  const s95 = DYNAMIC_SPECS.service95;
  assert.equal(s95.source, 'service95.com/book-club');
  assert.ok(s95.fallbackSource?.startsWith('Wikipedia'));
  assert.equal(dynamicInfo(CURATED_SHELVES.find(s => s.id === 'service95')!, s95).kind, 'official');
  // Oprah: Oprah Daily's own list for the newest picks (read by /api/oprah), Wikipedia for the dates and as the labelled fallback
  const op = DYNAMIC_SPECS.oprah;
  assert.ok(op.source.startsWith('oprahdaily.com') && op.fallbackSource?.startsWith('Wikipedia'));
  assert.equal(dynamicInfo(CURATED_SHELVES.find(s => s.id === 'oprah')!, op).kind, 'official'); // (with a saved list from the Wikipedia stand-in it reports 'fallback', as for Service95)
  assert.equal(DYNAMIC_SPECS.reeses.refreshMs, 7 * 24 * 3600_000);
  assert.equal(DYNAMIC_SPECS.inklingsclub, undefined, 'no reliable public source for the Inklings Book Club: it stays hand-picked');
});

// Shaped like the live Wikipedia article (columns, the two tables, an empty "no selection" month, a shared June/July row)
const REESES_WIKITEXT = `Intro.
== Picks ==
{| class="wikitable"
! Year and Month "Picked" !! Title !! Author !! Genre !! Notes
|-
| September 2026 || ''[[Big Little Truths]]'' || [[Liane Moriarty]] || mystery || sequel
|-
| August 2026 || ''The Wild Beneath'' || Kelly Anderson || romance ||
|-
| July 2026 || ''A Founding Mother'' || Stephanie Dray and Laura Kamoie || historical fiction ||
|-
| October 2025 || || || || no selection this month
|-
| June/July 2020 || ''I'm Still Here'' || Austin Channing Brown || memoir ||
|-
| June/July 2020 || ''The Guest List'' || [[Lucy Foley]] || thriller ||
|-
| June 2017 || ''Eleanor Oliphant Is Completely Fine'' || Gail Honeyman || humor ||
|}
== YA ==
{| class="wikitable"
! Date "Picked" !! Title !! Author
|-
| Summer 2025 || Stuck Up & Stupid || Angourie Rice
|-
| Spring 2025 || Heiress Takes All || Emily Wibberley
|-
| Winter 2024 || Throwback || Maurene Goo
|-
| Fall 2024 || Looking For Smoke || K.A. Cobell
|-
| Summer 2024 || Twelfth Knight || Alexene Farol Follmuth
|}
`;

test("Reese's table: adult picks only, newest first, empty months skipped", () => {
  const rule: ColumnRule = { title: /^title/i, author: /^author/i, when: /^year and month/i };
  const picks = picksFromTables(parseWikiTables(REESES_WIKITEXT), rule, 5)!;
  assert.deepEqual(picks.map(p => p.title).slice(0, 3), ['Big Little Truths', 'The Wild Beneath', 'A Founding Mother']);
  assert.equal(picks[0].when, 'Sep 2026');
  assert.ok(!picks.some(p => /Stuck Up|Throwback/.test(p.title)), 'the YA table is left out');
  assert.ok(!picks.some(p => !p.title));
  assert.equal(picks.length, 6);
  assert.ok(picks.some(p => p.title === 'The Guest List'));
});

test("Reese's source end to end: Wikipedia answers, the shelf grows in front of the hand-picked list", async () => {
  routeFetch([u => (u.hostname === 'en.wikipedia.org' && u.searchParams.get('page') === "Reese's Book Club" ? { body: { parse: { wikitext: REESES_WIKITEXT } } } : undefined)]);
  const reeses = CURATED_SHELVES.find(s => s.id === 'reeses')!;
  const fresh = await REESE_RULE.fetch(reeses);
  // 6 picks in the fixture is fewer than the 8 the shelf requires: a thin answer is rejected, not trusted
  assert.equal(fresh?.seeds.length, 6);
  const saved = await refreshShelf({ ...reeses, id: 't-reeses' }, { ...REESE_RULE, minSeeds: 5 }, 5_000);
  assert.deepEqual(saved?.seeds.slice(0, 2).map(s => s[2]), ["Reese's Book Club · Sep 2026", "Reese's Book Club · Aug 2026"]);
  assert.ok(saved!.seeds.some(s => s[0] === 'Where the Crawdads Sing'), 'the hand-picked staples are still there');
  assert.ok(saved!.seeds.length > 6);
});

test('a page layout change is a failed refresh, not a wrong shelf', async () => {
  routeFetch([u => (u.hostname === 'en.wikipedia.org' ? { body: { parse: { wikitext: 'No tables here, just prose.' } } } : undefined)]);
  assert.equal(await fetchWikiPicks(['Service95'], { title: /^title/i, author: /^author/i, when: /date/i }), null);
  const sh = CURATED_SHELVES.find(s => s.id === 'service95')!;
  assert.equal(await refreshShelf({ ...sh, id: 't-s95' }, DYNAMIC_SPECS.service95, 9_000), null);
});

test('the Service95 hand-picked floor holds only picks that were checked against Service95 / Wikipedia / press, newest first', () => {
  const sh = CURATED_SHELVES.find(s => s.id === 'service95')!;
  assert.ok(sh.seeds.length >= 15);
  assert.deepEqual(sh.seeds.slice(0, 3).map(s => s[0]), ['Martyr!', 'Lost Lambs', 'Free']);
  assert.ok(sh.seeds.every(s => /^Service95 Monthly Read · (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) 20\d\d$/.test(s[2] || '')), 'every pick is dated');
  assert.ok(!sh.seeds.some(s => /Pachinko|A Little Life|Crying in H Mart/.test(s[0])), 'no unverified "Service95 Pick" entries');
});

/* ------------------------------ the stale-cover bug (Dune cover on a different book) ------------------------------ */

test('prefetched covers belong to the book they were fetched for, never to whatever now sits in that slot', () => {
  const sci = CURATED_SHELVES.find(s => s.id === 'scifi')!;
  const [t0, a0] = sci.seeds[0];
  // the bundled list: slot 0 still gets its prefetched cover
  const kept = seedPlaceholders(sci)[0];
  assert.equal(kept.title, t0);
  assert.ok(kept.coverId || kept.coverUrl, 'the bundled book keeps its prefetched cover');
  // after a refresh the same slot holds a different book: it must NOT inherit the old book's cover, rating, year or work id
  const refreshed = { ...sci, seeds: [['Sunrise on the Reaping', 'Suzanne Collins'], ...sci.seeds.slice(1)] as CuratedShelf['seeds'] };
  const other = seedPlaceholders(refreshed)[0];
  assert.equal(other.title, 'Sunrise on the Reaping');
  assert.equal(other.coverId, undefined);
  assert.equal(other.coverUrl, undefined);
  assert.equal(other.ratingCount, undefined);
  assert.equal(other.identity, undefined);
  assert.ok(!String(other.id).startsWith('ol_'), 'no Open Library id carried over from the old slot');
  // prepending a new pick shifts every other book by one slot: none may take its neighbour's data
  const shifted = { ...sci, seeds: [['Brand New', 'Someone'], ...sci.seeds] as CuratedShelf['seeds'] };
  const ph = seedPlaceholders(shifted);
  assert.ok(ph.slice(1).every(b => !b.coverId && !b.coverUrl), 'shifted slots hold nobody else\'s cover');
  assert.deepEqual(prefetchedFor('scifi', 0, t0, a0), (prefetchedFor('scifi', 0, t0, a0)), 'stable');
  assert.deepEqual(prefetchedFor('scifi', 0, 'Not That Book', a0), {});
  assert.deepEqual(prefetchedFor('no-such-shelf', 0, 'x', 'y'), {});
});

test('every bundled shelf still shows its prefetched covers (the guard did not throw them all away)', () => {
  let withCover = 0, total = 0;
  for (const sh of CURATED_SHELVES) {
    const ph = seedPlaceholders(sh);
    total += ph.length;
    withCover += ph.filter(b => b.coverId || b.coverUrl).length;
  }
  assert.ok(withCover >= 150, `${withCover} of ${total} bundled books have a cover without any network`);
});
