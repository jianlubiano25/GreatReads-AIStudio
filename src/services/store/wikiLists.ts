import { getJson } from '../books/http';
import { authorKey, titleKey } from '../books/identity';

/**
 * Reads "who/what was picked" out of a Wikipedia list article. Used for shelves that have no API of their own (Oprah's Book
 * Club, the Women's Prize, the International Booker): the article's tables are the public record that people keep up to date.
 *
 * Nothing here knows a page's exact layout. Columns are found by their HEADER NAMES (title / author / date...), `rowspan` is
 * expanded, and a page that does not yield enough picks is simply reported as "no result" so the shelf keeps its saved list.
 */

export interface WikiPick {
  title: string;
  author: string;
  /** "Mar 2026" or "2026": how the pick is dated on the page ('' when it has no date column) */
  when: string;
  /** Sortable: year * 12 + month (0 when undated) */
  at: number;
  year: number;
}

export interface ColumnRule {
  title: RegExp;
  author: RegExp;
  /** The column that dates a pick. Required: without dates there is no telling which picks are the newest. */
  when: RegExp;
  /** A column that says winner / shortlisted etc. Rows that do not match `winner` are dropped (when such a column exists). */
  result?: RegExp;
  winner?: RegExp;
  /** Keep only the first row of each year (prize tables list the winner first). */
  onePerYear?: boolean;
  /** Tables with fewer data rows than this are ignored (navigation boxes, small side tables). */
  minRows?: number;
}

/* ------------------------------ wikitext -> text ------------------------------ */

const TEMPLATE_LAST = new Set(['nowrap', 'nobr', 'small', 'big', 'lang', 'sort', 'sortname-last', 'abbr', 'tooltip']);

function templateText(tpl: string): string {
  const parts = tpl.slice(2, -2).split('|').map(p => p.trim());
  const name = (parts[0] || '').toLowerCase();
  if (name === 'sortname') {
    // {{sortname|Yael|van der Wouden}} and {{sortname|first=Yael|last=van der Wouden|nolink=1}}: named values win, the rest are in order
    const named: Record<string, string> = {};
    const plain: string[] = [];
    for (const p of parts.slice(1)) { const m = p.match(/^([a-z]+)\s*=\s*(.*)$/i); if (m) named[m[1].toLowerCase()] = m[2].trim(); else plain.push(p); }
    return `${named.first ?? plain[0] ?? ''} ${named.last ?? plain[1] ?? ''}`.trim();
  }
  if (name === 'dts') return [parts[1], parts[2], parts[3]].filter(Boolean).join(' ');
  if (TEMPLATE_LAST.has(name)) return parts[parts.length - 1] || '';
  return ''; // citations, footnotes, flags, notes...
}

const MONTH_NUM: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Wikitext cell -> plain text: links, italics, citations, templates and HTML removed. */
export function cleanWiki(raw: string): string {
  let s = raw.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<ref[^>]*\/>/gi, '').replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '');
  for (let i = 0; i < 5 && /\{\{[^{}]*\}\}/.test(s); i++) s = s.replace(/\{\{[^{}]*\}\}/g, templateText);
  s = s.replace(/<br\s*\/?>/gi, ', ').replace(/<\/?[a-z][^>]*>/gi, '');
  s = s.replace(/\[\[(?:File|Image|Category):[^\]]*\]\]/gi, '');
  s = s.replace(/\[\[([^\]|]*)\|([^\]]*)\]\]/g, '$2').replace(/\[\[([^\]]*)\]\]/g, '$1');
  s = s.replace(/\[https?:\/\/[^\s\]]+\s*([^\]]*)\]/g, '$1').replace(/'{2,}/g, '');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&ndash;|&mdash;/g, '–');
  s = s.replace(/\[\d+\]|\[[a-z]\]/g, '').replace(/[†‡*]+\s*$/g, '');
  return s.replace(/\s+/g, ' ').replace(/\s+,/g, ',').replace(/^[,\s]+|[,\s]+$/g, '').trim();
}

/* ------------------------------ tables ------------------------------ */

export interface WikiTable {
  headers: string[];
  rows: string[][];
}

interface RawCell { text: string; header: boolean; rowspan: number; colspan: number }

const ATTRS = /^\s*(?:[a-z-]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"']+)\s*)+$/i;

/** Splits on a separator that is not inside [[links]] or {{templates}}. */
function splitOutside(line: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const two = line.slice(i, i + 2);
    if (two === '[[' || two === '{{') { depth++; cur += two; i++; continue; }
    if (two === ']]' || two === '}}') { depth = Math.max(0, depth - 1); cur += two; i++; continue; }
    if (depth === 0 && line.startsWith(sep, i)) { out.push(cur); cur = ''; i += sep.length - 1; continue; }
    cur += line[i];
  }
  out.push(cur);
  return out;
}

function parseCell(piece: string, header: boolean): RawCell {
  let text = piece;
  let attrs = '';
  const parts = splitOutside(piece, '|');
  if (parts.length > 1 && ATTRS.test(parts[0])) { attrs = parts[0]; text = parts.slice(1).join('|'); }
  const num = (name: string) => Number(attrs.match(new RegExp(`${name}\\s*=\\s*"?(\\d+)`, 'i'))?.[1]) || 1;
  return { text, header, rowspan: num('rowspan'), colspan: num('colspan') };
}

/** Every wikitable in the page, with rowspans/colspans expanded so each row has one entry per column. */
export function parseWikiTables(wikitext: string): WikiTable[] {
  const tables: WikiTable[] = [];
  const lines = wikitext.replace(/\r/g, '').split('\n');
  let depth = 0;
  let rows: RawCell[][] = [];
  let row: RawCell[] = [];
  let last: RawCell | null = null;

  const endRow = () => { if (row.length) rows.push(row); row = []; last = null; };
  const endTable = () => {
    endRow();
    const carry = new Map<number, { text: string; left: number }>();
    const grid: { cells: string[]; allHeader: boolean }[] = rows.map(r => {
      const cells: string[] = [];
      let raw = 0;
      let col = 0;
      while (raw < r.length || carry.has(col)) {
        const c = carry.get(col);
        if (c && c.left > 0) {
          cells.push(c.text);
          c.left--;
          if (c.left === 0) carry.delete(col);
          col++;
          continue;
        }
        if (raw >= r.length) break;
        const cell = r[raw++];
        const text = cleanWiki(cell.text);
        for (let k = 0; k < cell.colspan; k++) {
          cells.push(text);
          if (cell.rowspan > 1) carry.set(col, { text, left: cell.rowspan - 1 });
          col++;
        }
      }
      return { cells, allHeader: r.length > 0 && r.every(c => c.header) };
    });
    const headerAt = grid.findIndex(g => g.allHeader);
    if (headerAt >= 0) tables.push({ headers: grid[headerAt].cells, rows: grid.filter((_, i) => i !== headerAt).map(g => g.cells) });
    rows = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const t = line.trimStart();
    if (t.startsWith('{|')) { if (depth++ === 0) { rows = []; row = []; last = null; } continue; }
    if (depth === 0) continue;
    if (t.startsWith('|}')) { if (--depth === 0) endTable(); continue; }
    if (depth > 1) continue; // a table inside a cell: not ours
    if (t.startsWith('|+')) continue; // caption
    if (t.startsWith('|-')) { endRow(); continue; }
    if (t.startsWith('!') || t.startsWith('|')) {
      const header = t.startsWith('!');
      const pieces = splitOutside(t.slice(1), header ? '!!' : '||').flatMap(p => (header ? splitOutside(p, '||') : [p]));
      for (const p of pieces) { last = parseCell(p, header); row.push(last); }
      continue;
    }
    if (last) last.text += ` ${t}`; // a cell that continues on the next line
  }
  return tables;
}

/* ------------------------------ picks ------------------------------ */

/** "March 17, 2026", "17 March 2026", "Mar 2026", "2026-03-17", "2026 03 17" or "2026" -> sortable value + a short label. */
export function parseWhen(text: string): { at: number; year: number; label: string } | null {
  const year = Number(text.match(/\b(19|20)\d{2}\b/)?.[0]);
  if (!year) return null;
  const mon = text.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?(?=\W|$)/i)?.[1]?.toLowerCase();
  // numeric dates: 2026-03-17, 2026/03, and {{dts}} output "2026 03 17"
  const numeric = Number(text.match(new RegExp(`\\b${year}[-/. ](0?[1-9]|1[0-2])\\b`))?.[1]);
  const m = mon ? MONTH_NUM[mon] : numeric || 0;
  return { at: year * 12 + (m ? m - 1 : 0), year, label: m ? `${MONTH_SHORT[m - 1]} ${year}` : String(year) };
}

/**
 * "The Vegetarian 채식주의자" -> "The Vegetarian". Wikipedia's prize tables add the original-language title after the English one;
 * a trailing run of words in another script is dropped (a Latin-script original title cannot be told apart, and is kept).
 */
export function stripNativeTitle(title: string): string {
  const t = title.replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
  const out = t.replace(/\s+[^\u0000-\u024f\u1e00-\u1eff\u2000-\u206f]+(?:\s+[^\u0000-\u024f\u1e00-\u1eff\u2000-\u206f]+)*\s*$/, '').replace(/[,;\s]+$/, '').trim(); // a <br> between the two titles leaves a comma behind
  return out || t;
}

const INVISIBLE = /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/g;

/**
 * An author as a book lookup needs it: just the name(s). Wikipedia cells carry extras that make a cover search fail
 * ("Madeline Miller (US)", "Name†", "Name[a]", "Name, American novelist", "Author A<br>Author B", a trailing original-script name).
 * Several authors become "A & B" (the form the resolver and the library already understand).
 */
export function cleanAuthorName(raw: string): string {
  let s = stripNativeTitle(String(raw ?? '').normalize('NFC').replace(INVISIBLE, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' '));
  s = s.replace(/\[[^\]]*\]/g, ' ').replace(/\([^)]*\)/g, ' ').replace(/[†‡§¶*#^↑]+/g, ' ');
  s = s.replace(/\s*[–—-]\s*(?:translated|trans\.?|tr\.)\b.*$/i, '').replace(/\s+(?:translated|trans\.?|tr\.)\s+by\b.*$/i, '');
  s = s.replace(/,\s*(?:an?\s+)?(?:[A-Z][a-z]+(?:-[A-Z][a-z]+)?\s+){0,2}(?:novelist|writer|author|poet|playwright|journalist)\b.*$/i, '');
  s = s.replace(/\s+/g, ' ').replace(/^[\s,;:&.-]+|[\s,;:&.-]+$/g, '').trim();
  const parts = s.split(/\s*,\s*/).filter(Boolean);
  const suffix = /^(jr|sr|ii|iii|iv)\.?$/i;
  const oneWordEach = parts.length === 2 && parts.every(p => !/\s/.test(p)); // "King, Lily" is Last, First, not two authors
  if (parts.length > 1 && !oneWordEach) {
    const kept = parts.filter(p => !suffix.test(p));
    s = kept.join(' & ');
  }
  return s.replace(/\s+/g, ' ').slice(0, 120).trim();
}

/** A title without footnote marks, [notes] or invisible marks. */
export function cleanTitle(raw: string): string {
  const s = String(raw ?? '').normalize('NFC').replace(INVISIBLE, ' ').replace(/<!--[\s\S]*?-->/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/[†‡§¶*#^↑]+\s*$/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

const NO_PICK = /^(?:—|–|-|n\/a|tba|tbd|none|no award|not awarded|no prize|unknown|\?)$/i;

/** The newest picks first. Returns null unless the page gave dated picks in useful numbers (so a layout change cannot reorder the shelf wrongly). */
export function picksFromTables(tables: WikiTable[], rule: ColumnRule, minPicks = 5): WikiPick[] | null {
  const picks: WikiPick[] = [];
  for (const t of tables) {
    const find = (re: RegExp) => t.headers.findIndex(h => re.test(h.trim()));
    const iTitle = find(rule.title);
    const iAuthor = find(rule.author);
    const iWhen = find(rule.when);
    const iResult = rule.result ? find(rule.result) : -1;
    if (iTitle < 0 || iAuthor < 0 || iWhen < 0 || iTitle === iAuthor || t.rows.length < (rule.minRows ?? 5)) continue;
    const seenYear = new Set<number>();
    for (const r of t.rows) {
      const title = cleanTitle(stripNativeTitle((r[iTitle] || '').trim()));
      const author = cleanAuthorName((r[iAuthor] || '').trim());
      const when = parseWhen(r[iWhen] || '');
      if (!title || !author || !when || NO_PICK.test(title) || NO_PICK.test(author)) continue;
      if (iResult >= 0 && rule.winner && !rule.winner.test(r[iResult] || '')) continue;
      if (rule.onePerYear) {
        if (seenYear.has(when.year)) continue;
        seenYear.add(when.year);
      }
      picks.push({ title, author, when: when.label, at: when.at, year: when.year });
    }
  }
  if (picks.length < minPicks) return null;
  // newest first; the same book listed twice (e.g. in two tables) counts once
  const seen = new Set<string>();
  return picks
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.at - a.p.at || b.i - a.i)
    .map(x => x.p)
    .filter(p => {
      const k = `${titleKey(p.title)}|${authorKey(p.author)}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
}

/* ------------------------------ fetching ------------------------------ */

const API = 'https://en.wikipedia.org/w/api.php';

/** The page's wikitext, or null. `origin=*` is what lets a browser read the answer; no key or account needed. */
export async function fetchWikitext(page: string, signal?: AbortSignal): Promise<string | null> {
  const q = new URLSearchParams({ action: 'parse', page, prop: 'wikitext', format: 'json', formatversion: '2', redirects: '1', origin: '*' });
  const data = await getJson(`${API}?${q}`, { timeout: 15000, retries: 1, signal });
  const w = data?.parse?.wikitext;
  const text = typeof w === 'string' ? w : typeof w?.['*'] === 'string' ? w['*'] : null;
  return text || null;
}

/**
 * Read every candidate page and combine what each one gives (newest first, repeats once). One page may be stale or missing a
 * table that another has, so the first page that answers does not get to hide the others. A page that fails is skipped.
 * Null unless the combined result is large enough to trust.
 */
export async function fetchWikiPicks(pages: string[], rule: ColumnRule, signal?: AbortSignal): Promise<WikiPick[] | null> {
  const all: WikiPick[] = [];
  for (const page of pages) {
    const text = await fetchWikitext(page, signal);
    if (!text) continue;
    all.push(...(picksFromTables(parseWikiTables(text), rule) ?? []));
  }
  return mergePicks(all);
}

/** Newest first; the same book from several tables or pages counts once (the first one listed keeps its date and label). */
export function mergePicks(picks: WikiPick[], minPicks = 5): WikiPick[] | null {
  if (picks.length < minPicks) return null;
  const seen = new Set<string>();
  return picks
    .map((p, i) => ({ p, i }))
    .sort((a, b) => b.p.at - a.p.at || a.i - b.i)
    .map(x => x.p)
    .filter(p => {
      const k = `${titleKey(p.title)}|${authorKey(p.author)}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
}

/**
 * Two books chosen at once come as one row ("Great Expectations, A Tale of Two Cities" / "A Tale of Two Cities and Great Expectations").
 * Looked up as one title nothing matches, and a loose match can show another book's cover. Split only when BOTH halves look like
 * titles of their own (two or more words, capitalised): "Pride and Prejudice" and "War and Peace" stay whole.
 */
export function splitPairedTitle(title: string): string[] {
  const m = title.match(/^(.+?)(?:\s*[,\/&]\s*|\s+and\s+)(.+)$/);
  if (!m) return [title];
  const [a, b] = [m[1].trim(), m[2].trim()];
  const looksLikeTitle = (t: string) => t.split(/\s+/).length >= 2 && /^[A-Z“"']/.test(t);
  return looksLikeTitle(a) && looksLikeTitle(b) ? [a, b] : [title];
}
