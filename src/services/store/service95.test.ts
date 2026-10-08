// Tests the Service95 official-page reader (functions/api/service95.js) and the shelf that uses it.
//
// FIXTURES: the slugs, months, titles and authors below are the ones service95.com/book-club and /books/martyr showed when they were
// read on 7 Oct 2026. The page was read as extracted text, not raw HTML, so the markup here is a faithful-but-inferred
// reconstruction of that structure. `npm run check:service95` runs the real function against the live site to confirm it.
import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore plain JS module with no type declarations
import { onRequestGet, parseBookClub, parseBookPage } from '../../../functions/api/service95.js';
import { DYNAMIC_SPECS, dynamicCuratedSource, refreshShelf } from './dynamic';
import { CURATED_SHELVES } from '../../data/storeCatalog';
import { routeFetch } from './testkit';

const item = (slug: string, heading: string, alt = heading) =>
  `<div class="swiper-slide"><a href="https://www.service95.com/books/${slug}" title="View book"><img alt="${alt}" src="https://www.service95.com/_next/image?url=x&amp;w=3840&amp;q=75"></a><h3>${heading}</h3></div>`;

const CLUB_PAGE = `<html><head><title>Book Club | Service95</title></head><body>
<h1><a href="https://www.service95.com/book-club">Service95 Book Club</a></h1>
<h2><a href="https://www.service95.com/books/klara-and-the-sun-2" title="Dua’s Monthly Read for October: Klara And The Sun by Kazuo Ishiguro">Dua’s Monthly Read for October: Klara And The Sun by Kazuo Ishiguro</a></h2>
<p>“I first read Klara And The Sun when it was published in 2021...”</p>
<a href="https://www.service95.com/books/klara-and-the-sun-2" title="Explore Dua’s Monthly Read">Explore Dua’s Monthly Read</a>
<h2>Previous Monthly Reads</h2>
${item('klara-and-the-sun-2', '2026 October', "Dua Lipa with October's Monthly Read - Klara &amp; The Sun")}
${item('martyr', '2026 September', '2026 September')}
${item('lost-lambs-madeline-cash', '2026 August')}
${item('free-lea-ypi', '2026 July')}
${item('having-spent-life-seeking-kae-tempest', '2026 June')}
${item('so-late-in-the-day', '2026 May')}
${item('jerusalem-2', '2026 April')}
${item('bad-feminist-2', '2026 March')}
${item('there-there', '2025 March')}
${item('drive-your-plow-through-the-bones-of-the-dead', '2025 January')}
${item('on-earth-we-are-briefly-gorgeous-2', '2024 November')}
${item('lincoln-in-the-bardo', '2024 October')}
${item('bad-habit-2', '2024 September')}
${item('noughts-and-crosses-2', '2024 July')}
</body></html>`;

const bookPage = (title: string, author: string, pageTitle = `Dua’s Monthly Read: ${title} by ${author}`) =>
  `<html><head><title>${pageTitle}</title><meta property="og:title" content="${pageTitle}"/></head><body><h1><a href="/x">${title}</a></h1><p>By ${author}</p><p><b>Dua’s Monthly Read for September 2026</b></p></body></html>`;

const BOOKS: Record<string, [string, string, string?]> = {
  'klara-and-the-sun-2': ['Klara And The Sun', 'Kazuo Ishiguro', 'Dua’s Monthly Read for October: Klara And The Sun by Kazuo Ishiguro'],
  martyr: ['Martyr!', 'Kaveh Akbar'],
  'lost-lambs-madeline-cash': ['Lost Lambs', 'Madeline Cash'],
  'free-lea-ypi': ['Free', 'Lea Ypi'],
  'having-spent-life-seeking-kae-tempest': ['Having Spent Life Seeking', 'Kae Tempest', 'Dua’s Monthly Read for June - Having Spent Life Seeking by Kae Tempest'],
  'so-late-in-the-day': ['So Late In The Day', 'Claire Keegan'],
  'jerusalem-2': ['Jerusalem', 'Jez Butterworth'],
  'bad-feminist-2': ['Bad Feminist', 'Roxane Gay'],
  'there-there': ['There There', 'Tommy Orange'],
  'drive-your-plow-through-the-bones-of-the-dead': ['Drive Your Plow Over the Bones of the Dead', 'Olga Tokarczuk'],
  'on-earth-we-are-briefly-gorgeous-2': ['On Earth We’re Briefly Gorgeous', 'Ocean Vuong'],
  'lincoln-in-the-bardo': ['Lincoln in the Bardo', 'George Saunders'],
};

function scriptedSite(over: Record<string, (() => Response) | undefined> = {}) {
  const seen: string[] = [];
  (globalThis as any).fetch = async (url: any) => {
    const u = String(url);
    seen.push(u);
    const slug = u.match(/\/books\/([a-z0-9-]+)$/)?.[1];
    const o = over[slug ?? 'club'];
    if (o) return o();
    if (u.endsWith('/book-club')) return new Response(CLUB_PAGE, { status: 200 });
    if (slug && BOOKS[slug]) return new Response(bookPage(...BOOKS[slug]), { status: 200 });
    return new Response('nope', { status: 404 });
  };
  return seen;
}

test('parseBookClub: the Monthly Reads newest first, the featured link skipped, repeats dropped', () => {
  const found = parseBookClub(CLUB_PAGE);
  assert.equal(found.length, 14);
  assert.deepEqual(found.slice(0, 3), [
    { slug: 'klara-and-the-sun-2', year: 2026, month: 10 },
    { slug: 'martyr', year: 2026, month: 9 },
    { slug: 'lost-lambs-madeline-cash', year: 2026, month: 8 },
  ]);
  assert.equal(found.filter(f => f.slug === 'klara-and-the-sun-2').length, 1);
  // a month nobody picked (Aug 2024 is missing on the real page) is simply absent
  assert.ok(!found.some(f => f.year === 2024 && f.month === 8));
  // and a page with no such list yields nothing rather than guesses
  assert.deepEqual(parseBookClub('<html><body><a href="/books/x">x</a> some text</body></html>'), []);
});

test('parseBookClub: a link with no month heading after it never borrows the next link\'s heading', () => {
  const html = `<a href="https://www.service95.com/books/featured">Featured</a><p>words</p>${item('real-one', '2026 May')}`;
  assert.deepEqual(parseBookClub(html), [{ slug: 'real-one', year: 2026, month: 5 }]);
});

test('parseBookPage: the page heading and "By" line; falls back to the title, whatever its wording', () => {
  assert.deepEqual(parseBookPage(bookPage('Martyr!', 'Kaveh Akbar')), { title: 'Martyr!', author: 'Kaveh Akbar' });
  assert.deepEqual(parseBookPage(bookPage('Having Spent Life Seeking', 'Kae Tempest', 'Dua’s Monthly Read for June - Having Spent Life Seeking by Kae Tempest')), { title: 'Having Spent Life Seeking', author: 'Kae Tempest' });
  // no heading: title only (three real wordings seen on the site)
  const titleOnly = (t: string) => parseBookPage(`<html><head><title>${t}</title></head><body></body></html>`);
  assert.deepEqual(titleOnly('Dua’s Monthly Read: Martyr! by Kaveh Akbar'), { title: 'Martyr!', author: 'Kaveh Akbar' });
  assert.deepEqual(titleOnly('Dua’s Monthly Read for October: Klara And The Sun by Kazuo Ishiguro'), { title: 'Klara And The Sun', author: 'Kazuo Ishiguro' });
  assert.deepEqual(titleOnly('Dua’s Monthly Read for June - Having Spent Life Seeking by Kae Tempest'), { title: 'Having Spent Life Seeking', author: 'Kae Tempest' });
  assert.deepEqual(titleOnly('Dua’s Monthly Read: Standing by the Door by Ann Author'), { title: 'Standing by the Door', author: 'Ann Author' }); // "by" inside a title: the LAST one splits
  // entities, and nothing usable
  assert.equal(parseBookPage('<h1>On Earth We&#x27;re Briefly Gorgeous</h1><p>By Ocean Vuong</p>')?.title, "On Earth We're Briefly Gorgeous");
  assert.equal(parseBookPage('<html><head><title>Service95</title></head></html>'), null);
  assert.equal(parseBookPage('<h1>Only a title</h1><p>no author line</p>'), null);
});

test('function: answers the newest 12 Monthly Reads with title, author, month, and caches a good answer', async () => {
  const seen = scriptedSite();
  const res = await onRequestGet();
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') || '', /max-age=3600/);
  const body = await res.json();
  assert.equal(body.books.length, 12);
  assert.deepEqual(body.books[0], { title: 'Klara And The Sun', author: 'Kazuo Ishiguro', when: 'Oct 2026', url: 'https://www.service95.com/books/klara-and-the-sun-2' });
  assert.deepEqual(body.books[1], { title: 'Martyr!', author: 'Kaveh Akbar', when: 'Sep 2026', url: 'https://www.service95.com/books/martyr' });
  assert.equal(seen.length, 13); // the club page + one page per book, nothing else
  assert.ok(seen.every(u => u.startsWith('https://www.service95.com/')));
});

test('function: one broken book page drops only that book; a changed layout or an outage is a 502 that is never cached', async () => {
  scriptedSite({ martyr: () => new Response('boom', { status: 500 }) });
  const some = await (await onRequestGet()).json();
  assert.equal(some.books.length, 11);
  assert.ok(!some.books.some((b: any) => b.title === 'Martyr!'));

  scriptedSite({ club: () => new Response('<html><body>redesigned</body></html>', { status: 200 }) });
  const changed = await onRequestGet();
  assert.equal(changed.status, 502);
  assert.equal(changed.headers.get('cache-control'), 'no-store');
  assert.equal((await changed.json()).error, 'layout_changed');

  scriptedSite({ club: () => new Response('down', { status: 503 }) });
  assert.equal((await onRequestGet()).status, 502);

  (globalThis as any).fetch = async () => { throw new Error('network'); };
  assert.equal((await onRequestGet()).status, 502);
});

/* ------------------------------ the shelf ------------------------------ */

const shelf = CURATED_SHELVES.find(s => s.id === 'service95')!;
const good = { books: Object.values(BOOKS).slice(0, 10).map(([title, author], i) => ({ title, author, when: `${['Oct', 'Sep', 'Aug', 'Jul', 'Jun', 'May', 'Apr', 'Mar', 'Feb', 'Jan'][i]} 2026` })) };
const api = (body: unknown, status = 200) => [(u: URL) => (u.pathname === '/api/service95' ? { status, body } : undefined)];

test('Service95 shelf: the official page is used first, marked official, and labelled by month', async () => {
  routeFetch(api(good));
  const next = await refreshShelf(shelf, DYNAMIC_SPECS.service95, Date.now() + 1);
  assert.ok(next);
  assert.deepEqual(next!.seeds[0], ['Klara And The Sun', 'Kazuo Ishiguro', 'Service95 Monthly Read · Oct 2026']);
  assert.equal(next!.official, true);
  const info = dynamicCuratedSource(shelf, DYNAMIC_SPECS.service95).info?.();
  assert.equal(info?.kind, 'official');
  assert.match(info?.source || '', /official/);
  assert.equal(info?.schedule, 'Refreshes weekly');
});

test('Service95 shelf: when the official page cannot be read it falls back to Wikipedia, and says so', async () => {
  // function answers 502; Wikipedia gives nothing either in this scripted network -> nothing changes, the saved list stays
  routeFetch(api({ error: 'layout_changed' }, 502));
  const before = dynamicCuratedSource(shelf, DYNAMIC_SPECS.service95).cached()?.map(b => b.title);
  const next = await refreshShelf(shelf, DYNAMIC_SPECS.service95, Date.now() + 2);
  assert.equal(next, null);
  assert.deepEqual(dynamicCuratedSource(shelf, DYNAMIC_SPECS.service95).cached()?.map(b => b.title), before);
});

test('Service95 shelf: an official answer with too few books is not accepted', async () => {
  routeFetch(api({ books: good.books.slice(0, 3) }));
  assert.equal(await refreshShelf(shelf, DYNAMIC_SPECS.service95, Date.now() + 3), null);
});

test('Service95 info: a list saved before the official page was used (no flag) is not called official', async () => {
  const sh = { ...shelf, id: 'service95-legacy' };
  routeFetch(api({ error: 'x' }, 502));
  // saved by an older version / by the Wikipedia stand-in: no `official` flag
  await refreshShelf(sh, { ...DYNAMIC_SPECS.service95, fetch: async () => ({ seeds: good.books.map(b => [b.title, b.author, `Service95 Monthly Read · ${b.when}`] as [string, string, string]) }) }, Date.now() + 5);
  const info = dynamicCuratedSource(sh, DYNAMIC_SPECS.service95).info?.();
  assert.equal(info?.kind, 'fallback');
  assert.match(info?.source || '', /Wikipedia.*not the official list/);
  // and nothing saved yet: it is simply described as the official shelf it is
  assert.equal(dynamicCuratedSource({ ...shelf, id: 'service95-new' }, DYNAMIC_SPECS.service95).info?.().kind, 'official');
});
