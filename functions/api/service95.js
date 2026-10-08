// Cloudflare Pages Function: GET /api/service95
// Dua Lipa's Service95 Book Club, read from the club's OWN page (https://www.service95.com/book-club) and its book pages, server-side
// (the browser cannot read another site's pages). No key needed.
//
//   book-club page : a carousel of every Monthly Read, newest first. Each item is a link to /books/<slug> followed by a
//                    "2026 October"-style heading. It carries no title or author.
//   book page      : the book's own heading, and a "By <author>" line under it (the page <title> is only a fallback: its wording
//                    changes from month to month).
//
// Answers { source, books: [{ title, author, when: "Oct 2026", url }] }, newest first, at most 12.
// Only SUCCESSFUL answers are cached: the book-club page for 12 hours, a book page for a week (a past month never changes). A page
// that cannot be read, or whose layout changed so that too few books can be found, answers 502 and is never cached: the app then
// keeps the list it already has (see DYNAMIC_SPECS.service95). Nothing here guesses a title or an author.

const BASE = 'https://www.service95.com';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const LIMIT = 12;
const MIN_BOOKS = 4;

const json = (body, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': cache } });

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026', ndash: '\u2013', mdash: '\u2014' };
const decode = s =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);
const text = html => decode(html.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

// <a href=".../books/<slug>">...</a> immediately followed by a "<year> <Month>" heading. The body of the link may not cross a </a>,
// so a link without a heading after it (the featured book at the top) is skipped instead of borrowing the next link's heading.
const ITEM = new RegExp(
  String.raw`<a\b[^>]*?href=["'](?:https?:\/\/(?:www\.)?service95\.com)?\/books\/([a-z0-9][a-z0-9-]*)\/?["'][^>]*>(?:(?!<\/a>)[\s\S])*<\/a>\s*(?:<[^>]{0,300}>\s*){0,3}(20\d\d)\s+(${MONTHS.join('|')})\b`,
  'gi',
);

/** The Monthly Reads on the book-club page: [{ slug, year, month (1-12) }], newest first, each book once. */
export function parseBookClub(html) {
  const seen = new Set();
  const out = [];
  for (const m of String(html).matchAll(ITEM)) {
    const slug = m[1].toLowerCase();
    if (seen.has(slug)) continue;
    seen.add(slug);
    out.push({ slug, year: Number(m[2]), month: MONTHS.findIndex(n => n.toLowerCase() === m[3].toLowerCase()) + 1 });
  }
  return out.sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month));
}

const sane = (s, max) => !!s && s.length <= max && !/[<>]|https?:/i.test(s);

/** One book page -> { title, author } or null. */
export function parseBookPage(html) {
  html = String(html);
  // 1. the page's own heading, then the "By <author>" line below it
  const h1 = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (h1) {
    const title = text(h1[1]);
    const after = html.slice((h1.index ?? 0) + h1[0].length, (h1.index ?? 0) + h1[0].length + 1500);
    const by = after.match(/>\s*By\s+([^<]{2,80}?)\s*</i);
    const author = by ? decode(by[1]).replace(/\s+/g, ' ').trim() : '';
    if (sane(title, 140) && sane(author, 90)) return { title, author };
  }
  // 2. the page title: "Dua's Monthly Read[ for October]: <Title> by <Author>" (the separator and wording vary, so be strict about the rest)
  const meta =
    html.match(/<meta[^>]*?(?:property|name)=["']og:title["'][^>]*?content=["']([^"']*)["']/i) ||
    html.match(/<meta[^>]*?content=["']([^"']*)["'][^>]*?(?:property|name)=["']og:title["']/i) ||
    html.match(/<title[^>]*>([^<]*)<\/title>/i);
  const t = meta ? decode(meta[1]).replace(/\s+/g, ' ').trim() : '';
  const m = t.match(/Monthly Read(?:\s+for\s+[A-Za-z]+(?:\s+\d{4})?)?\s*[:\-\u2013,]\s*(.+)\s+by\s+(.+)$/i);
  if (m && sane(m[1].trim(), 140) && sane(m[2].trim(), 90)) return { title: m[1].trim(), author: m[2].trim() };
  return null;
}

const get = async (url, ttl) => {
  const res = await fetch(url, {
    headers: { 'user-agent': 'GreatReads/1.0 (a reading app; reads the public Service95 Book Club list; github.com/jianlubiano25/GreatReads)', accept: 'text/html' },
    // Cache only 2xx at Cloudflare's edge. (cf.cacheTtl alone would cache EVERY status, including errors.)
    cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': ttl, '400-599': -1 } },
  });
  if (!res.ok) throw new Error(`service95 answered ${res.status}`);
  return res.text();
};

export async function onRequestGet() {
  let entries;
  try {
    entries = parseBookClub(await get(`${BASE}/book-club`, 12 * 3600)).slice(0, LIMIT);
  } catch {
    return json({ error: 'upstream_error' }, 502);
  }
  if (entries.length < MIN_BOOKS) return json({ error: 'layout_changed', found: entries.length }, 502);

  const pages = await Promise.all(
    entries.map(async e => {
      try {
        const book = parseBookPage(await get(`${BASE}/books/${e.slug}`, 7 * 24 * 3600));
        return book && { ...book, when: `${MONTHS[e.month - 1].slice(0, 3)} ${e.year}`, url: `${BASE}/books/${e.slug}` };
      } catch {
        return null; // one book page failing only drops that book
      }
    }),
  );
  const books = pages.filter(Boolean);
  if (books.length < Math.min(MIN_BOOKS, entries.length)) return json({ error: 'layout_changed', found: books.length }, 502);
  return json({ source: 'service95.com/book-club', books }, 200, 'public, max-age=3600');
}
