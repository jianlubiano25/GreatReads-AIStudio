import React, { useState, useEffect } from 'react';
import { useModalA11y } from '../hooks/useModalA11y';
import { Book } from '../types';
import { BOOK_AWARDS, DIFFICULTY_LABELS, SHELF_LABELS } from '../data/defaultBooks';
import { getCoverUrl, enrichBookDetails, fetchBookMeta } from '../services/books';
import { CoverFace, stars, compactCount, honorsListFor } from './BookMeta';
import { X, BookOpen, Smartphone, Star, Award, ChevronDown, Check, Plus, Bookmark } from 'lucide-react';

interface AppleBookDetailModalProps {
  book: Book;
  inLibrary: boolean;
  onDevice: boolean;
  readingStatus?: string;
  currentPage?: number;
  totalPages?: number;
  note?: string;
  highlightsCount?: number;
  onClose: () => void;
  onAddToLibrary: (book: Book) => void;
  onAddToDevice: (book: Book) => void;
  onUpdateProgress?: (page: number) => void;
  onOpenHighlights?: () => void;
}

export const AppleBookDetailModal: React.FC<AppleBookDetailModalProps> = ({
  book: initialBook,
  inLibrary,
  onDevice,
  readingStatus,
  currentPage = 0,
  totalPages: propTotalPages,
  note,
  highlightsCount = 0,
  onClose,
  onAddToLibrary,
  onAddToDevice,
  onUpdateProgress,
  onOpenHighlights,
}) => {
  useModalA11y(onClose);
  const [book, setBook] = useState<Book>(initialBook);
  const [isExpanded, setIsExpanded] = useState(false);
  const [loadingDetails, setLoadingDetails] = useState(false);
  const [activeTabAction, setActiveTabAction] = useState<'idle' | 'lib' | 'dev'>('idle');

  // Load richer details if missing summary or page count
  useEffect(() => {
    let isMounted = true;
    if (!book.pageCount || (book.summary || '').length < 60 || (book.summary || '').startsWith('A distinguished work') || !book.authorBio) {
      setLoadingDetails(true);
      (async () => {
        try {
          const enriched = await enrichBookDetails(book);
          // Merge only what enrichment found, so it can't wipe ratings/pages that arrived meanwhile
          if (isMounted) setBook(prev => ({ ...prev, summary: enriched.summary, authorBio: enriched.authorBio }));
        } catch (e) {
          console.warn('Enrichment failed', e);
        } finally {
          if (isMounted) setLoadingDetails(false);
        }
      })();
    }
    return () => {
      isMounted = false;
    };
  }, [book.id]);

  // Fill in real pages / genre / year / ratings from Open Library (cached after first load).
  // Curated catalog books keep their hand-written genre; store books get the looked-up one.
  useEffect(() => {
    let live = true;
    const isCurated = typeof initialBook.id === 'number';
    const needsMeta =
      isCurated ||
      !initialBook.pageCount ||
      !initialBook.genre || initialBook.genre === 'Book' ||
      !initialBook.ratingAverage;
    if (needsMeta) {
      fetchBookMeta(initialBook).then(m => {
        if (!live || !m) return;
        setBook(prev => {
          const next = { ...prev, ...m };
          if (isCurated || (prev.genre && prev.genre !== 'Book')) next.genre = prev.genre;
          if (prev.year && prev.year !== 'N/A') next.year = prev.year;
          if (prev.difficulty) next.difficulty = prev.difficulty;
          // What the card showed is what the sheet shows; live data only fills the gaps
          if (prev.ratingAverage) { next.ratingAverage = prev.ratingAverage; next.ratingCount = prev.ratingCount; }
          if (prev.pageCount) next.pageCount = prev.pageCount;
          return next;
        });
      });
    }
    return () => { live = false; };
  }, [initialBook.id]);

  const awards = honorsListFor(book);
  const coverUrl = getCoverUrl(book.coverId, 'L', book.coverUrl);
  const displayPages = propTotalPages || book.pageCount || 0;
  const shelfInfo = SHELF_LABELS[book.shelf] || { label: book.genre || 'Book', emoji: '📖', color: book.spineColor || '#2e5934' };
  // Under the genre: the curated shelf (🧠 Heal) — or where a store book came from.
  const shelfSubLabel =
    book.shelf === 'mine' && book.source && book.source !== 'manual'
      ? book.source === 'google' ? '📚 Google Books' : '📚 Open Library'
      : `${shelfInfo.emoji} ${shelfInfo.label}`;

  const handleLibraryClick = () => {
    setActiveTabAction('lib');
    onAddToLibrary(book);
    setTimeout(() => setActiveTabAction('idle'), 1200);
  };

  const handleDeviceClick = () => {
    setActiveTabAction('dev');
    onAddToDevice(book);
    setTimeout(() => setActiveTabAction('idle'), 1200);
  };

  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchDeltaY, setTouchDeltaY] = useState(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    // Only capture pull-down if scrolled to top
    const target = e.currentTarget as HTMLElement;
    if (target.scrollTop <= 5) {
      setTouchStart(e.touches[0].clientY);
    } else {
      setTouchStart(null);
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (touchStart === null) return;
    const currentY = e.touches[0].clientY;
    const diff = currentY - touchStart;
    if (diff > 0) {
      setTouchDeltaY(diff);
    } else {
      setTouchDeltaY(0);
    }
  };

  const handleTouchEnd = () => {
    if (touchDeltaY > 100) {
      onClose();
    }
    setTouchStart(null);
    setTouchDeltaY(0);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm p-0 sm:p-4 overflow-y-auto animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative w-full max-w-[620px] max-h-[92dvh] sm:max-h-[88dvh] bg-[#fbf7ee] dark:bg-[#231d17] text-[#201a15] dark:text-[#f0e6d6] rounded-t-3xl sm:rounded-3xl shadow-2xl overflow-y-auto overscroll-contain flex flex-col border border-[#e3d7c3] dark:border-[#382f25] transition-transform duration-100 ease-out"
        style={{
          transform: touchDeltaY > 0 ? `translateY(${touchDeltaY}px)` : undefined,
          opacity: touchDeltaY > 0 ? Math.max(0.4, 1 - touchDeltaY / 300) : 1,
        }}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onClick={e => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={book.title}
      >
        {/* Mobile drag handle - also touchable swipe area */}
        <div className="sm:hidden pt-3 pb-2 cursor-grab active:cursor-grabbing flex flex-col items-center">
          <div className="w-12 h-1.5 bg-black/25 dark:bg-white/30 rounded-full" />
        </div>

        {/* Circular Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 w-8 h-8 rounded-full bg-black/10 dark:bg-white/10 hover:bg-black/20 dark:hover:bg-white/20 flex items-center justify-center text-[#201a15] dark:text-[#f0e6d6] transition-colors"
          aria-label="Close details"
        >
          <X className="w-4 h-4" />
        </button>

        {/* Hero Section with Book Spine Gradient Background */}
        <div
          className="relative px-6 pt-8 pb-6 flex flex-col sm:flex-row items-center sm:items-end gap-6 text-center sm:text-left border-b border-[#e3d7c3] dark:border-[#382f25]"
          style={{
            background: `linear-gradient(180deg, ${shelfInfo.color}28 0%, ${shelfInfo.color}08 70%, transparent 100%)`,
          }}
        >
          {/* Large 3D Book Cover */}
          <div className="relative shrink-0">
            <div
              className="book-cover-modal-3d w-[150px] h-[222px] sm:w-[170px] sm:h-[250px] flex flex-col justify-between p-4 text-white overflow-hidden relative shadow-lg"
              style={{ backgroundColor: book.spineColor || shelfInfo.color }}
            >
              <CoverFace book={book} size="xl" imgSize="M" badge={false} eager={true} />
            </div>
          </div>

          {/* Book Header Info */}
          <div className="flex-1 flex flex-col items-center sm:items-start min-w-0">
            <h2 className="font-serif-display text-2xl sm:text-3xl leading-tight text-[#201a15] dark:text-[#f0e6d6] mb-1">
              {book.title}
            </h2>
            <div className="text-[#2e5934] dark:text-[#86b880] font-medium text-base mb-2">
              {book.author}
            </div>

            {book.notes && (
              <p className="text-xs text-[#706256] dark:text-[#a89a8a] italic mb-4 max-w-md line-clamp-2">
                “{book.notes}”
              </p>
            )}

            {/* Apple Books Action Buttons (Instead of Get/Sample: Add to Library or Add to Device) */}
            <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 w-full max-w-md mt-2">
              <button
                onClick={handleLibraryClick}
                disabled={inLibrary}
                className={`flex-1 min-h-[44px] px-3 py-2.5 rounded-full text-sm font-semibold whitespace-nowrap flex items-center justify-center gap-2 transition-all ${
                  inLibrary
                    ? 'bg-[#e8efe7] dark:bg-[#243422] text-[#2e5934] dark:text-[#86b880] cursor-default'
                    : 'bg-[#2e5934] text-white hover:bg-[#244729] active:scale-[0.98] shadow-sm'
                }`}
              >
                {inLibrary ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>In Library</span>
                  </>
                ) : activeTabAction === 'lib' ? (
                  <span>Adding…</span>
                ) : (
                  <>
                    <BookOpen className="w-4 h-4" />
                    <span>Add to Library</span>
                  </>
                )}
              </button>

              <button
                onClick={handleDeviceClick}
                disabled={onDevice}
                className={`flex-1 min-h-[44px] px-3 py-2.5 rounded-full text-sm font-semibold whitespace-nowrap flex items-center justify-center gap-2 transition-all border ${
                  onDevice
                    ? 'bg-[#e8efe7] dark:bg-[#243422] text-[#2e5934] dark:text-[#86b880] border-transparent cursor-default'
                    : 'bg-transparent border-[#2e5934] dark:border-[#86b880] text-[#2e5934] dark:text-[#86b880] hover:bg-[#2e5934]/10 active:scale-[0.98]'
                }`}
              >
                {onDevice ? (
                  <>
                    <Check className="w-4 h-4" />
                    <span>On Device</span>
                  </>
                ) : activeTabAction === 'dev' ? (
                  <span>Adding…</span>
                ) : (
                  <>
                    <Smartphone className="w-4 h-4" />
                    <span>Add to Device</span>
                  </>
                )}
              </button>
            </div>

            {/* Reading Status Indicator if in reading list */}
            {inLibrary && readingStatus && (
              <div className="mt-3 text-xs text-[#706256] dark:text-[#a89a8a] flex items-center gap-2">
                <span className="inline-block w-2 h-2 rounded-full bg-[#2e5934] dark:bg-[#86b880]" />
                <span className="capitalize">{readingStatus === 'now' ? 'Reading Now' : readingStatus === 'next' ? 'Up Next' : readingStatus === 'done' ? 'Finished' : 'In Library'}</span>
                {currentPage > 0 && <span>· Page {currentPage} of {displayPages}</span>}
              </div>
            )}
          </div>
        </div>

        {/* Quick facts: always four columns (same layout as the Gemini version).
            Missing data shows a dash instead of an invented number. */}
        <div className="grid grid-cols-4 sm:flex sm:items-stretch justify-around py-3 px-2 sm:px-4 border-b border-[#e3d7c3] dark:border-[#382f25] text-center bg-[#fdfaf3] dark:bg-[#1f1914]">
          <div className="flex flex-col items-center justify-center p-1 sm:px-3 sm:flex-1 border-r border-[#e3d7c3]/60 dark:border-[#382f25]">
            <span className="text-[10px] sm:text-[11px] uppercase font-bold tracking-wider text-[#706256] dark:text-[#a89a8a] line-clamp-1">
              {book.ratingCount ? `${compactCount(book.ratingCount)} Ratings` : 'Rating'}
            </span>
            <div className="font-bold text-base sm:text-lg text-[#201a15] dark:text-[#f0e6d6] flex items-center justify-center gap-1 my-0.5">
              {book.ratingAverage ? (
                <>
                  <Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400 inline" />
                  <span>{book.ratingAverage.toFixed(1)}</span>
                </>
              ) : (
                <span className="text-[#706256] dark:text-[#a89a8a]">—</span>
              )}
            </div>
            <span className="text-[10px] sm:text-[11px] text-[#706256] dark:text-[#a89a8a]">Readers</span>
          </div>

          <div className="flex flex-col items-center justify-center p-1 sm:px-3 sm:flex-1 border-r border-[#e3d7c3]/60 dark:border-[#382f25]">
            <span className="text-[10px] sm:text-[11px] uppercase font-bold tracking-wider text-[#706256] dark:text-[#a89a8a]">Genre</span>
            <span className="font-bold text-sm sm:text-base text-[#201a15] dark:text-[#f0e6d6] truncate max-w-[85px] sm:max-w-none my-0.5">
              {book.genre && book.genre !== 'Book' ? book.genre : book.shelf === 'mine' ? '—' : shelfInfo.label}
            </span>
            <span className="text-[10px] sm:text-[11px] text-[#706256] dark:text-[#a89a8a] truncate max-w-[80px] sm:max-w-none">
              {shelfSubLabel}
            </span>
          </div>

          <div className="flex flex-col items-center justify-center p-1 sm:px-3 sm:flex-1 border-r border-[#e3d7c3]/60 dark:border-[#382f25]">
            <span className="text-[10px] sm:text-[11px] uppercase font-bold tracking-wider text-[#706256] dark:text-[#a89a8a]">Released</span>
            <span className="font-bold text-base sm:text-lg text-[#201a15] dark:text-[#f0e6d6] my-0.5">
              {book.year && book.year !== 'N/A' ? book.year : <span className="text-[#706256] dark:text-[#a89a8a]">—</span>}
            </span>
            <span className="text-[10px] sm:text-[11px] text-[#706256] dark:text-[#a89a8a]">Year</span>
          </div>

          <div className="flex flex-col items-center justify-center p-1 sm:px-3 sm:flex-1">
            <span className="text-[10px] sm:text-[11px] uppercase font-bold tracking-wider text-[#706256] dark:text-[#a89a8a]">Length</span>
            <span className="font-bold text-base sm:text-lg text-[#201a15] dark:text-[#f0e6d6] my-0.5">
              {displayPages ? displayPages : <span className="text-[#706256] dark:text-[#a89a8a]">—</span>}
            </span>
            <span className="text-[10px] sm:text-[11px] text-[#706256] dark:text-[#a89a8a]">Pages</span>
          </div>
        </div>

        {/* Awards Section if available */}
        {awards && awards.length > 0 && (
          <div className="px-6 py-4 border-b border-[#e3d7c3] dark:border-[#382f25] bg-[#f5f0e6]/50 dark:bg-[#181410]/50">
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#706256] dark:text-[#a89a8a] mb-2 flex items-center gap-1.5">
              <Award className="w-3.5 h-3.5 text-amber-500" />
              <span>Honors &amp; Awards</span>
            </h4>
            <div className="flex flex-wrap gap-2">
              {awards.map((aw, idx) => (
                <span
                  key={idx}
                  className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-medium bg-[#e8efe7] dark:bg-[#243422] text-[#2e5934] dark:text-[#86b880] border border-[#2e5934]/20"
                >
                  <span>{aw.type === 'w' ? '🏆' : aw.type === 'c' ? '📖' : '🎖️'}</span>
                  <span>{aw.label}</span>
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Synopsis / Description Section */}
        <div className="px-6 py-5 border-b border-[#e3d7c3] dark:border-[#382f25]">
          <h4 className="font-serif-display text-lg text-[#201a15] dark:text-[#f0e6d6] mb-2">
            About this book
          </h4>
          <p
            className={`text-[17px] leading-[1.65] text-[#201a15] dark:text-[#f0e6d6] ${
              isExpanded ? '' : 'line-clamp-5'
            }`}
          >
            {book.summary || 'A rich, thoughtful reading journey curated for your library.'}
          </p>
          {book.summary && book.summary.length > 160 && (
            <button
              onClick={() => setIsExpanded(!isExpanded)}
              className="mt-2 min-h-[44px] text-sm font-semibold text-[#2e5934] dark:text-[#86b880] hover:underline flex items-center gap-1"
            >
              <span>{isExpanded ? 'Show less' : 'More'}</span>
              <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isExpanded ? 'rotate-180' : ''}`} />
            </button>
          )}
        </div>

        {/* Ratings */}
        {book.ratingAverage ? (
          <div className="px-6 py-5 border-b border-[#e3d7c3] dark:border-[#382f25]">
            <h4 className="font-serif-display text-lg mb-2">Ratings</h4>
            <div className="flex items-center gap-4">
              <span className="font-serif-display text-5xl leading-none">{book.ratingAverage.toFixed(1)}</span>
              <div>
                <span className="rl-stars text-lg">{stars(book.ratingAverage)}</span>
                {book.ratingCount ? <div className="text-sm text-[#706256] dark:text-[#a89a8a]">{compactCount(book.ratingCount)} ratings</div> : null}
              </div>
            </div>
          </div>
        ) : null}

        {/* Information */}
        <div className="px-6 py-5 border-b border-[#e3d7c3] dark:border-[#382f25]">
          <h4 className="font-serif-display text-lg mb-1">Information</h4>
          {([
            ['Author', book.author],
            ['Published', book.year && book.year !== 'N/A' ? book.year : ''],
            ['Genre', book.genre],
            ['Length', displayPages ? `${displayPages} pages` : ''],
            ['Level', book.difficulty ? DIFFICULTY_LABELS[book.difficulty] : ''],
          ] as [string, string][]).filter(r => r[1]).map(([k, v]) => (
            <div key={k} className="flex justify-between gap-4 py-2.5 border-b border-[#e3d7c3]/70 dark:border-[#382f25] last:border-0 text-base">
              <span className="text-[#706256] dark:text-[#a89a8a]">{k}</span>
              <b className="font-semibold text-right">{v}</b>
            </div>
          ))}
        </div>

        {/* About the Author */}
        {book.authorBio && !book.authorBio.startsWith('No author') && (
          <div className="px-6 py-5 border-b border-[#e3d7c3] dark:border-[#382f25]">
            <h4 className="font-serif-display text-lg text-[#201a15] dark:text-[#f0e6d6] mb-2">
              About the Author
            </h4>
            <p className="text-[17px] leading-[1.65] text-[#201a15]/80 dark:text-[#f0e6d6]/80">
              {book.authorBio}
            </p>
          </div>
        )}

        {/* Reading Tools / Highlights quick access if currently reading */}
        <div className="px-6 py-4 bg-[#f5f0e6]/40 dark:bg-[#181410]/40 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <button
              onClick={onOpenHighlights}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border border-[#e3d7c3] dark:border-[#382f25] hover:bg-[#fbf7ee] dark:hover:bg-[#231d17] transition-colors"
            >
              <Bookmark className="w-3.5 h-3.5 text-[#925838] dark:text-[#d89e70]" />
              <span>Quotes &amp; Highlights {highlightsCount > 0 ? `(${highlightsCount})` : ''}</span>
            </button>
          </div>

          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg text-xs font-semibold bg-[#201a15]/10 dark:bg-white/10 hover:bg-[#201a15]/15 text-[#201a15] dark:text-[#f0e6d6]"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
