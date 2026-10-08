import type { Book } from '../../types';
import resolvedData from '../../data/storeResolved.json';
import { CURATED_SHELVES, type CuratedShelf } from '../../data/storeCatalog';
import { mapPool } from '../books/http';
import { persistentCache } from '../books/cache';
import { authorKey, authorsCompatible, titleKey, titlesMatch, workIdFromKey } from '../books/identity';
import { makeBook } from '../books/model';
import { getCoverUrl } from '../books/covers';
import { resolveBook } from '../books/resolve';
import type { ShelfSource } from './shelves';

/** Output of `npm run prefetch:store`: covers + combined ratings bundled with the app, matched to the seed list by position. */
const PREFETCHED = resolvedData as unknown as Record<string, (Partial<Book> & { olKey?: string } | null)[]>;

const SEED_COLORS = ['#6b6f80', '#8a5a3b', '#2e5934', '#925838', '#3a7d80', '#7a4a6a'];
// v2: shelves saved by older versions could hold a cover that belonged to another book (a reused slot); they are looked up again once
const cache = persistentCache<{ sig: string; books: Book[] }>('readlife.curated2', { ttl: 7 * 24 * 60 * 60 * 1000, max: 40 });

/** Changes whenever the shelf's books or pick labels change, so an edited shelf never shows an old cached one. */
const shelfSig = (shelf: CuratedShelf) => shelf.seeds.map(s => `${s[0]}|${s[1]}|${s[2] || ''}`).join('~');

/**
 * Prefetched cover/rating data is stored BY POSITION, so it may only be used for the book it was fetched for. A self-refreshing
 * shelf has a different list from the bundled one, and slot 3 of the new list is not slot 3 of the old: using the old slot's
 * cover would put the wrong cover (and rating, year, Open Library link) on the new book.
 * The record's own title settles it when it has one; older data has none, so the slot must still hold the same book as the
 * bundled seed list the data was fetched for.
 */
export function prefetchedFor(shelfId: string, i: number, title: string, author: string): Partial<Book> & { olKey?: string; title?: string } {
  const rec = PREFETCHED[shelfId]?.[i];
  if (!rec) return {};
  if (rec.title) return rec.title === title ? rec : {};
  const bundled = CURATED_SHELVES.find(s => s.id === shelfId)?.seeds[i];
  return bundled && bundled[0] === title && bundled[1] === author ? rec : {};
}

/**
 * A placeholder's id belongs to the BOOK, not to its slot. A self-refreshing shelf puts different books in the same slot over
 * time, and "seed_oprah_3" would then be a different book each month (the same id on a cover, a saved copy, a cover repair...).
 */
export const seedId = (shelfId: string, title: string, author: string) =>
  `seed_${shelfId}_${`${titleKey(title)} ${authorKey(author)}`.replace(/\s+/g, '-').slice(0, 80)}`;

/** Title-only books so a shelf can draw right away, before any network call (plus whatever was prefetched at build time). */
export function seedPlaceholders(shelf: CuratedShelf): Book[] {
  return shelf.seeds.map(([t, a, award], i) => {
    const r = prefetchedFor(shelf.id, i, t, a);
    const olWork = r.olKey ? workIdFromKey(r.olKey) : undefined;
    return makeBook({
      id: r.olKey ? `ol_${r.olKey.replace(/\W/g, '_')}` : seedId(shelf.id, t, a),
      awardLabel: award,
      title: t,
      author: a,
      genre: shelf.genre,
      summary: `${t} by ${a}.`,
      spineColor: SEED_COLORS[i % SEED_COLORS.length],
      source: 'openlibrary',
      coverId: r.coverId,
      coverUrl: r.coverUrl,
      ratingAverage: r.ratingAverage,
      ratingCount: r.ratingCount,
      year: r.year || '',
      pageCount: r.pageCount || 0,
      identity: olWork ? { olWork } : undefined,
    });
  });
}

export function getCachedCurated(shelf: CuratedShelf): Book[] | null {
  const hit = cache.get(shelf.id);
  return hit && hit.sig === shelfSig(shelf) && hit.books.length === shelf.seeds.length ? hit.books : null;
}

/**
 * Is what the resolver found the book the shelf asked for? The shelf's own title and author are always what is shown, so a wrong
 * match would put another book's cover, rating and link under the right name. Accepted when the titles agree, or when the author
 * agrees and the titles share most of their words (a different edition's title); anything else is left to the cover search,
 * which has its own title and author check.
 */
export function resolvedMatchesSeed(found: Pick<Book, 'title' | 'author'>, title: string, author: string): boolean {
  if (titlesMatch(found.title, title)) return true;
  if (!authorsCompatible(found.author, author)) return false;
  const words = (t: string) => titleKey(t).split(' ').filter(w => w.length > 2);
  const [a, b] = [words(found.title), words(title)];
  const shared = a.filter(w => b.includes(w)).length;
  return shared >= Math.max(1, Math.ceil(Math.min(a.length, b.length) / 2));
}

/** Looks up covers + ratings 4 at a time through the shared resolver, pushing each result to the shelf as it arrives. */
export async function resolveCuratedShelf(shelf: CuratedShelf, current: Book[], onUpdate: (b: Book[]) => void): Promise<void> {
  const out = [...current];
  await mapPool(shelf.seeds, 4, async ([title, author, award], i) => {
    if (out[i].coverId || out[i].coverUrl) return;
    const r = await resolveBook({ title, author, fallbackId: out[i].id, genreHint: shelf.genre });
    if (!r || !resolvedMatchesSeed(r.book, title, author)) return;
    out[i] = { ...r.book, title, author, genre: shelf.genre, awardLabel: award, year: r.book.year || out[i].year, spineColor: out[i].spineColor };
    try { new Image().src = getCoverUrl(r.book.coverId, 'M', r.book.coverUrl); } catch {} // warm the cache
    onUpdate([...out]);
  });
  if (out.filter(b => b.coverId || b.coverUrl).length >= Math.ceil(out.length / 2)) cache.set(shelf.id, { sig: shelfSig(shelf), books: out });
}

/** A curated shelf as a ShelfSource (used by the Store's generic shelf component). */
export function curatedSource(shelf: CuratedShelf): ShelfSource & { seeded: () => Book[] } {
  const seeded = () => {
    const s = seedPlaceholders(shelf);
    // Fully prefetched shelves need no lookups and no cache at all
    return s.every(b => b.coverId || b.coverUrl) ? s : getCachedCurated(shelf) || s;
  };
  return {
    id: shelf.id,
    seeded,
    cached: seeded,
    info: () => ({ schedule: 'Hand-picked · no automatic updates', source: 'Hand-picked by GreatReads (no trustworthy public source to refresh from)', kind: 'curated' }),
    load: async onUpdate => {
      const start = seeded();
      await resolveCuratedShelf(shelf, start, onUpdate);
      return start;
    },
  };
}
