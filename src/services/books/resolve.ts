import type { Book } from '../../types';
import { dedupeInflight } from './http';
import { persistentCache } from './cache';
import { cleanIsbn, isbnPair, mergeIdentity } from './identity';
import { mergeBooks } from './merge';
import type { ContentFlags } from './quality';
import { findApple } from './sources/appleBooks';
import { findGoogle } from './sources/googleBooks';
import { findOpenLibrary, openLibraryRatings } from './sources/openLibrary';
import type { CallOpts } from './sources/types';

/**
 * Resolve a book we only know by name (and maybe ISBN) into one complete, normalised Book: Open Library supplies the work
 * identity, ratings and pages; Google Books supplies the exact edition for an ISBN, descriptions and covers; Apple Books
 * (optional) adds readers' ratings. Used by the Store shelves, the NYT list and Trending, so a book is only resolved once
 * and every shelf agrees on what it is.
 */

export interface ResolveQuery {
  title: string;
  author?: string;
  isbn?: string; // ISBN-13 or 10: pins the exact edition
  fallbackId?: string | number; // used as the record id when no Open Library work is found
  genreHint?: string;
  apple?: boolean; // also ask Apple Books (adds ratings; one more request)
}
export interface Resolved {
  book: Book;
  flags: ContentFlags;
  /** Each source's OWN rating count (they are different audiences, so scoring normalises them separately). Absent on older cached results. */
  readers?: { ol?: number; google?: number; apple?: number };
  /** Category words from every source that answered (used to tell fiction from non-fiction). */
  words?: string[];
}

const cache = persistentCache<Resolved | null>('readlife.resolved1', { ttl: 14 * 24 * 60 * 60 * 1000, max: 250 });
/**
 * Books no source could place. Remembered only briefly: "not found" is often a dropped connection or a rate limit, and a miss
 * that lasted two weeks (as saved results do) left covers blank long after the network was fine again.
 */
const misses = persistentCache<true>('readlife.resolvedmiss1', { ttl: 2 * 60 * 60 * 1000, max: 300 });
const inflight = new Map<string, Promise<Resolved | null>>();

const keyOf = (q: ResolveQuery) => {
  const isbn = cleanIsbn(q.isbn);
  return `${isbn ? isbnPair(isbn).isbn13 : `${q.title}|${q.author || ''}`.toLowerCase()}${q.apple ? '|a' : ''}`;
};

export function resolveBook(q: ResolveQuery, opts: CallOpts = {}): Promise<Resolved | null> {
  const key = keyOf(q);
  const hit = cache.get(key);
  // Only a real result is reused for long. (Older versions also saved "not found" here for 14 days: those are looked up again.)
  if (hit) return Promise.resolve({ ...hit, book: { ...hit.book, id: pickId(hit.book, q) } });
  if (misses.get(key)) return Promise.resolve(null);
  return dedupeInflight(inflight, key, async () => {
    const [ol, gb, ap] = await Promise.all([
      findOpenLibrary(q, opts),
      findGoogle(q, opts),
      q.apple ? findApple(q, opts) : Promise.resolve(null),
    ]);
    const hits = [ol, gb, ap].filter((h): h is NonNullable<typeof h> => !!h);
    if (!hits.length) {
      if (!opts.signal?.aborted) misses.set(key, true);
      return null;
    }
    let book: Book = hits.map(h => h.book).reduce((a, b) => mergeBooks(a, b));
    book.identity = mergeIdentity(book.identity, isbnPair(q.isbn));
    if (!book.ratingAverage && book.identity?.olWork) {
      const r = await openLibraryRatings(book.identity.olWork, opts);
      if (r) book = { ...book, ratingAverage: r.average, ratingCount: r.count || book.ratingCount };
    }
    if (q.genreHint && !book.genre) book.genre = q.genreHint;
    const flags: ContentFlags = {
      subjects: hits.flatMap(h => h.flags.subjects || []),
      description: hits.map(h => h.flags.description).find(Boolean),
      googleMaturity: hits.map(h => h.flags.googleMaturity).find(Boolean),
      appleAdvisory: hits.map(h => h.flags.appleAdvisory).find(Boolean),
    };
    const out: Resolved = {
      book,
      flags,
      readers: { ol: ol?.book.ratingCount, google: gb?.book.ratingCount, apple: ap?.book.ratingCount },
      words: hits.flatMap(h => [...(h.flags.subjects || []), h.book.genre]),
    };
    if (!opts.signal?.aborted) cache.set(key, out);
    return { ...out, book: { ...out.book, id: pickId(out.book, q) } };
  });
}

/** Open Library work -> its "ol_…" id (the same id search gives); otherwise the caller's own record id. */
function pickId(book: Book, q: ResolveQuery): string | number {
  return String(book.id).startsWith('ol_') ? book.id : (q.fallbackId ?? book.id);
}
