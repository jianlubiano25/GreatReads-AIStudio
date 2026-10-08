import React, { useState, useEffect, useMemo, useRef, useCallback, lazy, Suspense } from 'react';
import { Book, BookStatus, TabType, WordItem } from './types';
import { BOOK_AWARDS } from './data/defaultBooks';
import { BUILTIN_DICTIONARY } from './data/defaultWords';
import { useReadingLife } from './hooks/useReadingLife';
import { searchBooks, getCoverUrl, fillMissingCovers } from './services/books';
import { DEFAULT_SHELF_ORDER, SHELF_BY_ID, hiddenShelfIds } from './services/store/registry';
import { loadStorePrefs, NO_PREFS, orderShelves, saveStorePrefs, toggleShelf, type StorePrefs } from './services/store/prefs';
import { lookupWord } from './services/dictionary';
import { dateKey } from './services/dates';
import { useAppUpdate, applyUpdate, dismissUpdate, restartApp } from './services/appUpdate';

// Modals
import { AppleBookDetailModal } from './components/AppleBookDetailModal';
import { ReadingScene } from './components/ReadingScene';
import { PlantCelebration } from './components/garden/PlantCelebration';
import { DayStrip } from './components/DayStrip';
import { NowReadingCard, UpNextCard, LibraryCard, DeviceCard, WordCard } from './components/cards';
import { CoverFace } from './components/BookMeta';
import { MissingCoversButton } from './components/MissingCoversButton';
import { StoreShelf } from './components/StoreShelf';
import { StoreCustomize } from './components/StoreCustomize';
import { bookKind } from './services/bookKind';

// Icons
import {
  BookOpen,
  ShoppingBag,
  Library,
  Sprout,
  Smartphone,
  Plus,
  Search,
  Award,
  RotateCcw,
  Sparkles,
  Share2,
  Download,
  AlertTriangle,
  SlidersHorizontal,
} from 'lucide-react';

/**
 * Rarely-used screens load on first open instead of at startup (smaller first download).
 * If a new deploy replaced the old files, reload once to pick up the new version.
 */
function lazyModal<T extends React.ComponentType<any>>(load: () => Promise<Record<string, any>>, name: string) {
  return lazy<T>(async () => {
    try {
      const m = await load();
      try { sessionStorage.removeItem('rl-chunk-reload'); } catch {}
      return { default: m[name] as T };
    } catch (e) {
      try {
        if (!sessionStorage.getItem('rl-chunk-reload')) {
          sessionStorage.setItem('rl-chunk-reload', '1');
          window.location.reload();
          return new Promise<{ default: T }>(() => {});
        }
      } catch {}
      throw e;
    }
  });
}
const AppleLookUpModal = lazyModal<typeof import('./components/AppleLookUpModal').AppleLookUpModal>(() => import('./components/AppleLookUpModal'), 'AppleLookUpModal');
const AddBookModal = lazyModal<typeof import('./components/AddBookModal').AddBookModal>(() => import('./components/AddBookModal'), 'AddBookModal');
const HighlightsModal = lazyModal<typeof import('./components/HighlightsModal').HighlightsModal>(() => import('./components/HighlightsModal'), 'HighlightsModal');
const ProfileModal = lazyModal<typeof import('./components/ProfileModal').ProfileModal>(() => import('./components/ProfileModal'), 'ProfileModal');
const BackupModal = lazyModal<typeof import('./components/BackupModal').BackupModal>(() => import('./components/BackupModal'), 'BackupModal');
const WordPracticeModal = lazyModal<typeof import('./components/WordPracticeModal').WordPracticeModal>(() => import('./components/WordPracticeModal'), 'WordPracticeModal');
const BulkImportModal = lazyModal<typeof import('./components/BulkImportModal').BulkImportModal>(() => import('./components/BulkImportModal'), 'BulkImportModal');
const ShareModal = lazyModal<typeof import('./components/ShareModal').ShareModal>(() => import('./components/ShareModal'), 'ShareModal');

/**
 * A tab's content stays mounted once it has been opened and is only hidden when you switch away,
 * so covers, shelves and scroll positions are not rebuilt (or re-downloaded) every time you come back.
 * Tabs you never open cost nothing: they are not rendered until the first visit.
 */
function TabPane({ active, children }: { active: boolean; children: React.ReactNode }) {
  return <div hidden={!active} className="contents">{children}</div>;
}

const TAB_TITLES: Record<string, string> = { store: 'Book Store', lib: 'Library', words: 'Word Garden', dev: 'On my device' };

export default function App() {
  const {
    state,
    allBooks,
    todayKey,
    todayPages,
    currentStreak,
    newPlantIds,
    markPlantsCelebrated,
    movePlant,
    setDayPages,
    updateBookProgress,
    setBookStatus,
    toggleOnDevice,
    addBook,
    removeBook,
    restoreHiddenBooks,
    updateBookNote,
    addHighlight,
    updateHighlight,
    deleteHighlight,
    updateIntention,
    updateProfile,
    setGoal,
    addWord,
    toggleWordLearned,
    setWordLearned,
    updateWord,
    deleteWord,
    exportBackup,
    importBackup,
    clearLibrary,
    clearOnDevice,
    resetEverything,
    saveError,
  } = useReadingLife();

  // "A new plant has arrived" prompts. A plant is marked as shown the moment it is queued (and that is saved),
  // so reloading the app or restoring a backup never shows the same prompt again.
  const [plantQueue, setPlantQueue] = useState<string[]>([]);
  useEffect(() => {
    if (!newPlantIds.length) return;
    setPlantQueue(q => [...q, ...newPlantIds.filter(id => !q.includes(id))]);
    markPlantsCelebrated(newPlantIds);
  }, [newPlantIds, markPlantsCelebrated]);

  // Navigation tab
  const [tab, setTab] = useState<TabType>('today');
  const [visitedTabs, setVisitedTabs] = useState<ReadonlySet<TabType>>(() => new Set<TabType>(['today']));
  const goTab = (id: TabType) => {
    setTab(id);
    setVisitedTabs(prev => (prev.has(id) ? prev : new Set(prev).add(id)));
  };

  // Modals state
  const [selectedBookForDetail, setSelectedBookForDetail] = useState<Book | null>(null);
  const [selectedBookForHighlights, setSelectedBookForHighlights] = useState<Book | null>(null);
  const [showAddBookModal, setShowAddBookModal] = useState<{ open: boolean; isDevice: boolean }>({
    open: false,
    isDevice: false,
  });
  const [showLookupModal, setShowLookupModal] = useState<{
    open: boolean;
    initialWord?: string;
    existingWord?: WordItem | null;
  }>({ open: false });
  const [showProfileModal, setShowProfileModal] = useState(false);
  const [showBackupModal, setShowBackupModal] = useState(false);
  const [showShareModal, setShowShareModal] = useState(false);
  const [showWordPracticeModal, setShowWordPracticeModal] = useState(false);
  const [showBulkModal, setShowBulkModal] = useState<{ open: boolean; type: 'books' | 'words' }>({
    open: false,
    type: 'books',
  });

  // Store layout: the reader's own shelf order and hidden shelves (prefs only; shelf data is never touched, see services/store/prefs.ts)
  const [storePrefs, setStorePrefs] = useState<StorePrefs>(loadStorePrefs);
  const [customizing, setCustomizing] = useState(false);
  const shelfOrder = useMemo(() => orderShelves(DEFAULT_SHELF_ORDER, storePrefs.order), [storePrefs.order]);
  const hiddenShelves = useMemo(() => hiddenShelfIds(storePrefs), [storePrefs]);
  const updateStorePrefs = useCallback((next: StorePrefs) => { setStorePrefs(next); saveStorePrefs(next); }, []);
  const reorderShelves = useCallback((order: string[]) => updateStorePrefs({ ...storePrefs, order }), [storePrefs, updateStorePrefs]);

  // Library filters
  const [libFilter, setLibFilter] = useState<string>('f');

  // New-version detection (prompts only when the code really changed)
  const update = useAppUpdate();

  // Word Garden filters & search
  const [wordFilter, setWordFilter] = useState<'all' | 'learning' | 'learned'>('all');
  const [wordSearchQuery, setWordSearchQuery] = useState('');

  // Store search & shelf data
  const [storeSearchQuery, setStoreSearchQuery] = useState('');
  const [storeSearchResults, setStoreSearchResults] = useState<Book[]>([]);
  const [isStoreSearching, setIsStoreSearching] = useState(false);


  // Handle store search with debounce; superseded requests are cancelled so a slow old answer
  // can never overwrite the results of what you typed last.
  // Words saved without a pronunciation get one filled in. Each word is tried once per two weeks (remembered on
  // this device), so a word the dictionary doesn't know doesn't cause a network request on every launch.
  const triedPhonetic = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (tab !== 'words') return;
    const KEY = 'readlife.phoneticTried';
    if (!triedPhonetic.current) {
      triedPhonetic.current = new Set();
      try {
        const saved: Record<string, number> = JSON.parse(localStorage.getItem(KEY) || '{}');
        for (const [id, t] of Object.entries(saved)) if (Date.now() - t < 14 * 86400000) triedPhonetic.current.add(id);
      } catch {}
    }
    const tried = triedPhonetic.current;
    let cancelled = false;
    (async () => {
      const todo = state.words
        .filter(w => {
          const lower = (w.word || '').toLowerCase();
          const builtinPhonetic = Object.hasOwn(BUILTIN_DICTIONARY, lower) ? BUILTIN_DICTIONARY[lower].phonetic : undefined;
          return !w.phonetic && !builtinPhonetic && !tried.has(w.id);
        })
        .slice(0, 12);
      for (const w of todo) {
        if (cancelled) return;
        tried.add(w.id);
        try {
          const saved: Record<string, number> = JSON.parse(localStorage.getItem(KEY) || '{}');
          saved[w.id] = Date.now();
          localStorage.setItem(KEY, JSON.stringify(saved));
        } catch {}
        try {
          const r = await lookupWord(w.word);
          if (r.phonetic || r.audioUrl) {
            updateWord(w.id, { phonetic: r.phonetic || undefined, audioUrl: r.audioUrl, partOfSpeech: w.partOfSpeech || r.partOfSpeech });
          }
        } catch {}
      }
    })();
    return () => { cancelled = true; };
  }, [tab, state.words.length]);

  useEffect(() => {
    if (!storeSearchQuery.trim()) {
      setStoreSearchResults([]);
      setIsStoreSearching(false);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setIsStoreSearching(true);
      try {
        const results = await searchBooks(storeSearchQuery, '', 10, controller.signal);
        if (!controller.signal.aborted) {
          setStoreSearchResults(results);
          fillMissingCovers(results, r => { if (!controller.signal.aborted) setStoreSearchResults(r); }, controller.signal);
        }
      } catch {
        if (!controller.signal.aborted) setStoreSearchResults([]);
      } finally {
        if (!controller.signal.aborted) setIsStoreSearching(false);
      }
    }, 450);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [storeSearchQuery]);

  // Books categorization
  const nowReadingBooks = useMemo(() => {
    const statusMap = state.status || {};
    return allBooks.filter(b => statusMap[String(b.id)] === 'now');
  }, [allBooks, state.status]);

  const upNextBooks = useMemo(() => {
    const statusMap = state.status || {};
    return allBooks.filter(b => statusMap[String(b.id)] === 'next');
  }, [allBooks, state.status]);

  const libraryBooks = useMemo(() => {
    const statusMap = state.status || {};
    return allBooks.filter(b => statusMap[String(b.id)] !== 'done');
  }, [allBooks, state.status]);

  const finishedBooks = useMemo(() => {
    const statusMap = state.status || {};
    return allBooks.filter(b => statusMap[String(b.id)] === 'done');
  }, [allBooks, state.status]);

  const onDeviceBooks = useMemo(() => {
    const statusMap = state.status || {};
    return allBooks.filter(b => b.isOnDevice && statusMap[String(b.id)] !== 'done');
  }, [allBooks, state.status]);

  const devicePages = useMemo(() => {
    let known = 0;
    let unknown = 0;
    for (const b of [...onDeviceBooks, ...finishedBooks]) {
      if (b.pageCount) known += b.pageCount;
      else unknown++;
    }
    return { known, unknown };
  }, [onDeviceBooks, finishedBooks]);

  const finishedCount = finishedBooks.length;

  // Totals for the profile's Achievements card
  const stats = useMemo(() => {
    const st = state.status || {};
    let finished = 0;
    let toRead = 0;
    allBooks.forEach(b => {
      const s = st[String(b.id)] || 'list';
      if (s === 'done') finished++;
      else if (s === 'next') toRead++;
    });
    const pagesRead = Object.values(state.dailyLog || {}).reduce((a: number, n) => a + (Number(n) || 0), 0);
    return { pagesRead, finished, toRead };
  }, [allBooks, state.status, state.dailyLog]);

  // Books shown on the scene shelves: finished books are kept off the nook shelf.
  const sceneBooks = useMemo(() => {
    const st = state.status || {};
    const rank = (b: Book) => (st[String(b.id)] === 'now' ? 0 : st[String(b.id)] === 'next' ? 1 : 2);
    return libraryBooks.filter(b => b.coverId || b.coverUrl).slice().sort((x, y) => rank(x) - rank(y)).slice(0, 72);
  }, [libraryBooks, state.status]);

  // Remember the covers you'll see first (the nook shelves, then reading now / up next) so the next launch can start
  // loading them before the app code runs. Same 'M' size URLs the nook and cards request, so it is one shared cache.
  // The service worker is also asked to download them in the background, so they are on the device the next time.
  useEffect(() => {
    try {
      const urls = [...nowReadingBooks, ...upNextBooks, ...sceneBooks]
        .map(b => getCoverUrl(b.coverId, 'M', b.coverUrl))
        .filter((u, i, a) => !!u && a.indexOf(u) === i)
        .slice(0, 60);
      localStorage.setItem('readlife.preload', JSON.stringify(urls));
      navigator.serviceWorker?.controller?.postMessage({ type: 'WARM_COVERS', urls });
    } catch {}
  }, [sceneBooks, nowReadingBooks, upNextBooks]);


  // 7-day dots for streak
  const last7Days = useMemo(() => {
    const days = [];
    const dayLetters = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
    const log = state.dailyLog || {};
    const goal = state.goal || 10;
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const k = dateKey(d);
      const pages = log[k] || 0;
      days.push({
        letter: dayLetters[d.getDay()],
        pages,
        isGoalMet: pages >= goal,
        key: k,
        isToday: i === 0,
      });
    }
    return days;
  }, [state.dailyLog, state.goal, todayKey]);

  // Store shelves built from your own catalog
  const prizeBooks = useMemo(
    () => allBooks.filter(b => typeof b.id === 'number' && (BOOK_AWARDS[b.id] || []).length > 0),
    [allBooks],
  );
  const easyBooks = useMemo(() => allBooks.filter(b => b.difficulty === 1), [allBooks]);

  // Library filtered books (includes all catalog challenge books + custom books)
  const filteredLibraryBooks = useMemo(() => {
    const list = libraryBooks;
    if (libFilter === 'f') {
      return list.filter(b => b.first12Order && b.first12Order > 0).sort((a, b) => (a.first12Order || 0) - (b.first12Order || 0));
    }
    if (libFilter === 's') {
      return list.filter(b => b.isNew);
    }
    if (libFilter === 'aw') {
      return list.filter(b => typeof b.id === 'number' && (BOOK_AWARDS[b.id] || []).length > 0);
    }
    if (libFilter === 'fic' || libFilter === 'nf') {
      const expected = libFilter === 'fic' ? 'fiction' : 'nonfiction';
      return list.filter(b => bookKind(b) === expected);
    }
    if (libFilter === 'all') {
      return list;
    }
    return list.filter(b => b.shelf === libFilter);
  }, [libraryBooks, libFilter]);

  // Filtered words
  const filteredWords = useMemo(() => {
    const q = wordSearchQuery.toLowerCase().trim();
    const wordsList = state.words || [];
    return wordsList.filter(w => {
      const matchFilter =
        wordFilter === 'all'
          ? true
          : wordFilter === 'learned'
          ? w.isLearned
          : !w.isLearned;
      const matchQuery =
        !q ||
        (w.word && (w.word || '').toLowerCase().includes(q)) ||
        (w.definition && w.definition.toLowerCase().includes(q)) ||
        (w.bookTitle && w.bookTitle.toLowerCase().includes(q));
      return matchFilter && matchQuery;
    });
  }, [state.words, wordFilter, wordSearchQuery]);

  // Searching for a word that is not in the garden yet offers to look it up and add it
  const searchedWord = wordSearchQuery.trim();
  const canAddSearchedWord =
    searchedWord.length > 0 &&
    searchedWord.length <= 40 &&
    !state.words.some(w => (w.word || '').toLowerCase() === searchedWord.toLowerCase());

  // Handlers (stable references so the memoized cards don't redraw when something unrelated changes)
  const handleOpenCover = useCallback((book: Book) => setSelectedBookForDetail(book), []);
  const handleOpenHighlights = useCallback((book: Book) => setSelectedBookForHighlights(book), []);
  const startReading = useCallback((id: string | number) => setBookStatus(id, 'now'), [setBookStatus]);
  const moveToReadingList = useCallback((id: string | number) => {
    setBookStatus(id, 'next');
  }, [setBookStatus]);
  const readAgain = useCallback((id: string | number) => setBookStatus(id, 'list'), [setBookStatus]);
  const confirmRemoveFromLibrary = useCallback((b: Book) => {
    const message = b.isOnDevice
      ? `Remove "${b.title}" from your books? It is also on your device, and its notes and highlights will be removed too.`
      : `Remove "${b.title}" from library?`;
    if (confirm(message)) removeBook(b.id);
  }, [removeBook]);
  const confirmRemoveFromDevice = useCallback((b: Book) => {
    if (confirm(`Remove "${b.title}" from your device? It stays in your Library.`)) toggleOnDevice(b.id, false);
  }, [toggleOnDevice]);
  const confirmRemoveFinished = useCallback((b: Book) => {
    if (confirm(`Remove "${b.title}" from your finished books? Its notes and highlights will be removed too.`)) removeBook(b.id);
  }, [removeBook]);
  const editWord = useCallback((w: WordItem) => setShowLookupModal({ open: true, existingWord: w }), []);
  const lookupAgain = useCallback((word: string) => setShowLookupModal({ open: true, initialWord: word }), []);
  const confirmDeleteWord = useCallback((w: WordItem) => {
    if (confirm(`Remove "${w.word}" from Word Garden?`)) deleteWord(w.id);
  }, [deleteWord]);
  const noStatus: BookStatus = 'list';

  return (
    <div className="rl-shell min-h-dvh flex flex-col bg-[#f5f0e6] dark:bg-[#181410] text-[#201a15] dark:text-[#f0e6d6]">
      {/* Main Container - Optimized for iPad and iPhone */}
      <main className="rl-main w-full max-w-[1140px] mx-auto px-4 sm:px-6 md:px-8 pt-6 sm:pt-8 flex flex-col gap-6">
        {/* Header: Large greeting on left, Share & Profile on right */}
        <header className="flex items-center justify-between gap-4">
          <div className="flex-1 min-w-0 pr-2">
            <h1 className="font-serif-display text-3xl sm:text-4xl md:text-5xl leading-tight text-[#201a15] dark:text-[#f0e6d6]">
              {tab === 'today' ? `Hello${state.profile.name ? `, ${state.profile.name}` : ''}` : TAB_TITLES[tab] || 'My reading life'}
            </h1>
            {tab === 'today' && (
              <p className="text-sm sm:text-base text-[#706256] dark:text-[#a89a8a] mt-1 ">
                A quiet corner, a warm cup, and {state.goal} pages.
              </p>
            )}
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            {tab === 'store' && (
              <button
                onClick={() => setCustomizing(c => !c)}
                className={`w-10 h-10 aspect-square rounded-full border bg-[#fbf7ee] dark:bg-[#231d17] text-[#2e5934] dark:text-[#86b880] flex items-center justify-center shrink-0 shadow-xs active:scale-95 transition-all hover:border-[#2e5934] dark:hover:border-[#86b880] ${customizing ? 'border-[#2e5934] dark:border-[#86b880] ring-2 ring-[#2e5934]/30' : 'border-[#e3d7c3] dark:border-[#382f25]'}`}
                title="Customize Store: reorder, hide and refresh shelves"
                aria-label="Customize Store"
                aria-pressed={customizing}
              >
                <SlidersHorizontal className="w-4 h-4 text-[#2e5934] dark:text-[#86b880]" />
              </button>
            )}
            <button
              onClick={() => setShowShareModal(true)}
              className="w-10 h-10 aspect-square rounded-full border border-[#e3d7c3] dark:border-[#382f25] bg-[#fbf7ee] dark:bg-[#231d17] text-[#2e5934] dark:text-[#86b880] flex items-center justify-center shrink-0 shadow-xs active:scale-95 transition-all hover:border-[#2e5934] dark:hover:border-[#86b880]"
              title="Share app link or open on iPhone/iPad"
              aria-label="Share app link"
            >
              <Share2 className="w-4 h-4 text-[#2e5934] dark:text-[#86b880]" />
            </button>

            <button
              onClick={() => setShowProfileModal(true)}
              className="w-11 h-11 aspect-square rounded-full border-2 border-[#e3d7c3] dark:border-[#382f25] bg-[#e8efe7] dark:bg-[#243422] text-[#2e5934] dark:text-[#86b880] flex items-center justify-center shrink-0 font-bold text-base sm:text-lg overflow-hidden shadow-xs active:scale-95 transition-all hover:ring-2 hover:ring-[#2e5934]/30"
              aria-label="Profile and Settings"
              title="Profile & Settings"
            >
              {state.profile.photo ? (
                <img src={state.profile.photo} alt="" className="w-full h-full object-cover" />
              ) : (
                <span>{(state.profile.name || '🌿').slice(0, 1).toUpperCase()}</span>
              )}
            </button>
          </div>
        </header>

        <MissingCoversButton />

        {/* Saving failed: tell the user instead of losing changes silently */}
        {saveError && (
          <div role="alert" className="flex items-start gap-2.5 p-3 rounded-xl border border-red-300 dark:border-red-900 bg-red-50 dark:bg-red-950/40 text-xs text-red-800 dark:text-red-300">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              Your changes could not be saved on this device (storage is full or blocked). Open Backup and copy your data now so nothing is lost.
            </span>
          </div>
        )}

        {/* "New version" banner: only when the code really is newer than what you are running */}
        {update.available && (
          <aside
            aria-label="App update available"
            className="fixed bottom-24 lg:bottom-6 left-1/2 -translate-x-1/2 z-50 w-max max-w-[calc(100vw-24px)] px-4 py-3 rounded-2xl bg-[#201a15] dark:bg-[#2e261f] text-[#f0e6d6] shadow-2xl flex flex-wrap items-center justify-center gap-x-3 gap-y-2 border border-[#382f25]"
          >
            <Sparkles className="w-4 h-4 text-emerald-400 animate-pulse shrink-0" />
            <span className="text-xs font-medium">New version ready</span>
            <button
              onClick={applyUpdate}
              className="px-3 py-1 rounded-xl bg-[#2e5934] hover:bg-[#244729] text-white text-xs font-semibold shadow-sm transition-all active:scale-95 shrink-0"
            >
              Update now
            </button>
            <button onClick={dismissUpdate} className="px-2 py-1 text-xs text-white/70 hover:text-white shrink-0" aria-label="Not now">
              Later
            </button>
          </aside>
        )}

        {/* Reading nook: window, shelves of your real covers, coffee & growing plants */}
        {visitedTabs.has('today') && (
        <TabPane active={tab === 'today'}>
        <ReadingScene
          books={sceneBooks}
          streak={currentStreak}
          todayPages={todayPages}
          goal={state.goal}
          garden={state.garden}
          dailyLog={state.dailyLog}
          onOpenBook={setSelectedBookForDetail}
        />
        </TabPane>
        )}

        {/* Tab 1: TODAY VIEW */}
        {visitedTabs.has('today') && (
        <TabPane active={tab === 'today'}>
          <div className="flex flex-col gap-6">
            <p className="text-sm text-[#706256] dark:text-[#a89a8a] ">
              {state.goal} pages a day is the whole goal. Keep going if you're enjoying it, stop if you're not.
            </p>

            {/* iPad / Desktop Split: Left Dashboard & Right Now Reading */}
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-start">
              {/* Left Column: Progress Ring & Daily Goal & Intention */}
              <div className="md:col-span-5 flex flex-col gap-4">
                {/* Daily Goal Card */}
                <div className="p-6 rounded-2xl bg-[#fbf7ee] dark:bg-[#231d17] border border-[#e3d7c3] dark:border-[#382f25] border-l-4 border-l-[#2e5934] shadow-sm flex flex-col gap-4">
                  <div className="flex items-center gap-5">
                    <div>
                      <span className="font-serif-display text-5xl leading-none text-[#2e5934] dark:text-[#86b880]">
                        {todayPages}
                      </span>
                      <span className="text-xs text-[#706256] dark:text-[#a89a8a] block mt-1">pages today</span>
                    </div>

                    <div className="flex-1 flex flex-col gap-2">
                      <div className="w-full h-3 rounded-full bg-[#e3d7c3] dark:bg-[#382f25] overflow-hidden">
                        <div
                          className="h-full bg-[#2e5934] dark:bg-[#86b880] transition-all duration-500 rounded-full"
                          style={{ width: `${Math.min(100, (todayPages * 100) / state.goal)}%` }}
                        />
                      </div>
                      <div className="text-xs text-[#706256] dark:text-[#a89a8a]">
                        {todayPages >= state.goal
                          ? 'Goal reached. Anything more is a bonus.'
                          : `${state.goal - todayPages} more to hit today's goal`} · {currentStreak}-day streak
                      </div>
                    </div>
                  </div>

                  <DayStrip days={last7Days} onSetPages={setDayPages} />
                </div>

                {/* Reading Intention Card */}
                <div className="p-5 rounded-2xl bg-[#fbf7ee] dark:bg-[#231d17] border border-[#e3d7c3] dark:border-[#382f25] border-l-4 border-l-[#925838] shadow-sm flex flex-col gap-2">
                  <label className="text-xs font-bold uppercase tracking-wider text-[#925838] dark:text-[#d89e70] font-sans">
                    My Reading Intention
                  </label>
                  <textarea
                    value={state.readingIntention}
                    onChange={e => updateIntention(e.target.value)}
                    rows={2}
                    placeholder="What are you hoping to find in books right now?"
                    className="w-full bg-transparent text-sm italic  text-[#201a15] dark:text-[#f0e6d6] focus:outline-none resize-none leading-relaxed"
                  />
                </div>
              </div>

              {/* Right Column: Currently Reading Books */}
              <div className="md:col-span-7 flex flex-col gap-4">
                <h2 className="font-serif-display text-2xl text-[#201a15] dark:text-[#f0e6d6]">
                  Reading now
                </h2>

                {nowReadingBooks.length === 0 ? (
                  <div className="p-8 rounded-2xl bg-[#fbf7ee] dark:bg-[#231d17] border border-[#e3d7c3] dark:border-[#382f25] text-center text-[#706256] dark:text-[#a89a8a] text-sm">
                    Nothing in progress. Open the Library or Book Store to choose your first book.
                  </div>
                ) : (
                  nowReadingBooks.map(b => (
                    <NowReadingCard
                      key={b.id}
                      book={b}
                      currentPage={state.currentPage[String(b.id)] || 0}
                      totalPages={state.totalPages[String(b.id)] || b.pageCount || 0}
                      highlightCount={(state.highlights[String(b.id)] || []).length}
                      note={state.notes[String(b.id)] || ''}
                      onOpen={handleOpenCover}
                      onProgress={updateBookProgress}
                      onStatus={setBookStatus}
                      onQuotes={handleOpenHighlights}
                      onNote={updateBookNote}
                    />
                  ))
                )}

                {/* Up Next List */}
                <div className="mt-4 flex flex-col gap-3">
                  <h3 className="font-serif-display text-xl text-[#201a15] dark:text-[#f0e6d6]">
                    Up next
                  </h3>
                  {upNextBooks.length === 0 ? (
                    <div className="p-4 rounded-xl bg-[#fbf7ee] dark:bg-[#231d17] border border-[#e3d7c3] dark:border-[#382f25] text-center text-xs text-[#706256] dark:text-[#a89a8a]">
                      Pick up to three books to read next.
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {upNextBooks.map(b => (
                        <UpNextCard key={b.id} book={b} onOpen={handleOpenCover} onStart={startReading} />
                      ))}
                    </div>
                  )}
                  {upNextBooks.length > 3 && (
                    <p className="text-xs text-[#706256] dark:text-[#a89a8a] italic">
                      That's more than three. A shorter Next list is easier to actually start.
                    </p>
                  )}
                </div>

                <div className="text-xs text-[#706256] dark:text-[#a89a8a] mt-2">
                  Books finished so far: <b>{finishedCount}</b>
                </div>
              </div>
            </div>
          </div>
        </TabPane>
        )}

        {/* Tab 2: BOOK STORE VIEW */}
        {visitedTabs.has('store') && (
        <TabPane active={tab === 'store'}>
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-serif-display text-2xl sm:text-3xl text-[#201a15] dark:text-[#f0e6d6]">
                  Book Store
                </h2>
                <p className="text-xs sm:text-sm text-[#706256] dark:text-[#a89a8a]">
                  Browse popular works, prize winners, and discover new books. Tap any cover to see author, year &amp; page details.
                </p>
              </div>

              <button
                onClick={() => setShowAddBookModal({ open: true, isDevice: false })}
                className="flex px-4 py-2 rounded-xl text-xs font-semibold bg-[#2e5934] text-white hover:bg-[#244729] items-center gap-1.5 shadow-sm shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>Add Book</span>
              </button>
            </div>

            {customizing ? (
              <StoreCustomize
                order={shelfOrder}
                hidden={hiddenShelves}
                onReorder={reorderShelves}
                onToggle={id => updateStorePrefs(toggleShelf(storePrefs, id, !!SHELF_BY_ID[id]?.defaultHidden))}
                onDone={() => { updateStorePrefs({ ...storePrefs, order: shelfOrder }); setCustomizing(false); }}
                onResetLayout={() => updateStorePrefs(NO_PREFS)}
              />
            ) : (
              <>
              {/* Search Input */}
              <div className="relative">
                <Search className="w-4 h-4 text-[#706256] dark:text-[#a89a8a] absolute left-3.5 top-3.5 pointer-events-none" />
                <input
                  type="search"
                  value={storeSearchQuery}
                  onChange={e => setStoreSearchQuery(e.target.value)}
                  placeholder="Search by title, author, or keyword in online catalog"
                  className="w-full pl-10 pr-4 py-3 rounded-xl bg-[#fbf7ee] dark:bg-[#231d17] border border-[#e3d7c3] dark:border-[#382f25] text-sm focus:outline-none focus:ring-2 focus:ring-[#2e5934]"
                />
              </div>

              {/* Search Results if query present */}
              {storeSearchQuery.trim() && (
                <div className="flex flex-col gap-3">
                  <span className="text-xs font-bold uppercase tracking-wider text-[#706256] dark:text-[#a89a8a]">
                    {isStoreSearching ? 'Searching Online…' : `Search Results (${storeSearchResults.length})`}
                  </span>

                  {storeSearchResults.length === 0 && !isStoreSearching ? (
                    <div className="p-8 text-center text-sm text-[#706256] dark:text-[#a89a8a] bg-[#fbf7ee] dark:bg-[#231d17] rounded-xl border border-[#e3d7c3] dark:border-[#382f25]">
                      No books found. Check the title spelling or use the Add Book button to add manually.
                    </div>
                  ) : (
                    <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                      {storeSearchResults.map(b => (
                        <div key={b.id} className="flex flex-col gap-2">
                          <button
                            type="button"
                            onClick={() => handleOpenCover(b)}
                            className="book-cover-3d w-full aspect-[2/3] rounded-md text-left p-2.5 flex flex-col justify-between text-white overflow-hidden"
                            style={{ backgroundColor: b.spineColor || '#2e5934' }}
                          >
                            <CoverFace book={b} size="md" />
                          </button>
                          <h4
                            onClick={() => handleOpenCover(b)}
                            className="font-serif-display text-sm leading-tight text-[#201a15] dark:text-[#f0e6d6] line-clamp-2 hover:underline cursor-pointer"
                          >
                            {b.title}
                          </h4>
                          <div className="text-xs text-[#706256] dark:text-[#a89a8a] truncate">{b.author}</div>
                          <button
                            onClick={() => handleOpenCover(b)}
                            className="mt-1 py-1.5 px-3 rounded-lg text-xs font-semibold bg-[#2e5934] text-white hover:bg-[#244729] text-center"
                          >
                            View Details
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Shelves, in the reader's own order (Customize Store). Hidden shelves are not drawn, so they also load nothing. */}
              {shelfOrder.filter(id => !hiddenShelves.includes(id)).map(id => {
                const def = SHELF_BY_ID[id];
                if (def.library) {
                  const books = def.library === 'prize' ? prizeBooks : easyBooks;
                  const title = def.library === 'prize' ? (
                    <>
                      <Award className="w-5 h-5 text-amber-500" />
                      <span>Prize winners from your lists</span>
                    </>
                  ) : def.title;
                  return <StoreShelf key={id} id={id} title={title} books={books} onOpen={handleOpenCover} />;
                }
                return <StoreShelf key={id} id={id} title={def.title} source={def.source} ranked={def.ranked} lazy={def.lazy} hideIfUnavailable={def.hideIfUnavailable} onOpen={handleOpenCover} />;
              })}
              <p className="text-xs text-[#706256] dark:text-[#a89a8a]">Bestsellers from The New York Times. Covers and ratings from Open Library, Google Books and Apple Books readers.</p>
              </>
            )}
          </div>
        </TabPane>
        )}

        {/* Tab 3: LIBRARY VIEW */}
        {visitedTabs.has('lib') && (
        <TabPane active={tab === 'lib'}>
          <div className="flex flex-col gap-6">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="font-serif-display text-2xl sm:text-3xl text-[#201a15] dark:text-[#f0e6d6]">
                  Library
                </h2>
                <p className="text-xs sm:text-sm text-[#706256] dark:text-[#a89a8a]">
                  Your reading list. Finished books move to On my device. Tap any cover to see author, year &amp; page count.
                </p>
              </div>

              <button
                onClick={() => setShowAddBookModal({ open: true, isDevice: false })}
                className="px-4 py-2 rounded-xl text-xs font-semibold bg-[#2e5934] text-white hover:bg-[#244729] flex items-center gap-1.5 shadow-sm"
              >
                <Plus className="w-4 h-4" />
                <span>Add Book</span>
              </button>
            </div>

            {/* Filter Chips */}
            <div className="flex flex-wrap gap-2 text-xs">
              {[
                ['f', 'First 12'],
                ['heal', '🧠 Heal'],
                ['love', '💕 Love'],
                ['life', '🌱 Life at 30'],
                ['joy', '✨ Joy'],
                ['prize', '🌷 Prize winners'],
                ['world', '🌍 World'],
                ['art', '🎵 Art & music'],
                ['aw', '🏆 Prize winners'],
                ['s', 'New suggestions'],
                ['fic', '📖 Fiction'],
                ['nf', '🧭 Non-fiction'],
                ['all', 'All Books'],
              ].map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setLibFilter(k)}
                  className={`px-3.5 py-1.5 rounded-full border text-xs font-semibold transition-all ${
                    libFilter === k
                      ? 'bg-[#2e5934] text-white border-[#2e5934]'
                      : 'bg-[#fbf7ee] dark:bg-[#231d17] border-[#e3d7c3] dark:border-[#382f25] text-[#706256] dark:text-[#a89a8a] hover:text-[#201a15]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Book Cards Grid - Responsive for iPad and iPhone */}
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredLibraryBooks.map(b => (
                <LibraryCard
                  key={b.id}
                  book={b}
                  status={state.status[String(b.id)] || noStatus}
                  highlightCount={(state.highlights[String(b.id)] || []).length}
                  onOpen={handleOpenCover}
                  onQuotes={handleOpenHighlights}
                  onStatus={setBookStatus}
                  onRemove={confirmRemoveFromLibrary}
                />
              ))}
            </div>
          </div>
        </TabPane>
        )}

        {/* Tab 4: WORD GARDEN VIEW */}
        {visitedTabs.has('words') && (
        <TabPane active={tab === 'words'}>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-serif-display text-2xl sm:text-3xl text-[#201a15] dark:text-[#f0e6d6]">
                  Word Garden
                </h2>
                <p className="text-xs sm:text-sm text-[#706256] dark:text-[#a89a8a]">
                  Words you've discovered while reading. Look up meanings instantly using Apple Books dictionary.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowLookupModal({ open: true })}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-[#2e5934] text-white hover:bg-[#244729] flex items-center gap-1.5 shadow-sm"
                >
                  <Search className="w-3.5 h-3.5" />
                  <span>Look up a word</span>
                </button>
                <button
                  onClick={() => setShowWordPracticeModal(true)}
                  className="px-3.5 py-2 rounded-xl text-xs font-semibold border border-[#2e5934] text-[#2e5934] dark:text-[#86b880] hover:bg-[#2e5934]/10"
                >
                  Quiz Me
                </button>
                <button
                  onClick={() => setShowBulkModal({ open: true, type: 'words' })}
                  className="px-3 py-2 rounded-xl text-xs font-semibold border border-[#e3d7c3] dark:border-[#382f25] text-[#706256] dark:text-[#a89a8a] hover:bg-black/5"
                >
                  Paste Words
                </button>
              </div>
            </div>

            {/* Word Search and Filters */}
            <div className="flex flex-col sm:flex-row gap-3 items-center">
              <div className="relative w-full sm:flex-1">
                <Search className="w-4 h-4 text-[#706256] dark:text-[#a89a8a] absolute left-3 top-3 pointer-events-none" />
                <input
                  type="search"
                  value={wordSearchQuery}
                  onChange={e => setWordSearchQuery(e.target.value)}
                  placeholder="Search discovered words or meanings…"
                  className="w-full pl-9 pr-4 py-2 bg-[#fbf7ee] dark:bg-[#231d17] border border-[#e3d7c3] dark:border-[#382f25] text-xs rounded-xl focus:outline-none"
                />
              </div>

              <div className="flex gap-2 w-full sm:w-auto">
                <button
                  onClick={() => setWordFilter('all')}
                  className={`flex-1 sm:flex-none px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                    wordFilter === 'all'
                      ? 'bg-[#2e5934] text-white border-[#2e5934]'
                      : 'border-[#e3d7c3] dark:border-[#382f25] bg-[#fbf7ee] dark:bg-[#231d17] text-[#706256] dark:text-[#a89a8a]'
                  }`}
                >
                  All ({state.words.length})
                </button>
                <button
                  onClick={() => setWordFilter('learning')}
                  className={`flex-1 sm:flex-none px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                    wordFilter === 'learning'
                      ? 'bg-[#2e5934] text-white border-[#2e5934]'
                      : 'border-[#e3d7c3] dark:border-[#382f25] bg-[#fbf7ee] dark:bg-[#231d17] text-[#706256] dark:text-[#a89a8a]'
                  }`}
                >
                  Learning ({state.words.filter(w => !w.isLearned).length})
                </button>
                <button
                  onClick={() => setWordFilter('learned')}
                  className={`flex-1 sm:flex-none px-3.5 py-1.5 rounded-full text-xs font-semibold border transition-all ${
                    wordFilter === 'learned'
                      ? 'bg-[#2e5934] text-white border-[#2e5934]'
                      : 'border-[#e3d7c3] dark:border-[#382f25] bg-[#fbf7ee] dark:bg-[#231d17] text-[#706256] dark:text-[#a89a8a]'
                  }`}
                >
                  Learned ({state.words.filter(w => w.isLearned).length})
                </button>
              </div>
            </div>

            {canAddSearchedWord && (
              <button
                type="button"
                onClick={() => lookupAgain(searchedWord)}
                className="w-full flex items-center justify-center gap-2 px-4 py-3 rounded-xl border border-dashed border-[#2e5934] text-[#2e5934] dark:text-[#86b880] dark:border-[#86b880] bg-[#2e5934]/5 hover:bg-[#2e5934]/10 text-sm font-semibold active:scale-[0.99] transition-all"
              >
                <Plus className="w-4 h-4 shrink-0" />
                <span className="truncate">Add “{searchedWord}” to Word Garden</span>
              </button>
            )}

            {/* Word Cards Grid */}
            {filteredWords.length === 0 ? (
              <div className="p-12 text-center text-[#706256] dark:text-[#a89a8a] bg-[#fbf7ee] dark:bg-[#231d17] rounded-2xl border border-[#e3d7c3] dark:border-[#382f25]">
                <Sprout className="w-8 h-8 mx-auto mb-2 text-[#2e5934] opacity-70" />
                <p className="text-sm font-medium">{canAddSearchedWord ? `“${searchedWord}” is not in your garden yet. Tap the button above to add it.` : 'No words found. Tap "Look up a word" to add your first discovery!'}</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredWords.map(w => (
                  <WordCard
                    key={w.id}
                    word={w}
                    onEdit={editWord}
                    onLookup={lookupAgain}
                    onToggleLearned={toggleWordLearned}
                    onDelete={confirmDeleteWord}
                  />
                ))}
              </div>
            )}
          </div>
        </TabPane>
        )}

        {/* Tab 5: ON MY DEVICE VIEW */}
        {visitedTabs.has('dev') && (
        <TabPane active={tab === 'dev'}>
          <div className="flex flex-col gap-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <h2 className="font-serif-display text-2xl sm:text-3xl text-[#201a15] dark:text-[#f0e6d6]">
                  On my device
                </h2>
                <p className="text-xs sm:text-sm text-[#706256] dark:text-[#a89a8a]">
                  Books you keep on your device, plus everything you've finished. A book can be here and in your Library at once.
                </p>
              </div>

              <div className="flex items-center gap-2">
                <button
                  onClick={() => setShowAddBookModal({ open: true, isDevice: true })}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-[#2e5934] text-white hover:bg-[#244729] flex items-center gap-1.5 shadow-sm"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>Add to Device</span>
                </button>
                <button
                  onClick={() => setShowBulkModal({ open: true, type: 'books' })}
                  className="px-3.5 py-2 rounded-xl text-xs font-semibold border border-[#e3d7c3] dark:border-[#382f25] text-[#706256] dark:text-[#a89a8a] hover:bg-black/5"
                >
                  Paste List
                </button>
              </div>
            </div>

            {/* Total Books on Device counter */}
            <div className="flex items-center gap-2 text-xs text-[#706256] dark:text-[#a89a8a]">
              <span><b>{onDeviceBooks.length + finishedBooks.length}</b> books on device{finishedBooks.length > 0 ? ` (${finishedBooks.length} finished)` : ''}</span>
              <span>·</span>
              {devicePages.known > 0 && (
                <span>
                  <b>{devicePages.known.toLocaleString()}</b> total pages
                  {devicePages.unknown > 0 ? ` (${devicePages.unknown} ${devicePages.unknown === 1 ? 'book' : 'books'} without a page count)` : ''}
                </span>
              )}
            </div>

            {onDeviceBooks.length === 0 && finishedBooks.length === 0 ? (
              <div className="p-12 text-center text-[#706256] dark:text-[#a89a8a] bg-[#fbf7ee] dark:bg-[#231d17] rounded-2xl border border-[#e3d7c3] dark:border-[#382f25] flex flex-col items-center gap-3">
                <Smartphone className="w-10 h-10 text-[#2e5934] opacity-70" />
                <div>
                  <h4 className="font-serif-display text-lg text-[#201a15] dark:text-[#f0e6d6]">
                    Nothing on your device yet
                  </h4>
                  <p className="text-xs mt-1">
                    Tap "Add to Device" or "Paste List" to add books you already own to your device shelf.
                  </p>
                </div>
                <button
                  onClick={() => setShowAddBookModal({ open: true, isDevice: true })}
                  className="mt-2 px-4 py-2 rounded-xl text-xs font-semibold bg-[#2e5934] text-white"
                >
                  + Add a Book to Device
                </button>
              </div>
            ) : (
              <>
                {onDeviceBooks.length > 0 && (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {onDeviceBooks.map(b => (
                      <DeviceCard
                        key={b.id}
                        book={b}
                        status={state.status[String(b.id)] || noStatus}
                        highlightCount={(state.highlights[String(b.id)] || []).length}
                        onOpen={handleOpenCover}
                        onQuotes={handleOpenHighlights}
                        onMoveToList={moveToReadingList}
                        onRemoveFromDevice={confirmRemoveFromDevice}
                        onReadAgain={readAgain}
                      />
                    ))}
                  </div>
                )}
                {finishedBooks.length > 0 && (
                  <section className="flex flex-col gap-3" aria-label="Finished books">
                    <h3 className="font-serif-display text-xl text-[#201a15] dark:text-[#f0e6d6]">Finished ({finishedBooks.length})</h3>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                      {finishedBooks.map(b => (
                        <DeviceCard
                          key={b.id}
                          book={b}
                          finished
                          status="done"
                          highlightCount={(state.highlights[String(b.id)] || []).length}
                          onOpen={handleOpenCover}
                          onQuotes={handleOpenHighlights}
                          onMoveToList={moveToReadingList}
                          onRemoveFromDevice={confirmRemoveFinished}
                          onReadAgain={readAgain}
                        />
                      ))}
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </TabPane>
        )}

        {/* Footer: Cozy footer with perfectly rounded Backup & Refresh buttons */}
        <footer className="mt-8 pt-6 pb-24 sm:pb-16 border-t border-[#e3d7c3]/60 dark:border-[#382f25]/60 flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#706256] dark:text-[#a89a8a]">
          <div className="flex items-center gap-2">
            <span className="italic font-medium">GreatReads</span>
            <span>·</span>
            <span>A quiet corner for your books</span>
          </div>

          <div className="flex items-center gap-3">
            {tab === 'store' && (
              <button
                onClick={() => setCustomizing(c => !c)}
                className={`w-10 h-10 aspect-square rounded-full border bg-[#fbf7ee] dark:bg-[#231d17] text-[#2e5934] dark:text-[#86b880] flex items-center justify-center shrink-0 shadow-xs active:scale-95 transition-all hover:border-[#2e5934] dark:hover:border-[#86b880] ${customizing ? 'border-[#2e5934] dark:border-[#86b880] ring-2 ring-[#2e5934]/30' : 'border-[#e3d7c3] dark:border-[#382f25]'}`}
                title="Customize Store: reorder, hide and refresh shelves"
                aria-label="Customize Store"
                aria-pressed={customizing}
              >
                <SlidersHorizontal className="w-4 h-4 text-[#2e5934] dark:text-[#86b880]" />
              </button>
            )}
            <button
              onClick={() => setShowBackupModal(true)}
              className="w-10 h-10 aspect-square rounded-full border border-[#e3d7c3] dark:border-[#382f25] bg-[#fbf7ee] dark:bg-[#231d17] text-[#2e5934] dark:text-[#86b880] flex items-center justify-center shrink-0 shadow-xs active:scale-95 transition-all hover:border-[#2e5934] dark:hover:border-[#86b880]"
              title="Backup and Export reading data"
              aria-label="Backup and export reading data"
            >
              <Download className="w-4 h-4 text-[#2e5934] dark:text-[#86b880]" />
            </button>

            <button
              onClick={() => restartApp()}
              className="w-10 h-10 aspect-square rounded-full border border-[#e3d7c3] dark:border-[#382f25] bg-[#fbf7ee] dark:bg-[#231d17] text-[#2e5934] dark:text-[#86b880] flex items-center justify-center shrink-0 shadow-xs active:scale-95 transition-all hover:border-[#2e5934] dark:hover:border-[#86b880]"
              title="Restart app & refresh all cached covers"
              aria-label="Restart app & refresh covers"
            >
              <RotateCcw className="w-4 h-4 text-[#2e5934] dark:text-[#86b880]" />
            </button>
          </div>
        </footer>
      </main>

      {/* Floating tab bar (phone + iPad portrait) / side rail (iPad landscape + desktop) */}
      <nav
        aria-label="Main"
        className="rl-nav fixed z-40 bg-[#fbf7ee]/90 dark:bg-[#231d17]/90 backdrop-blur-xl border border-[#e3d7c3] dark:border-[#382f25] shadow-xl"
      >
        {([
          { id: 'today', label: 'Today', Icon: BookOpen },
          { id: 'store', label: 'Store', Icon: ShoppingBag },
          { id: 'lib', label: 'Library', Icon: Library },
          { id: 'words', label: 'Words', Icon: Sprout },
          { id: 'dev', label: 'Device', Icon: Smartphone },
        ] as const).map(({ id, label, Icon }) => (
          <button
            key={id}
            type="button"
            aria-current={tab === id ? 'page' : undefined}
            onClick={() => {
              goTab(id);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            className={`rl-tab ${tab === id ? 'is-active' : ''}`}
          >
            <Icon className="rl-tab-icon" strokeWidth={tab === id ? 2.2 : 1.8} />
            <span className="rl-tab-label">{label}</span>
            {id === 'dev' && onDeviceBooks.length + finishedBooks.length > 0 && <i className="rl-tab-dot" aria-hidden="true" />}
          </button>
        ))}
      </nav>

      {/* Modal 1: Apple Books Detail Modal (when tapping any book cover) */}
      {selectedBookForDetail && (
        <AppleBookDetailModal
          book={selectedBookForDetail}
          inLibrary={libraryBooks.some(b => b.id === selectedBookForDetail.id)}
          onDevice={allBooks.some(b => b.id === selectedBookForDetail.id && (b.isOnDevice || state.status[String(b.id)] === 'done'))}
          readingStatus={state.status[String(selectedBookForDetail.id)]}
          currentPage={state.currentPage[String(selectedBookForDetail.id)]}
          totalPages={state.totalPages[String(selectedBookForDetail.id)]}
          note={state.notes[String(selectedBookForDetail.id)]}
          highlightsCount={(state.highlights[String(selectedBookForDetail.id)] || []).length}
          onClose={() => setSelectedBookForDetail(null)}
          onAddToLibrary={b => {
            addBook(b, 'library');
          }}
          onAddToDevice={b => {
            addBook(b, 'device');
          }}
          onOpenHighlights={() => {
            const b = selectedBookForDetail;
            setSelectedBookForDetail(null);
            setSelectedBookForHighlights(b);
          }}
        />
      )}

      <Suspense fallback={null}>
      {/* Modal 2: Apple Look Up Modal */}
      {showLookupModal.open && (
        <AppleLookUpModal
          initialWord={showLookupModal.initialWord}
          existingWordItem={showLookupModal.existingWord}
          books={allBooks}
          onClose={() => setShowLookupModal({ open: false })}
          onSaveWord={w => {
            addWord(w);
          }}
        />
      )}

      {/* Modal 3: Add Book Modal */}
      {showAddBookModal.open && (
        <AddBookModal
          initialIsDevice={showAddBookModal.isDevice}
          onClose={() => setShowAddBookModal({ open: false, isDevice: false })}
          onAddBook={(newBook, dest) => {
            addBook(newBook, dest);
          }}
        />
      )}

      {/* Modal 4: Highlights / Quotes Modal */}
      {selectedBookForHighlights && (
        <HighlightsModal
          book={selectedBookForHighlights}
          highlights={state.highlights[String(selectedBookForHighlights.id)] || []}
          onClose={() => setSelectedBookForHighlights(null)}
          onAddHighlight={(txt, pg) => {
            addHighlight(selectedBookForHighlights.id, txt, pg);
          }}
          onUpdateHighlight={(hlId, txt, pg) => {
            updateHighlight(selectedBookForHighlights.id, hlId, txt, pg);
          }}
          onDeleteHighlight={hlId => {
            deleteHighlight(selectedBookForHighlights.id, hlId);
          }}
        />
      )}

      {/* Modal 5: Profile & Settings Modal */}
      {showProfileModal && (
        <ProfileModal
          profile={state.profile}
          goal={state.goal}
          hiddenCount={Object.keys(state.hiddenBookIds).length}
          stats={stats}
          garden={state.garden}
          onMovePlant={movePlant}
          onClose={() => setShowProfileModal(false)}
          onUpdateProfile={updateProfile}
          onUpdateGoal={setGoal}
          onRestoreHidden={restoreHiddenBooks}
          onExportBackup={exportBackup}
          onImportBackup={importBackup}
          onOpenBackupModal={() => setShowBackupModal(true)}
        />
      )}

      {/* Modal 6: Word Practice / Quiz Modal */}
      {showWordPracticeModal && (
        <WordPracticeModal
          words={state.words}
          onClose={() => setShowWordPracticeModal(false)}
          onMarkLearned={id => setWordLearned(id, true)}
        />
      )}

      {/* Modal 7: Bulk Import Modal */}
      {showBulkModal.open && (
        <BulkImportModal
          type={showBulkModal.type}
          onClose={() => setShowBulkModal({ open: false, type: 'books' })}
          onAddBooks={(books, isDev) => {
            books.forEach(b => addBook(b, isDev ? 'device' : 'library'));
          }}
          onAddWords={entries => {
            entries.forEach(e => {
              addWord({
                id: `bulk_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                word: e.word,
                definition: e.definition || 'Definition added from list.',
                isLearned: false,
                addedAt: Date.now(),
              });
            });
          }}
        />
      )}

      {/* Modal 8: Backup & Restore Modal */}
      {showBackupModal && (
        <BackupModal
          isOpen
          onClose={() => setShowBackupModal(false)}
          onExportBackup={exportBackup}
          onImportBackup={importBackup}
          onClearLibrary={clearLibrary}
          onClearOnDevice={clearOnDevice}
          onResetEverything={resetEverything}
        />
      )}

      {/* New plant prompt (one at a time) */}
      {plantQueue.length > 0 && (
        <PlantCelebration
          plantId={plantQueue[0]}
          garden={state.garden}
          onClose={() => setPlantQueue(q => q.slice(1))}
        />
      )}

      {/* Modal 9: Share Link & QR Code Modal */}
      {showShareModal && <ShareModal isOpen onClose={() => setShowShareModal(false)} />}
      </Suspense>
    </div>
  );
}
