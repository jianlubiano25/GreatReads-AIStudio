import type { Book } from '../../types';
import { persistentCache } from '../books/cache';
import { authorKey, titleKey } from '../books/identity';

/**
 * Honors & Awards, wherever a book is opened.
 *
 * Shelves attach a label to a book ("Oprah's Book Club · Mar 2026", "Women's Prize 2021", "Pulitzer Prize Winner"). The label
 * stays under the cover on its own shelf. A book can be on several shelves, so each label a shelf gives it is also remembered
 * here by book (title + author), and the book info lists them all: a book club pick that also won a prize shows both.
 *
 * Only labels that shelves actually carried are remembered: nothing is looked up or guessed. The NYT's weekly "bestseller ·
 * N weeks" label is left out: it describes this week's rank, not an honor.
 */

const store = persistentCache<string[]>('readlife.honors1', { ttl: 400 * 24 * 60 * 60 * 1000, max: 600 });

const keyOf = (b: Pick<Book, 'title' | 'author'>) => `${titleKey(b.title)}|${authorKey(b.author)}`;
const isHonor = (label: string) => !!label.trim() && !/^NYT bestseller/i.test(label);

/** Remember the label a shelf gave this book (once; repeats and the same label with a different date are kept apart). */
export function rememberHonor(b: Pick<Book, 'title' | 'author' | 'awardLabel'>): void {
  const label = b.awardLabel?.trim();
  if (!label || !isHonor(label) || !b.title || !b.author) return;
  const key = keyOf(b);
  const have = store.get(key) ?? [];
  if (!have.includes(label)) store.set(key, [...have, label]);
}

/** Every label remembered for this book, in the order they were learned. */
export const honorsFor = (b: Pick<Book, 'title' | 'author'>): string[] => (b.title && b.author ? store.get(keyOf(b)) ?? [] : []);

export type HonorKind = 'w' | 's' | 'c'; // won a prize, shortlisted, club / other pick
const PRIZE_WORDS = /prize|award|winner|booker|pulitzer|costa|nobel|medal|goncourt|carnegie/i;

/** Prize wins get a trophy, shortlists a medal, and anything else (a book club pick, a series...) a plain book. */
export const honorKind = (label: string): HonorKind => (/shortlist|longlist/i.test(label) ? 's' : PRIZE_WORDS.test(label) ? 'w' : 'c');

const ORDER: Record<HonorKind, number> = { w: 0, s: 1, c: 2 };

/**
 * What the book info lists: the book's own awards (catalog + the label it was opened with) plus everything else shelves have
 * called it, without repeats, prizes first, then shortlists, then club picks.
 */
export function mergeHonors(base: { type: HonorKind; label: string }[], b: Pick<Book, 'title' | 'author'>): { type: HonorKind; label: string }[] {
  const seen = new Set(base.map(x => x.label.toLowerCase()));
  const extra = honorsFor(b).filter(l => !seen.has(l.toLowerCase())).map(label => ({ type: honorKind(label), label }));
  return [...base, ...extra].map((x, i) => ({ x, i })).sort((p, q) => ORDER[p.x.type] - ORDER[q.x.type] || p.i - q.i).map(p => p.x);
}
