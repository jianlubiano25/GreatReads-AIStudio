import React, { useState, useEffect, useRef, useSyncExternalStore } from 'react';
import { Book } from '../types';
import { BOOK_AWARDS } from '../data/defaultBooks';
import { honorKind, mergeHonors } from '../services/store/honors';
import { coverKey, getCoverUrl, resolveCover, subscribeCovers, getCoversVersion, getCoverFix, dropCoverFix, reportMissingCover, clearMissingCover } from '../services/books';

export type AwardKind = 'w' | 's' | 'c'; // winner, shortlist, other pick (book club, series...)

/** Prize wins get a trophy, shortlists a medal, and anything else (e.g. "Service95 Pick") a plain book badge. */
export const awardsFor = (b: Book): { type: AwardKind; label: string }[] => {
  const base: { type: AwardKind; label: string }[] = typeof b.id === 'number' ? BOOK_AWARDS[b.id] || [] : [];
  if (!b.awardLabel) return base;
  return [...base, { type: honorKind(b.awardLabel), label: b.awardLabel }];
};

/** For the book info (Honors & Awards): everything awardsFor shows plus every other label shelves have given this book, so a book club pick that also won a prize lists both. Not used on the Store covers. */
export const honorsListFor = (b: Book): { type: AwardKind; label: string }[] => mergeHonors(awardsFor(b), b);

export const stars = (r: number) => {
  const count = Math.max(0, Math.min(5, Math.round(r) || 0));
  return '★'.repeat(count) + '☆'.repeat(5 - count);
};
export const compactCount = (n?: number) => (!n ? '' : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** ★★★★☆ 4.2 · 11k ratings (renders nothing if the book has no rating) */
export function RatingLine({ book, className = '', compact = false }: { book: Book; className?: string; compact?: boolean }) {
  if (typeof book.ratingAverage !== 'number' || !book.ratingAverage) return null;
  return (
    <div className={`text-xs text-[#706256] dark:text-[#a89a8a] ${className}`}>
      <span className="rl-stars">{stars(book.ratingAverage)}</span> {book.ratingAverage.toFixed(1)}
      {book.ratingCount ? ` · ${compactCount(book.ratingCount)}${compact ? '' : ' ratings'}` : ''}
    </div>
  );
}

/** Prize / shortlist chips, e.g. 🏆 Women's Prize 2021 */
export function AwardBadges({ book }: { book: Book }) {
  const a = awardsFor(book);
  if (!a.length) return null;
  return (
    <div className="rl-bdgs">
      {a.map((x, i) => (
        <span key={i} className={`rl-bdg ${x.type === 'w' ? 'rl-bdg-w' : x.type === 'c' ? 'rl-bdg-c' : ''}`}>
          {x.type === 'c' ? '📖' : x.type === 'w' ? '🏆' : '🎖️'} {x.label}
        </span>
      ))}
    </div>
  );
}

const SIZES = {
  xs: { t: 'relative z-10 line-clamp-3 leading-tight text-[9px]', a: 'relative z-10 text-[7px] truncate opacity-80' },
  // The reading-nook shelf: tiny spines, so the placeholder title is small and the author is left out until the real cover loads
  nook: { t: 'relative z-10 line-clamp-4 leading-[1.1] text-[5.5px] font-semibold break-words', a: 'hidden' },
  md: { t: 'relative z-10 font-serif-display text-xs line-clamp-3', a: 'relative z-10 text-[9px] truncate' },
  lg: { t: 'relative z-10 font-serif-display text-xs sm:text-sm leading-tight line-clamp-4', a: 'relative z-10 text-[10px] font-sans opacity-85 truncate' },
  xl: { t: 'relative z-10 font-serif-display text-base sm:text-lg leading-tight line-clamp-4 drop-shadow-md', a: 'relative z-10 text-[11px] font-sans opacity-90 truncate' },
} as const;

// URLs that have already loaded once on this device. Used only to skip the fade-in for covers that appear instantly.
// (Kept apart from 'readlife.preload', the short list index.html starts loading before the app code runs.)
const LOADED_KEY = 'readlife.loaded';
const loadedCovers = new Set<string>((() => {
  try {
    const saved = JSON.parse(localStorage.getItem(LOADED_KEY) || '[]');
    return Array.isArray(saved) ? saved : [];
  } catch {
    return [];
  }
})());

let saveLoadedTimer: ReturnType<typeof setTimeout> | undefined;
function recordLoadedCover(url: string) {
  if (!url || loadedCovers.has(url)) return;
  loadedCovers.add(url);
  // Many covers load in a burst: write the list once, a moment later
  clearTimeout(saveLoadedTimer);
  saveLoadedTimer = setTimeout(() => {
    try {
      localStorage.setItem(LOADED_KEY, JSON.stringify(Array.from(loadedCovers).slice(-300)));
    } catch {}
  }, 1500);
}

export function warmBookCover(book: Book, imgSize: 'S' | 'M' | 'L' = 'M') {
  const url = getCoverFix(book) || getCoverUrl(book.coverId, imgSize, book.coverUrl);
  if (!url || loadedCovers.has(url)) return;
  const im = new Image();
  im.onload = () => recordLoadedCover(url);
  im.src = url;
}

/**
 * Cover contents. The real cover image is shown on its own; the title/author text
 * appears gracefully as the book jacket while loading or when no cover exists.
 */
type CoverFaceProps = { book: Book; size?: keyof typeof SIZES; imgSize?: 'S' | 'M' | 'L'; badge?: boolean; eager?: boolean };

/**
 * Cover state belongs to one book. Keying the inner component ensures that when a different book takes a reused shelf slot,
 * retries and replacement covers from the previous book are discarded.
 */
export const CoverFace = React.memo(function CoverFace(props: CoverFaceProps) {
  return <CoverFaceFor key={coverKey(props.book)} {...props} />;
});

function CoverFaceFor({ book, size = 'md', imgSize = 'M', badge = true, eager = false }: CoverFaceProps) {
  // Re-render when "Reload missing covers" repairs one; a repaired cover wins over the original link
  useSyncExternalStore(subscribeCovers, getCoversVersion, getCoversVersion);
  const baseUrl = getCoverFix(book) || getCoverUrl(book.coverId, imgSize, book.coverUrl);
  type St = { base: string; tries: number; alt: string; dead: boolean };
  const [st, setSt] = useState<St>({ base: baseUrl, tries: 0, alt: '', dead: false });
  const cur: St = st.base === baseUrl ? st : { base: baseUrl, tries: 0, alt: '', dead: false };

  // Retry twice (cache-busted), then look for the same book's cover on Apple / Google Books
  const src = cur.alt || (cur.tries > 0 && baseUrl ? `${baseUrl}${baseUrl.includes('?') ? '&' : '?'}r=${cur.tries}` : baseUrl);
  const [imgLoaded, setImgLoaded] = useState(() => (src ? loadedCovers.has(src) : false));

  useEffect(() => {
    if (src && loadedCovers.has(src)) {
      setImgLoaded(true);
    }
  }, [src]);

  // A cover the browser already has (HTTP cache) is complete the moment the <img> exists: show it straight away instead of
  // flashing the title placeholder first. (onLoad can fire before React attaches it, or not at all for cached images.)
  const imgRef = useRef<HTMLImageElement>(null);
  useEffect(() => {
    const im = imgRef.current;
    if (im && im.complete && im.naturalWidth >= 8) {
      recordLoadedCover(src);
      setImgLoaded(true);
    }
  }, [src]);

  const giveUp = () => {
    resolveCover(book).then(u => setSt(u ? { ...cur, alt: u } : { ...cur, dead: true }));
  };
  useEffect(() => {
    if (!baseUrl && !cur.alt && !cur.dead) giveUp();
  }, [baseUrl, book.title]);

  // Every attempt failed: tell the "Reload missing covers" button
  useEffect(() => {
    if (!cur.dead) return;
    if (getCoverFix(book)) dropCoverFix(book); // a repaired cover that broke: forget it, then it can be repaired again
    else reportMissingCover(book);
  }, [cur.dead, book.title, book.author]);

  const onErr = () => {
    if (cur.alt) return setSt({ ...cur, dead: true });
    if (cur.tries < 2 && baseUrl) {
      setTimeout(() => setSt(p => (p.base === baseUrl ? { ...p, tries: cur.tries + 1 } : p)), 700 * (cur.tries + 1));
      return;
    }
    giveUp();
  };

  const url = src;
  const failed = cur.dead;
  const won = awardsFor(book).some(a => a.type === 'w');
  const isEager = eager || size === 'lg' || size === 'xl';
  const wasKnown = url ? loadedCovers.has(url) : false; // seen before on this device: appears with no fade
  const isReady = wasKnown || imgLoaded;

  return (
    <>
      {url && !failed ? (
        <img
          key={url}
          ref={imgRef}
          src={url}
          alt=""
          loading={isEager ? 'eager' : 'lazy'}
          fetchPriority={isEager ? 'high' : undefined}
          decoding="async"
          className={`absolute inset-0 w-full h-full object-cover z-20 ${wasKnown ? '' : 'transition-opacity duration-150'} ${isReady ? 'opacity-100' : 'opacity-0'}`}
          referrerPolicy="no-referrer"
          onLoad={e => {
            // A 1x1 placeholder counts as a failure; a real image clears any earlier miss
            const im = e.currentTarget;
            if (im.naturalWidth > 0 && im.naturalWidth < 8) return onErr();
            recordLoadedCover(url);
            setImgLoaded(true);
            clearMissingCover(book);
          }}
          onError={onErr}
        />
      ) : null}
      {(!url || failed || !isReady) ? (
        <div className="flex flex-col justify-between h-full w-full pointer-events-none select-none">
          <b className={SIZES[size].t}>{book.title}</b>
          <span className={SIZES[size].a}>{book.author}</span>
        </div>
      ) : null}
      {badge && won && size !== 'xs' ? (
        <span className="rl-prize" title="Prize winner" aria-label="Prize winner">🏆</span>
      ) : null}
    </>
  );
}
