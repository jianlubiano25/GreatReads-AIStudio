import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS module with no type declarations
import { onRequestGet as oprahFn, parseOprahList } from '../../../functions/api/oprah.js';
import { DYNAMIC_SPECS, oprahNewest, refreshShelf } from './dynamic';
import { routeFetch } from './testkit';
import { CURATED_SHELVES } from '../../data/storeCatalog';

/* NOTE: the page itself could not be read when this was written (it blocks automated readers). These fixtures follow the entry
   format outlets quote from it ("112. “Title,” Author", newest first) and were written for the tests. `npm run check:oprah`
   shows what the real page gives. */

const entries = (n: number, from = 120) => Array.from({ length: n }, (_, i) => `<h2 class="slide">${from - i}. “Title ${from - i},” Author ${from - i}</h2>`).join('<p>blurb</p>');

test('parseOprahList reads numbered "“Title,” Author" entries, newest first, whatever tags wrap them', () => {
  const html = `<div>${entries(3)}</div><h2><span>117.</span> <em>“Hidden Valley Road: Inside the Mind of an American Family,”</em> Robert Kolker</h2><h2>116. "A New Earth: Awakening to Your Life&#8217;s Purpose," Eckhart Tolle</h2><script>var x = "5. “Not a pick,” Nobody";</script>`;
  const out = parseOprahList(html);
  assert.deepEqual(out.map((p: any) => p.n), [120, 119, 118, 117, 116]);
  assert.deepEqual([out[0].title, out[0].author], ['Title 120', 'Author 120']);
  assert.deepEqual([out[3].title, out[3].author], ['Hidden Valley Road: Inside the Mind of an American Family', 'Robert Kolker']);
  assert.equal(out[4].title, 'A New Earth: Awakening to Your Life’s Purpose');
  assert.deepEqual(parseOprahList('<p>No list here</p>'), []);
});

test('/api/oprah: answers the picks, and an unreadable page is an error that is never cached', async () => {
  (globalThis as any).fetch = async () => new Response(`<html>${entries(12)}</html>`, { status: 200 });
  const ok = await oprahFn();
  assert.equal(ok.status, 200);
  const body = await ok.json();
  assert.equal(body.picks.length, 12);
  assert.equal(body.picks[0].n, 120);

  (globalThis as any).fetch = async () => new Response('<html>a redesigned page</html>', { status: 200 });
  const changed = await oprahFn();
  assert.equal(changed.status, 502);
  assert.equal(changed.headers.get('cache-control'), 'no-store');

  (globalThis as any).fetch = async () => new Response('blocked', { status: 403 });
  assert.equal((await oprahFn()).status, 502);
  (globalThis as any).fetch = async () => { throw new Error('down'); };
  assert.equal((await oprahFn()).status, 502);
});

test('oprahNewest: only the picks above what Wikipedia already lists, undated; nothing when titles are not comparable', () => {
  const known: [string, string, string][] = [['Hello Beautiful', 'Ann Napolitano', "Oprah's Book Club · Mar 2023"], ['Bittersweet', 'Susan Cain', "Oprah's Book Club · Apr 2022"]];
  const official = [{ title: 'Brand New', author: 'N A' }, { title: 'Newer Still', author: 'N B' }, { title: 'Hello Beautiful: A Novel', author: 'Ann Napolitano' }, { title: 'Bittersweet', author: 'Susan Cain' }];
  assert.deepEqual(oprahNewest(official, known), [['Brand New', 'N A', "Oprah's Book Club"], ['Newer Still', 'N B', "Oprah's Book Club"]]);
  assert.deepEqual(oprahNewest(official.slice(2), known), []); // nothing newer
  const unrelated = Array.from({ length: 10 }, (_, i) => ({ title: `Other ${i}`, author: 'X Y' }));
  assert.deepEqual(oprahNewest(unrelated, known), []); // none of them match: not comparable, add nothing
});

const wikitext = (rows: [string, string, string][]) => `{| class="wikitable"
! Date !! Title !! Author
|-
${rows.map(([d, t, a]) => `| ${d} || ''[[${t}]]'' || [[${a}]]`).join('\n|-\n')}
|}`;
const wikiRows: [string, string, string][] = Array.from({ length: 10 }, (_, i) => [`June ${i + 1}, 20${10 + i}`, `Wiki Book ${i}`, `Wiki Author ${i}`]);

test('Oprah shelf: Oprah Daily\'s newer picks go on top, undated; Wikipedia keeps the dates; the fallback is used when Oprah Daily cannot be read', async () => {
  const base = CURATED_SHELVES.find(s => s.id === 'oprah')!;
  const picks = [{ n: 112, title: 'Brand New Pick', author: 'New Author' }, { n: 111, title: 'Wiki Book 9', author: 'Wiki Author 9' }, { n: 110, title: 'Wiki Book 8', author: 'Wiki Author 8' }];
  routeFetch([
    u => (u.pathname === '/api/oprah' ? { body: { picks } } : undefined),
    u => (u.hostname === 'en.wikipedia.org' ? { body: { parse: { wikitext: wikitext(wikiRows) } } } : undefined),
  ]);
  const got = await refreshShelf({ ...base, id: 't-oprah' }, DYNAMIC_SPECS.oprah);
  assert.deepEqual(got?.seeds[0], ['Brand New Pick', 'New Author', "Oprah's Book Club"]);
  assert.equal(got?.seeds[1][2], "Oprah's Book Club · Jun 2019"); // Wikipedia's own date, newest first
  assert.equal(got?.official, true);

  // Oprah Daily down: Wikipedia alone, and the shelf says it was not the official list
  routeFetch([
    u => (u.pathname === '/api/oprah' ? { status: 502, body: { error: 'layout_changed' } } : undefined),
    u => (u.hostname === 'en.wikipedia.org' ? { body: { parse: { wikitext: wikitext(wikiRows) } } } : undefined),
  ]);
  const fb = await refreshShelf({ ...base, id: 't-oprah-fb' }, DYNAMIC_SPECS.oprah);
  assert.equal(fb?.seeds[0][0], 'Wiki Book 9');
  assert.equal(fb?.official, false);

  // Wikipedia down: nothing is added (undated picks alone would wipe the dated labels)
  routeFetch([u => (u.pathname === '/api/oprah' ? { body: { picks } } : undefined)]);
  assert.equal(await refreshShelf({ ...base, id: 't-oprah-nowiki' }, DYNAMIC_SPECS.oprah), null);
});

test('Oprah shelf: a double pick becomes two books, so each finds its own cover', async () => {
  const base = CURATED_SHELVES.find(s => s.id === 'oprah')!;
  const rows: [string, string, string][] = [...wikiRows, ['June 7, 2010', 'Great Expectations, A Tale of Two Cities', 'Charles Dickens']];
  routeFetch([u => (u.hostname === 'en.wikipedia.org' ? { body: { parse: { wikitext: wikitext(rows) } } } : undefined)]);
  const got = await refreshShelf({ ...base, id: 't-oprah-pair' }, DYNAMIC_SPECS.oprah);
  const titles = got!.seeds.map(s => s[0]);
  assert.ok(titles.includes('Great Expectations') && titles.includes('A Tale of Two Cities'));
  assert.ok(!titles.some(t => /Great Expectations,/.test(t)));
});
