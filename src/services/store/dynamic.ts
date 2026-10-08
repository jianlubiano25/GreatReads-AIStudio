import type { Book } from '../../types';
import { CURATED_SHELVES, type CuratedShelf } from '../../data/storeCatalog';
import { persistentCache } from '../books/cache';
import { dedupeInflight, getJson, pool } from '../books/http';
import { authorKey, isUnknownAuthor, titleKey } from '../books/identity';
import { shrunkRating } from '../books/model';
import { isExplicit } from '../books/quality';
import { searchOpenLibrary } from '../books/sources/openLibrary';
import type { Hit } from '../books/sources/types';
import { READER_CAPS, recencyValue } from './collate';
import { curatedSource } from './curated';
import type { RefreshResult, ShelfInfo, ShelfSource } from './shelves';
import { cleanAuthorName, cleanTitle, fetchWikiPicks, splitPairedTitle, type ColumnRule } from './wikiLists';

/**
 * Curated shelves whose book list refreshes itself.
 *
 * A shelf keeps its hand-picked list (storeSeeds.json) as the floor. When a shelf has a DynamicSpec, the Store asks the spec's
 * source for a fresh list once the saved one is older than `refreshMs`, saves it, and shows it. Everything after that is the
 * existing pipeline: the fresh [title, author] pairs go through the same resolver (covers, ratings, identity, de-duplication)
 * and the same caches as any curated shelf.
 *
 * If a source fails, or answers with too few books, nothing changes: the last saved list stays on the shelf (however old),
 * and with none saved the hand-picked list does. A failed refresh is not retried for an hour.
 *
 * Nothing here ranks books and calls it official. Prize / club shelves are the published picks from a public record, labelled
 * by the source's own dates; genre shelves are "recent and widely read" from Open Library reader data, and say nothing more.
 */

type Seed = [string, string, string?];
export interface Fresh {
  seeds: Seed[];
  /** replaces the shelf title (e.g. "New in 2027") */
  title?: string;
  /** The club's / prize's own page answered (as opposed to a public-record stand-in). Only a spec that has both sets it. */
  official?: boolean;
}

export interface DynamicSpec {
  /** Where the list comes from (for the docs and the check script) */
  source: string;
  refreshMs: number;
  /** A fresh list shorter than this is rejected as a failed refresh */
  minSeeds: number;
  fetch: (shelf: CuratedShelf, signal?: AbortSignal) => Promise<Fresh | null>;
  /** The heading, when it depends on the date */
  title?: (now: Date) => string;
  /** What kind of data this is, for Customize Store: a public record standing in for an official list, or GreatReads' own discovery */
  kind?: 'official' | 'fallback' | 'generated';
  /** For an 'official' spec that falls back to a public record: where that fallback reads from (shown when it was used) */
  fallbackSource?: string;
  /**
   * 'append': a refresh ADDS the newly published picks in front of what the shelf already has (book clubs and prizes keep
   * their history and grow). Default: the fresh list replaces the old one (discovery shelves, which show what is popular now).
   */
  merge?: 'append';
  /** The most books an appending shelf keeps (the oldest fall off the end) */
  cap?: number;
}

interface Saved { seeds: Seed[]; title?: string; /** the last refresh came from the official page (specs that have a fallback) */ official?: boolean; /** last SUCCESSFUL refresh */ at: number; /** last attempt, successful or not (only used to space retries) */ tried: number }

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
export const RETRY_MS = HOUR;
const store = persistentCache<Saved>('readlife.dynseeds1', { ttl: 400 * DAY, max: 30 });
/** How the last attempt to refresh each shelf ended (kept apart from the saved list, which only ever changes on success). */
const attempts = persistentCache<{ at: number; ok: boolean }>('readlife.dynstatus1', { ttl: 60 * DAY, max: 40 });

/**
 * The saved list for a shelf, cleaned on the way out. Book clubs and prizes only ever ADD to their saved list, so a name that was
 * saved with Wikipedia's footnote marks or "(US)" notes would otherwise stay on the shelf (and fail every cover search) for good.
 * Cleaning at the door repairs lists saved by an earlier version without losing any of their books.
 */
const saved = {
  get(id: string): Saved | undefined {
    const s = store.get(id);
    return s ? { ...s, seeds: cleanSeeds(s.seeds) } : undefined;
  },
  set(id: string, value: Saved) { store.set(id, value); },
};

/* ------------------------------ the refresh engine ------------------------------ */

/** Remove unusable entries and repeats; keeps the source's order. */
const WIKI_JUNK = /\b(?:first|last|dab|nolink|sort)\s*=|[{}|]/i;

export function cleanSeeds(seeds: Seed[]): Seed[] {
  const seen = new Set<string>();
  const out: Seed[] = [];
  for (const seed of seeds) {
    if (!Array.isArray(seed) || typeof seed[0] !== 'string' || typeof seed[1] !== 'string') continue;
    const title = cleanTitle(seed[0]);
    const author = cleanAuthorName(seed[1]);
    if (!title || !author || isUnknownAuthor(author)) continue;
    if (WIKI_JUNK.test(author) || WIKI_JUNK.test(title)) continue; // wiki markup that never became text ("last=Smith first=Ann")
    const k = `${titleKey(title)}|${authorKey(author)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(seed[2] === undefined ? [title, author] : [title, author, seed[2]]);
  }
  return out;
}

export const isDue = (s: Saved | undefined, spec: Pick<DynamicSpec, 'refreshMs'>, now = Date.now()) =>
  !s || (now - s.at >= spec.refreshMs && now - s.tried >= RETRY_MS);

const withSeeds = (shelf: CuratedShelf, s?: Saved): CuratedShelf => (s ? { ...shelf, seeds: cleanSeeds(s.seeds) } : shelf); // cleaned on the way out too: a bad entry saved by an older version goes without waiting for a refresh

/** At most two source requests at once across every shelf, so refreshing several shelves in a row cannot trip a rate limit. */
const politely = pool(2);
export const APPEND_CAP = 36;

/** What an appending shelf becomes: the source's newest picks first, then everything the shelf already had. */
export function mergeAppend(found: Seed[], existing: Seed[], cap = APPEND_CAP): Seed[] {
  // A pick the source dates again keeps its fresh label (first wins). A title is one pick: the same book saved earlier with its author
  // spelled differently (or wrongly) is replaced by the fresh one instead of showing twice.
  const seen = new Set<string>();
  return cleanSeeds([...found, ...existing]).filter(([t]) => { const k = titleKey(t); return seen.has(k) ? false : (seen.add(k), true); }).slice(0, cap);
}

/** Ask the source for a fresh list and save it. Returns the saved list, or null when nothing better than before was found. */
export async function refreshShelf(shelf: CuratedShelf, spec: DynamicSpec, now = Date.now()): Promise<Saved | null> {
  const old = saved.get(shelf.id);
  let fresh: Fresh | null = null;
  try { fresh = await politely(() => spec.fetch(shelf)); } catch { /* a source failing is routine */ }
  const found = fresh ? cleanSeeds(fresh.seeds) : [];
  if (found.length < spec.minSeeds) {
    attempts.set(shelf.id, { at: now, ok: false });
    if (old) saved.set(shelf.id, { ...old, tried: now }); // keep the stale list; try again in an hour
    return null;
  }
  attempts.set(shelf.id, { at: now, ok: true });
  const seeds = spec.merge === 'append'
    ? mergeAppend(found, old?.seeds ?? shelf.seeds, spec.cap)
    : found.slice(0, Math.max(shelf.seeds.length, 12));
  const next: Saved = { seeds, title: fresh?.title, official: fresh?.official, at: now, tried: now };
  saved.set(shelf.id, next);
  return next;
}

/** Words for a refresh interval: "every 3 days", "weekly", "monthly". */
export const everyLabel = (ms: number) => {
  const d = Math.round(ms / DAY);
  return d === 1 ? 'daily' : d === 7 ? 'weekly' : d === 30 ? 'monthly' : d > 1 ? `every ${d} days` : `every ${Math.max(1, Math.round(ms / HOUR))} hours`;
};

/** Customize Store's facts about a self-refreshing shelf. `updatedAt` is the last SUCCESSFUL refresh, never a failed try. */
export const dynamicInfo = (base: CuratedShelf, spec: DynamicSpec): ShelfInfo => {
  const s = saved.get(base.id);
  const viaFallback = spec.kind === 'official' && !!s && s.official !== true; // saved from the stand-in (or before this flag existed): only a refresh that the official page answered counts as official
  const kind = spec.kind === 'official' ? (viaFallback ? 'fallback' : 'official') : spec.kind ?? 'fallback';
  const source =
    kind === 'official' ? `${spec.source} · the club's own page (official)`
    : viaFallback ? `${spec.fallbackSource ?? 'a public record'} · public record, not the official list (the official page could not be read)`
    : spec.kind === 'generated' ? `${spec.source} · GreatReads discovery, not an official list`
    : `${spec.source} · public record, not the official list`;
  const last = attempts.get(base.id);
  const note = last && !last.ok && (!s || last.at > s.at) ? ` · last check failed (source unreadable): showing the ${s ? 'saved' : 'hand-picked'} list` : '';
  return {
    updatedAt: s?.at,
    schedule: `Refreshes ${everyLabel(spec.refreshMs)}`,
    source: source + (spec.merge === 'append' ? ' · new picks are added to the top, earlier ones stay' : '') + note,
    kind,
  };
};

const sameSeeds = (a: Seed[], b: Seed[]) => a.length === b.length && a.every((s, i) => s[0] === b[i][0] && s[1] === b[i][1] && s[2] === b[i][2]);
const refreshing = new Map<string, Promise<Saved | null>>();

/** A curated shelf that refreshes itself on schedule. Same shape as curatedSource, so the Store treats it like any shelf. */
export function dynamicCuratedSource(base: CuratedShelf, spec: DynamicSpec): ShelfSource {
  const current = () => withSeeds(base, saved.get(base.id));
  const refresh = () => dedupeInflight(refreshing, base.id, () => refreshShelf(base, spec));
  let generation = 0; // a refreshed list replaces the old one on screen; late updates from the old list are ignored

  return {
    id: base.id,
    label: () => `${base.emoji} ${spec.title?.(new Date()) ?? saved.get(base.id)?.title ?? base.title}`,
    cached: () => curatedSource(current()).cached(),
    info: () => dynamicInfo(base, spec),
    // Manual refresh: the same engine as the schedule, just not waiting for it. A failure keeps the saved (or hand-picked) list.
    refresh: async (): Promise<RefreshResult> => {
      const before = saved.get(base.id);
      const fresh = await refresh();
      if (!fresh) return 'failed';
      return before && sameSeeds(fresh.seeds, before.seeds) ? 'unchanged' : 'updated';
    },
    load: async onUpdate => {
      const mine = ++generation;
      // Each list the shelf shows gets a version. A list's cover lookups can outlive it (a refresh arrives while they run), and
      // their late results must never replace the newer list on screen.
      let version = 0;
      const showFor = (v: number) => (b: Book[]) => { if (mine === generation && v === version) onUpdate(b); };
      const have = saved.get(base.id);

      if (!isDue(have, spec)) return curatedSource(withSeeds(base, have)).load(showFor(version));

      // A replacing shelf with nothing saved waits (briefly) for the source: its hand-picked list is not what it should show.
      // On failure the hand-picked list is the shelf.
      if (!have && spec.merge !== 'append') {
        const fresh = await refresh();
        return curatedSource(withSeeds(base, fresh ?? undefined)).load(showFor(version));
      }

      // Otherwise show what the shelf has right now and swap the refreshed list in when (and only if) it differs.
      // An appending shelf's current list is the floor it grows from, so it never has to wait.
      const before = have?.seeds ?? base.seeds;
      void refresh().then(fresh => {
        if (!fresh || sameSeeds(fresh.seeds, before) || mine !== generation) return;
        const next = curatedSource(withSeeds(base, fresh));
        const v = ++version; // from here on only the new list may update the shelf
        const show = showFor(v);
        show(next.seeded());
        void next.load(show);
      });
      return curatedSource(withSeeds(base, have)).load(showFor(version));
    },
  };
}

/* ------------------------------ source: Wikipedia list articles ------------------------------ */

const wikiSpec = (pages: string[], rule: ColumnRule, label: (when: string) => string, refreshMs: number, source: string, limit = 12, splitPairs = false): DynamicSpec => ({
  source,
  kind: 'fallback',
  refreshMs,
  minSeeds: 8,
  fetch: async () => {
    const picks = await fetchWikiPicks(pages, rule);
    if (!picks) return null;
    // `splitPairs`: two books chosen at once (Oprah's Great Expectations + A Tale of Two Cities) become two covers, not one unfindable title
    const rows = picks.flatMap(p => (splitPairs ? splitPairedTitle(p.title) : [p.title]).map(title => [title, p.author, label(p.when)] as Seed));
    return { seeds: rows.slice(0, limit) };
  },
});

/** A book club or prize: its published picks accumulate, so a refresh adds the newest ones in front of what the shelf has. */
const history = (spec: DynamicSpec): DynamicSpec => ({ ...spec, merge: 'append' });

/* ------------------------------ source: Service95's own Book Club page ------------------------------ */

/**
 * The club's own list, read by the /api/service95 function (the browser cannot read another site's pages). When that cannot be
 * read (no function in a local dev server, the site down, its layout changed), Wikipedia's list is used instead and the shelf says
 * so in Customize Store. Either way a failure changes nothing: the saved list stays.
 */
const serviceSpec = (): DynamicSpec => {
  const wiki = wikiSpec(
    ['Service95'],
    { title: /^(title|book)/i, author: /^(author|writer)/i, when: /(month|date|year|read|pick|selected)/i },
    when => `Service95 Monthly Read · ${when}`,
    7 * DAY,
    'Wikipedia: Service95 (the Book Club list)',
  );
  return {
    source: 'service95.com/book-club',
    kind: 'official',
    fallbackSource: wiki.source,
    refreshMs: 7 * DAY, // a new pick appears at the start of a month; weekly means it is on the shelf within days, not up to a month late
    minSeeds: 8,
    fetch: async (shelf, signal) => {
      const j = await getJson('/api/service95', { timeout: 20000, signal });
      const seeds = (Array.isArray(j?.books) ? j.books : [])
        .filter((b: any) => b && typeof b.title === 'string' && b.title.trim() && typeof b.author === 'string' && b.author.trim() && typeof b.when === 'string')
        .map((b: any) => [b.title.trim(), b.author.trim(), `Service95 Monthly Read · ${b.when}`] as Seed);
      if (seeds.length >= 8) return { seeds, official: true };
      const fallback = await wiki.fetch(shelf, signal);
      return fallback && { ...fallback, official: false };
    },
  };
};

/* ------------------------------ source: Oprah Daily's list + Wikipedia's dates ------------------------------ */

/**
 * Oprah's Book Club. Oprah Daily's own list (read by /api/oprah) is the official record and is the first to have a new pick; it
 * carries no dates, so the dates come from Wikipedia's table. The shelf is Wikipedia's dated picks, plus any NEWER picks Oprah
 * Daily lists that Wikipedia does not have yet (shown with no date until Wikipedia catches up). If Oprah Daily cannot be read the
 * shelf is Wikipedia's list alone, and Customize Store says so. With Wikipedia down nothing is added: undated picks alone would
 * replace the dated labels the shelf already has.
 */
export function oprahNewest(official: { title: string; author: string }[], known: Seed[], maxNew = 6): Seed[] {
  const have = new Set(known.map(s => titleKey(s[0])));
  const fresh: Seed[] = [];
  for (const p of official) {
    if (have.has(titleKey(p.title))) break; // reached what Wikipedia already lists: everything above this was picked after it
    fresh.push([p.title, p.author, "Oprah's Book Club"]);
  }
  return fresh.length > maxNew ? [] : fresh; // far more "new" picks than Wikipedia could be behind: the titles are not comparable, so add nothing
}

const oprahSpec = (): DynamicSpec => {
  const wiki = wikiSpec(
    ["Oprah's Book Club", "List of Oprah's Book Club selections"],
    { title: /^(title|book|selection)/i, author: /^author/i, when: /(date|month|year|selected|announced)/i },
    when => `Oprah's Book Club · ${when}`,
    3 * DAY,
    "Wikipedia: Oprah's Book Club (the picks table)",
    12,
    true,
  );
  return {
    source: 'oprahdaily.com (the complete Oprah\'s Book Club list)',
    kind: 'official',
    fallbackSource: wiki.source,
    refreshMs: 3 * DAY,
    minSeeds: 8,
    fetch: async (shelf, signal) => {
      const dated = await wiki.fetch(shelf, signal);
      const j = await getJson('/api/oprah', { timeout: 20000, signal }).catch(() => null);
      const official = (Array.isArray(j?.picks) ? j.picks : []).filter((p: any) => p && typeof p.title === 'string' && typeof p.author === 'string');
      if (!official.length || !dated) return dated && { ...dated, official: false };
      return { seeds: [...oprahNewest(official, dated.seeds), ...dated.seeds], official: true };
    },
  };
};

/* ------------------------------ source: Open Library discovery ------------------------------ */

const JUNK = /\b(box(ed)? set|collection|omnibus|study guide|summary of|summary &|workbook|analysis of|sparknotes|cliffsnotes|bundle|\d+ books?)\b/i;

/**
 * Pick a shelf from Open Library search hits. The hits arrive in the order OL's own reader-activity sort gave them; that order
 * is blended with how many readers rated each book (OL's own counts), how well, and how new it is. One book per author, covers
 * only, explicit books and study guides / box sets left out.
 */
export function rankDiscovery(hits: Hit[], o: { year: number; limit: number; minRatings?: number }): Seed[] {
  const now = new Date(o.year, 6, 1);
  const total = hits.length || 1;
  const rated = (h: Hit) => (h.book.ratingCount || 0) >= (o.minRatings ?? 3);
  let pool = hits.map((h, i) => ({ h, i })).filter(({ h }) => (h.book.coverId || h.book.coverUrl) && !isUnknownAuthor(h.book.author) && !JUNK.test(h.book.title) && !isExplicit(h.book.title, h.flags));
  if (pool.filter(({ h }) => rated(h)).length >= o.limit) pool = pool.filter(({ h }) => rated(h)); // otherwise a young list keeps its unrated books

  const scored = pool.map(({ h, i }) => {
    const b = h.book;
    const readers = Math.min(1, Math.log10((b.ratingCount || 0) + 1) / READER_CAPS.ol);
    const quality = b.ratingAverage ? Math.max(0, Math.min(1, (shrunkRating(b.ratingAverage, b.ratingCount) - 3.5) / 1.5)) : 0;
    return { b, score: (1 - i / total) * 45 + readers * 30 + quality * 15 + recencyValue(b.year, now) * 10 };
  });
  const authors = new Set<string>();
  const seeds: Seed[] = [];
  for (const { b } of scored.sort((x, y) => y.score - x.score)) {
    const a = authorKey(b.author);
    if (authors.has(a)) continue;
    authors.add(a);
    seeds.push([b.title, b.author]);
    if (seeds.length >= o.limit) break;
  }
  return seeds;
}

/** Hand-picked staples kept at the end of a discovery shelf, so a genre shelf still has its classics. */
const withStaples = (found: Seed[], base: CuratedShelf, keep: number, size = 12): Seed[] => {
  const staples = base.seeds.slice(0, keep);
  const head = cleanSeeds(found).filter(([t, a]) => !staples.some(s => titleKey(s[0]) === titleKey(t) && authorKey(s[1]) === authorKey(a)));
  return [...head.slice(0, size - staples.length), ...staples];
};

interface Discovery { query: (year: number) => string; keep?: number; yearsBack?: number }

const olSpec = (d: Discovery): DynamicSpec => ({
  source: 'Open Library search (reader activity, ratings), recent books',
  kind: 'generated',
  refreshMs: 30 * DAY,
  minSeeds: 8,
  fetch: async base => {
    const year = new Date().getFullYear();
    const q = d.query(year);
    // OL's reader-activity sort; if it is ever refused, the default order still gives a usable pool
    let hits = await searchOpenLibrary({ q, sort: 'want_to_read' }, 60, { retries: 1 });
    if (!hits.length) hits = await searchOpenLibrary({ q }, 60, { retries: 1 });
    const keep = d.keep ?? 0;
    const found = rankDiscovery(hits, { year, limit: 12 - keep });
    return found.length ? { seeds: keep ? withStaples(found, base, keep) : found } : null;
  },
});

const recent = (years: number) => (y: number) => `language:eng AND first_publish_year:[${y - years} TO ${y}]`;
const genre = (subjects: string, keep = 4): DynamicSpec => olSpec({ query: y => `(${subjects}) AND ${recent(4)(y)}`, keep });

/* ------------------------------ the registry ------------------------------ */

const prize = (): Pick<ColumnRule, 'title' | 'author' | 'when'> => ({ title: /^(title|novel|book|work|winning (book|work))/i, author: /^(author|writer|winner)/i, when: /^(year|date)/i });

export const DYNAMIC_SPECS: Record<string, DynamicSpec> = {
  // Newest books of the year, by reader interest. Heading follows the calendar year.
  new2026: { ...olSpec({ query: y => `language:eng AND first_publish_year:${y}` }), title: now => `New in ${now.getFullYear()}`, refreshMs: 7 * DAY },

  // Published picks, from Wikipedia's lists (see wikiLists.ts). The shelf's labels show each pick's own date.
  // Oprah Daily's own list for the newest picks, Wikipedia for the dates (and as the fallback): see oprahSpec
  oprah: history(oprahSpec()),
  womens: history(wikiSpec(
    // Pages are tried in turn; one without a readable winners table is skipped. (The winners may live on a list page of their own.)
    ["Women's Prize for Fiction", "List of Women's Prize for Fiction winners"],
    { ...prize(), result: /^(result|status|outcome)/i, winner: /winner/i, onePerYear: true },
    when => `Women's Prize ${when}`,
    7 * DAY,
    "Wikipedia: Women's Prize for Fiction (winners)",
  )),
  intbooker: history(wikiSpec(
    ['International Booker Prize'],
    { ...prize(), result: /^(result|status|outcome)/i, winner: /winner/i, onePerYear: true },
    when => `International Booker ${when}`,
    7 * DAY,
    'Wikipedia: International Booker Prize (winners)',
  )),

  // Book clubs with a published list of every monthly pick (Wikipedia keeps these tables current)
  reeses: history(wikiSpec(
    ["Reese's Book Club"],
    // The page has two tables: adult picks (dated "Year and Month") and YA picks (dated "Date"); the shelf is the adult picks
    { title: /^title/i, author: /^author/i, when: /^year and month/i },
    when => `Reese's Book Club · ${when}`,
    7 * DAY,
    "Wikipedia: Reese's Book Club (adult Book Club Picks table)",
  )),
  // Service95 publishes its own list: the Book Club page is read server-side by /api/service95 (functions/api/service95.js).
  // Wikipedia's list stays as the fallback, used (and labelled as such) only when the official page can't be read.
  service95: history(serviceSpec()),

  // Recent, widely read books in the genre (Open Library), with the shelf's first four hand-picked staples kept at the end
  romance: genre('subject:romance'),
  mystery: genre('subject:mystery OR subject:thriller OR subject:"detective and mystery stories"'),
  scifi: genre('subject:"science fiction"'),
  selfhelp: genre('subject:"self-help" OR subject:"self-improvement" OR subject:"personal development"'),
  fantasy: genre('subject:fantasy'),
  memoir: genre('subject:memoir OR subject:autobiography OR subject:memoirs'),
  historical: genre('subject:"historical fiction"'),
};

/** Shelf id -> source object, as the Store needs it: self-refreshing when it has a spec, plain curated otherwise. */
export const shelfSourceFor = (shelf: CuratedShelf): ShelfSource & { seeded?: () => Book[] } =>
  DYNAMIC_SPECS[shelf.id] ? dynamicCuratedSource(shelf, DYNAMIC_SPECS[shelf.id]) : curatedSource(shelf);

export const dynamicShelfIds = () => CURATED_SHELVES.filter(s => DYNAMIC_SPECS[s.id]).map(s => s.id);
