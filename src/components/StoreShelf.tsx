import React, { useEffect, useRef, useState } from 'react';
import { Book } from '../types';
import type { ShelfSource } from '../services/store/shelves';
import { CoverFace, RatingLine, AwardBadges } from './BookMeta';
import { rememberHonor } from '../services/store/honors';

interface Props {
  id: string;
  title: React.ReactNode;
  /** Where the books come from (a curated list, the NYT list, Trending...). The shelf does not care which. */
  source?: ShelfSource;
  /** A ready-made list (e.g. prize winners from your own catalog): no loading at all */
  books?: Book[];
  /** Show 1, 2, 3... on the covers (the order is the source's ranking) */
  ranked?: boolean;
  /** Only start loading when the shelf is about to scroll into view (long lists of curated shelves) */
  lazy?: boolean;
  /** Draw nothing (instead of an error box) when the source can't load: for optional shelves such as the extra NYT lists */
  hideIfUnavailable?: boolean;
  onOpen: (b: Book) => void;
}

/** One horizontally scrolling store shelf, fed by a ShelfSource. */
export const StoreShelf = React.memo(function StoreShelf({ id, title, source, books: fixedBooks, ranked, lazy, hideIfUnavailable, onOpen }: Props) {
  const [loaded, setLoaded] = useState<Book[] | null>(() => (fixedBooks || !source ? null : source.cached()));
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0); // "Try again" reloads the shelf
  const [visible, setVisible] = useState(!lazy);
  const holder = useRef<HTMLDivElement>(null);
  const books = fixedBooks ?? loaded;

  useEffect(() => {
    if (fixedBooks || !lazy || visible) return;
    const el = holder.current;
    if (!el || !('IntersectionObserver' in window)) { setVisible(true); return; }
    const io = new IntersectionObserver(es => {
      if (es.some(e => e.isIntersecting)) { setVisible(true); io.disconnect(); }
    }, { rootMargin: '500px' });
    io.observe(el);
    return () => io.disconnect();
  }, [fixedBooks, lazy, visible]);

  useEffect(() => {
    if (fixedBooks || !visible || !source) return;
    let live = true;
    setFailed(false);
    source.load(b => live && setLoaded(b))
      .then(b => live && setLoaded(prev => prev ?? b))
      .catch(() => live && setFailed(true));
    return () => { live = false; };
  }, [id, visible, source, fixedBooks, attempt]);

  // Honors & Awards: remember what each shelf calls its books, so the book info can list them all (see services/store/honors.ts)
  useEffect(() => { if (!fixedBooks) loaded?.forEach(rememberHonor); }, [loaded, fixedBooks]);

  if (fixedBooks && fixedBooks.length === 0) return null;
  if (failed && hideIfUnavailable) return null;

  return (
    <div ref={holder} className="flex flex-col gap-3">
      <h3 className="font-serif-display text-xl text-[#201a15] dark:text-[#f0e6d6] flex items-center gap-2">{source?.label?.() ?? title}</h3>
      {failed ? (
        <div className="flex items-center gap-3 flex-wrap text-sm text-[#706256] dark:text-[#a89a8a]">
          <p>Couldn't load this shelf. The store needs an internet connection.</p>
          <button type="button" onClick={() => setAttempt(n => n + 1)} className="px-3 py-1 rounded-lg text-xs font-semibold border border-[#e3d7c3] dark:border-[#382f25] bg-[#fbf7ee] dark:bg-[#231d17] text-[#2e5934] dark:text-[#86b880] active:scale-95 transition-all">
            Try again
          </button>
        </div>
      ) : !books ? (
        <div className="flex gap-4 overflow-hidden" aria-busy="true">
          {[0, 1, 2, 3].map(i => (
            <div key={i} className="w-[125px] sm:w-[140px] h-[180px] sm:h-[200px] shrink-0 rounded-md bg-[#e3d7c3]/60 dark:bg-[#382f25]/60 animate-pulse" />
          ))}
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-3 no-scrollbar">
          {books.map((b, i) => (
            <div key={`${b.id}|${b.title}`} className="w-[125px] sm:w-[140px] shrink-0 flex flex-col gap-1.5">
              <div className="relative">
                {ranked && (
                  <span className="absolute top-2 left-2 z-30 px-2 py-0.5 rounded-md text-xs font-bold bg-[#fbf7ee] dark:bg-[#231d17] text-[#201a15] dark:text-[#f0e6d6] shadow">
                    {i + 1}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onOpen(b)}
                  className="book-cover-3d w-full h-[180px] sm:h-[200px] text-left p-3 flex flex-col justify-between text-white overflow-hidden"
                  style={{ backgroundColor: b.spineColor || '#6b6f80' }}
                  aria-label={`${b.title} by ${b.author}`}
                >
                  <CoverFace book={b} size="md" eager={i < 6} />
                </button>
              </div>
              <h4 className="font-serif-display text-xs sm:text-sm font-semibold leading-tight line-clamp-2">
                <button type="button" onClick={() => onOpen(b)} className="text-left hover:underline focus-visible:underline focus:outline-none">
                  {b.title}
                </button>
              </h4>
              <p className="text-[11px] text-[#706256] dark:text-[#a89a8a] truncate">{b.author}</p>
              <RatingLine book={b} compact />
              <AwardBadges book={b} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});
