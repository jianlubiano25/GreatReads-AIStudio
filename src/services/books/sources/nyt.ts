import { dedupeInflight, getJsonDetailed, pool } from '../http';
import { persistentCache } from '../cache';
import { cleanIsbn, isbnPair } from '../identity';
import type { CallOpts } from './types';

/** New York Times Books API: the authority for bestseller rank. */

export interface NytEntry {
  rank: number; // 1 = top
  rankLastWeek: number; // 0 = was not on the list
  weeksOnList: number;
  title: string;
  author: string;
  description: string;
  publisher: string;
  cover: string; // jacket of the primary edition
  isbn13?: string;
  isbn10?: string;
  list: string;
  publishedDate: string;
}

const LIST_TTL = 6 * 60 * 60 * 1000; // the NYT updates weekly: re-asking more often only spends the API quota
/** The NYT publishes weekly, so a list up to this old is still "the latest official list" when a refresh fails. */
export const NYT_STALE_OK_MS = 10 * 24 * 60 * 60 * 1000;
const cache = persistentCache<NytEntry[]>('readlife.nyt1', { ttl: LIST_TTL, max: 10, keepStale: NYT_STALE_OK_MS });

/**
 * With VITE_NYT_API_KEY set (local dev only) the key is used directly. In production the request goes to this site's own
 * /api/nyt function, which holds the key as a server-side secret (see functions/api/nyt.js), so it never ships in the app.
 */
function listUrl(list: string): string {
  let key = '';
  try { key = String((import.meta as any).env?.VITE_NYT_API_KEY || ''); } catch {}
  return key
    ? `https://api.nytimes.com/svc/books/v3/lists/current/${list}.json?api-key=${encodeURIComponent(key)}`
    : `/api/nyt?list=${encodeURIComponent(list)}`;
}

const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs']);
/** NYT sends titles in capitals ("IT ENDS WITH US"). */
export function nytTitleCase(s: string): string {
  if (s !== s.toUpperCase()) return s; // already mixed case
  return s.toLowerCase().replace(/[a-z][a-z'’]*/g, (w, i) => (i > 0 && SMALL.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
}

export function parseNytList(data: any): NytEntry[] {
  const books: any[] = data?.results?.books || [];
  return books
    .map(b => {
      const i13 = cleanIsbn(b.primary_isbn13);
      const i10 = cleanIsbn(b.primary_isbn10);
      return {
        rank: Number(b.rank) || 0,
        rankLastWeek: Number(b.rank_last_week) || 0,
        weeksOnList: Number(b.weeks_on_list) || 0,
        title: nytTitleCase(String(b.title || '').trim()),
        author: String(b.author || '').trim(),
        description: String(b.description || '').trim(),
        publisher: String(b.publisher || '').trim(),
        cover: String(b.book_image || '').replace(/^http:\/\//i, 'https://'),
        ...isbnPair(i13 || i10),
        list: String(data?.results?.list_name_encoded || ''),
        publishedDate: String(data?.results?.published_date || ''),
      } as NytEntry;
    })
    .filter(e => e.rank > 0 && e.title)
    .sort((a, b) => a.rank - b.rank);
}

/** When the saved list was fetched (ms), or undefined. Used to say how old a shelf's data is. */
export const nytListSavedAt = (list: string): number | undefined => {
  const p = cache.peek(list);
  return p ? Date.now() - p.ageMs : undefined;
};
export const getCachedNytList = (list: string): NytEntry[] | undefined => cache.get(list);
/** Forget a saved list (used by tests, and handy when switching lists). */
export const forgetNytList = (list: string) => cache.delete(list);

/** Why the NYT list could not be loaded (the Cloudflare function reports these; see functions/api/nyt.js). */
export type NytFailure = 'not_configured' | 'unauthorized' | 'rate_limited' | 'no_function' | 'upstream_error' | 'offline' | 'empty';

export interface NytResult {
  entries: NytEntry[] | null;
  /** true when `entries` is the last list we saved because a fresh one could not be loaded (never older than 10 days) */
  stale: boolean;
  failure?: NytFailure;
}

export function classifyNytFailure(r: { status: number; failure?: string; data?: any }): NytFailure {
  const err = r.data?.error;
  if (err === 'not_configured' || r.status === 503) return 'not_configured';
  if (err === 'unauthorized' || r.status === 401 || r.status === 403) return 'unauthorized';
  if (err === 'rate_limited' || r.status === 429) return 'rate_limited';
  if (r.failure === 'not-json' || r.status === 404) return 'no_function'; // the site answered with a web page: the function isn't deployed
  if (r.failure === 'network' || r.failure === 'timeout') return 'offline';
  return 'upstream_error';
}

export const NYT_FAILURE_TEXT: Record<NytFailure, string> = {
  not_configured: 'NYT_API_KEY is not set for this deployment (set it for Production in Cloudflare Pages, then redeploy)',
  unauthorized: 'the NYT rejected the key (enable the Books API for it in the NYT developer portal)',
  rate_limited: 'the NYT rate limit was hit; it will retry later',
  no_function: '/api/nyt returned a web page: the Pages Function is not deployed (needs a Git-connected Pages project, not a plain upload)',
  upstream_error: 'the NYT API had an error, or does not have this list name (run npm run check:nyt)',
  offline: 'no network',
  empty: 'the NYT list came back empty',
};

const warned = new Set<string>();
const warnOnce = (list: string, f: NytFailure) => {
  if (warned.has(list)) return; // once per list (one list failing must not hide that another one does too)
  warned.add(list);
  try { console.warn(`[GreatReads] NYT list "${list}" unavailable: ${NYT_FAILURE_TEXT[f]}`); } catch {}
};

/** Why each list's last load failed (cleared by a success): Customize Store shows it, since a hidden shelf cannot say. */
const lastFailure = new Map<string, NytFailure>();
export const lastNytFailure = (list: string): NytFailure | undefined => lastFailure.get(list);

/**
 * The NYT allows only a few requests a minute per key, and a first visit asks for several lists at once, so lists go out two at a
 * time and a "too many requests" answer is waited out and tried again (when nothing is saved to show meanwhile).
 */
export const nytTuning = { backoffMs: [8000, 20000, 65000] as number[] };
const turn = pool(2);
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

const inflight = new Map<string, Promise<NytResult>>();

/**
 * The current list in NYT order. Never throws. When a fresh load fails, the last saved list (up to 10 days old) is returned with
 * `stale: true`; with nothing saved, `entries` is null and `failure` says why.
 */
export async function loadNytList(list: string, opts: CallOpts & { force?: boolean } = {}): Promise<NytResult> {
  const hit = opts.force ? undefined : cache.get(list); // force = a manual refresh: ask again, but the saved list stays as the fallback
  if (hit) return { entries: hit, stale: false };
  return dedupeInflight(inflight, list, async () => {
    const ask = () => turn(() => getJsonDetailed(listUrl(list), { timeout: 10000, retries: 1, signal: opts.signal }));
    let r = await ask();
    if (!cache.peek(list)) {
      for (const wait of nytTuning.backoffMs) {
        if (r.data || opts.signal?.aborted || classifyNytFailure(r) !== 'rate_limited') break;
        await sleep(wait);
        r = await ask();
      }
    }
    const entries = r.data ? parseNytList(r.data) : [];
    if (entries.length) {
      cache.set(list, entries);
      lastFailure.delete(list);
      return { entries, stale: false };
    }
    if (opts.signal?.aborted) return { entries: null, stale: false, failure: 'offline' as const };
    const failure: NytFailure = r.data ? 'empty' : classifyNytFailure(r);
    lastFailure.set(list, failure);
    warnOnce(list, failure);
    const old = cache.peek(list);
    return old ? { entries: old.value, stale: true, failure } : { entries: null, stale: false, failure };
  });
}

/** The current list in NYT order, or null when it cannot be had at all. (A saved list up to 10 days old still counts.) */
export async function fetchNytList(list: string, opts: CallOpts = {}): Promise<NytEntry[] | null> {
  return (await loadNytList(list, opts)).entries;
}
