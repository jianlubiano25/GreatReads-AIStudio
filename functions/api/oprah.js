// Cloudflare Pages Function: GET /api/oprah
// Oprah's Book Club picks from Oprah Daily's own list page (the browser cannot read another site's pages):
//   https://www.oprahdaily.com/entertainment/books/g23067476/oprah-book-club-list/
// The page is a numbered gallery, newest pick first, each entry written as   112. “Title,” Author
// Answers { source, picks: [{ n, title, author }] } newest first (at most 30). The page carries no dates: the app takes the dates
// from Wikipedia and uses this list only to find picks Wikipedia does not have yet (see DYNAMIC_SPECS.oprah).
//
// NOT verified against the live page: the page blocks automated readers in the tool used to write this, so the parser follows the
// entry format quoted by outlets that republish the list. Anything that does not look like that is dropped, fewer than 8 entries
// is an error (502, never cached), and the shelf then simply keeps using Wikipedia. Run `npm run check:oprah` on a normal
// connection to see what the real page gives.
const PAGE = 'https://www.oprahdaily.com/entertainment/books/g23067476/oprah-book-club-list/';
const LIMIT = 30;
const MIN_PICKS = 8;

const json = (body, status = 200, cache = 'no-store') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': cache } });

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '\u2019', lsquo: '\u2018', ldquo: '\u201c', rdquo: '\u201d', hellip: '\u2026', ndash: '\u2013', mdash: '\u2014' };
const decode = s =>
  String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED[n.toLowerCase()] ?? m);

// "112. “Title,” Author": the number, the title in quotes (the comma may sit inside the quotes), then the author
const ENTRY = /^(\d{1,3})\s*[.)]\s*[\u201c"]\s*(.+?)\s*,?\s*[\u201d"]\s*,?\s*(?:by\s+)?(.+?)\s*$/;

/** The numbered entries in the page's HTML: [{ n, title, author }] newest (highest number) first. Tags only separate text pieces. */
export function parseOprahList(html) {
  const nodes = String(html)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, '\u0000')
    .replace(/<[^>]+>/g, '\u0000')
    .split('\u0000')
    .map(n => decode(n).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const byNumber = new Map();
  for (let i = 0; i < nodes.length; i++) {
    // An entry may be split over several tags (the number, the title, the author): join up to three pieces until it reads as one
    if (!/^\d{1,3}\s*[.)]/.test(nodes[i])) continue;
    let text = nodes[i];
    let m = text.match(ENTRY);
    for (let k = 1; !m && k <= 2 && nodes[i + k] !== undefined; k++) {
      text = `${text} ${nodes[i + k]}`;
      m = text.match(ENTRY);
      if (m) i += k;
    }
    if (!m) continue;
    const n = Number(m[1]);
    const title = m[2].replace(/\s+/g, ' ').trim();
    const author = m[3].replace(/\s+/g, ' ').replace(/[.,;]+$/, '').trim();
    if (!n || n > 400 || title.length < 1 || title.length > 140 || author.length < 3 || author.length > 90 || /[<>]|https?:/i.test(`${title}${author}`)) continue;
    if (!byNumber.has(n)) byNumber.set(n, { n, title, author });
  }
  return [...byNumber.values()].sort((a, b) => b.n - a.n);
}

export async function onRequestGet() {
  let html;
  try {
    const res = await fetch(PAGE, {
      headers: { 'user-agent': 'GreatReads/1.0 (a reading app; reads the public Oprah Daily book club list; github.com/jianlubiano25/GreatReads)', accept: 'text/html' },
      // Cache only 2xx at Cloudflare's edge (12 h). Errors are never cached.
      cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': 12 * 3600, '400-599': -1 } },
    });
    if (!res.ok) return json({ error: 'upstream_error', upstream: res.status }, 502);
    html = await res.text();
  } catch {
    return json({ error: 'upstream_error' }, 502);
  }
  const picks = parseOprahList(html).slice(0, LIMIT);
  if (picks.length < MIN_PICKS) return json({ error: 'layout_changed', found: picks.length }, 502);
  return json({ source: 'oprahdaily.com', picks }, 200, 'public, max-age=3600');
}
