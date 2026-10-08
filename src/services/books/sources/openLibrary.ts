import { getJson } from '../http';
import { cleanIsbn, titlesMatch, authorListMatches, workIdFromKey } from '../identity';
import { genreFromSubjects, makeBook } from '../model';
import type { CallOpts, Hit } from './types';

const OL = 'https://openlibrary.org';
const FIELDS = 'key,title,author_name,author_key,first_publish_year,cover_i,cover_edition_key,ratings_average,ratings_count,number_of_pages_median,subject';

export interface OlDoc {
  key: string;
  title: string;
  author_name?: string[];
  first_publish_year?: number;
  cover_i?: number;
  cover_edition_key?: string;
  ratings_average?: number;
  ratings_count?: number;
  number_of_pages_median?: number;
  subject?: string[];
}

export type OlSize = 'S' | 'M' | 'L';
export const olCoverById = (id: number, size: OlSize = 'M') => `https://covers.openlibrary.org/b/id/${id}-${size}.jpg`;
/** Exact-edition cover. `default=false` makes a missing cover a 404 (so fallbacks kick in) instead of a blank 1x1 image. */
export const olCoverByIsbn = (isbn: string, size: OlSize = 'L') => `https://covers.openlibrary.org/b/isbn/${isbn}-${size}.jpg?default=false`;

/** Open Library search/trending doc -> Book. The id format ("ol_/works/OL1W" with non-word chars as "_") is saved in people's libraries: never change it. */
export function olDocToHit(doc: OlDoc, idx = 0, genreHint = ''): Hit {
  const author = doc.author_name?.[0] || 'Unknown Author';
  const pages = doc.number_of_pages_median || 0;
  const book = makeBook({
    id: `ol_${(doc.key || String(Date.now() + idx)).replace(/\W/g, '_')}`,
    title: doc.title,
    author,
    year: doc.first_publish_year ? String(doc.first_publish_year) : '',
    genre: genreHint || genreFromSubjects(doc.subject) || 'Book',
    pageCount: pages,
    coverId: doc.cover_i,
    ratingAverage: doc.ratings_average ? Number(doc.ratings_average.toFixed(1)) : undefined,
    ratingCount: doc.ratings_count,
    source: 'openlibrary',
    identity: { olWork: workIdFromKey(doc.key), olEdition: doc.cover_edition_key },
  });
  return { book, flags: { subjects: doc.subject } };
}

/** Raw search. Never throws; returns [] on any failure. */
export async function searchOpenLibrary(params: Record<string, string>, limit: number, opts: CallOpts = {}): Promise<Hit[]> {
  const q = new URLSearchParams({ limit: String(limit), fields: FIELDS, ...params });
  const data = await getJson(`${OL}/search.json?${q}`, { signal: opts.signal, retries: opts.retries });
  return ((data?.docs || []) as OlDoc[]).filter(d => d?.title).map((d, i) => olDocToHit(d, i));
}

/** Open Library's own trending lists (what readers are doing right now). Rank 0 = most trending. */
export async function trendingOpenLibrary(period: 'daily' | 'weekly', limit: number, opts: CallOpts = {}): Promise<Array<Hit & { rank: number }> | null> {
  const data = await getJson(`${OL}/trending/${period}.json?limit=${limit}`, { timeout: 10000, retries: 1, signal: opts.signal });
  if (!data) return null;
  return ((data.works || data.docs || []) as OlDoc[]).filter(d => d?.title).map((d, i) => ({ ...olDocToHit(d, i), rank: i }));
}

/**
 * The best Open Library match for a title/author (or an ISBN, which pins the edition's work exactly).
 * Prefers a doc that has a cover, then the one with the most ratings.
 */
export async function findOpenLibrary(q: { title: string; author?: string; isbn?: string }, opts: CallOpts = {}): Promise<Hit | null> {
  const isbn = cleanIsbn(q.isbn);
  let hits = isbn ? await searchOpenLibrary({ isbn }, 3, opts) : [];
  if (!hits.length) {
    const params: Record<string, string> = { title: q.title };
    if (q.author && !/^(Unknown|Featured) Author$/.test(q.author)) params.author = q.author;
    hits = (await searchOpenLibrary(params, 6, opts)).filter(h => titlesMatch(h.book.title, q.title) && authorListMatches(h.book.author, q.author || ''));
  }
  if (!hits.length) return null;
  const withCover = hits.filter(h => h.book.coverId);
  const pool = withCover.length ? withCover : hits;
  return pool.reduce((p, c) => ((c.book.ratingCount || 0) > (p.book.ratingCount || 0) ? c : p), pool[0]);
}

export async function openLibraryRatings(workId: string, opts: CallOpts = {}): Promise<{ average: number; count: number } | null> {
  const j = await getJson(`${OL}/works/${workId}/ratings.json`, { timeout: 8000, signal: opts.signal });
  const sm = j?.summary;
  return sm?.average ? { average: Number(Number(sm.average).toFixed(1)), count: Number(sm.count) || 0 } : null;
}

export async function openLibraryDescription(workId: string, opts: CallOpts = {}): Promise<string> {
  const w = await getJson(`${OL}/works/${workId}.json`, { timeout: 8000, signal: opts.signal });
  const val = typeof w?.description === 'string' ? w.description : w?.description?.value;
  return val ? String(val).split(/\n-{3,}|\n\n/)[0].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').slice(0, 600) : '';
}

/** Median page count across a work's editions (used when the search index has no page count). */
export async function openLibraryEditionPages(workId: string, opts: CallOpts = {}): Promise<number | undefined> {
  const data = await getJson(`${OL}/works/${workId}/editions.json?limit=40`, { signal: opts.signal });
  const pages: number[] = ((data && data.entries) || [])
    .map((e: any) => Number(e.number_of_pages))
    .filter((n: number) => Number.isFinite(n) && n >= 30 && n <= 2500)
    .sort((a: number, b: number) => a - b);
  return pages.length ? pages[Math.floor(pages.length / 2)] : undefined;
}

/** Re-read one work's search record (ratings, pages, genre, year). */
export async function openLibraryWorkRecord(workId: string, opts: CallOpts = {}): Promise<Hit | null> {
  const hits = await searchOpenLibrary({ q: `key:/works/${workId}` }, 1, opts);
  return hits[0] ?? null;
}
