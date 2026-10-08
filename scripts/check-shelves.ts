/**
 * Live check of every self-refreshing Store shelf: asks each source what it returns RIGHT NOW and prints the first books, so a
 * changed page layout or a source outage shows up here instead of silently leaving a shelf on its saved list.
 *
 *   npm run check:shelves            (needs internet; nothing is saved or changed)
 *
 * The NYT lists are not checked here: they need the server-side NYT_API_KEY (see functions/api/nyt.js). `npm run check:nyt` checks
 * that their list names are real NYT list names.
 */
import { CURATED_SHELVES } from '../src/data/storeCatalog';
import { DYNAMIC_SPECS } from '../src/services/store/dynamic';
import { cleanAuthorName } from '../src/services/store/wikiLists';

// An author that is not just a name (digits, brackets, symbols, a leftover note) cannot be matched to a cover.
const odd = (a: string) => /[\d()\[\]{}<>|†‡*#^@]/.test(a) || cleanAuthorName(a) !== a;

// Wikipedia asks API clients to say who they are
const realFetch = globalThis.fetch;
globalThis.fetch = (input: any, init: any = {}) => realFetch(input, { ...init, headers: { 'user-agent': 'GreatReads-shelf-check/1.0 (https://github.com/jianlubiano25/GreatReads)', ...(init.headers || {}) } });

let bad = 0;
for (const shelf of CURATED_SHELVES) {
  const spec = DYNAMIC_SPECS[shelf.id];
  if (!spec) { console.log(`–  ${shelf.id.padEnd(12)} hand-picked (no reliable public source)`); continue; }
  const t0 = Date.now();
  const fresh = await spec.fetch(shelf).catch(() => null);
  const n = fresh?.seeds.length ?? 0;
  const ok = n >= spec.minSeeds;
  if (!ok) bad++;
  console.log(`${ok ? 'OK' : '!!'} ${shelf.id.padEnd(12)} ${String(n).padStart(2)} books  ${((Date.now() - t0) / 1000).toFixed(1)}s  every ${Math.round(spec.refreshMs / 86400000)}d  ${spec.source}`);
  const seeds = fresh?.seeds ?? [];
  const newest = seeds[0]?.[2] ? `  newest on the source: ${seeds[0][2]}` : '';
  if (newest) console.log(`      ${newest.trim()}`);
  for (const [t, a, label] of seeds.slice(0, 4)) console.log(`       ${t} — ${a}${label ? `  [${label}]` : ''}`);
  const dirty = seeds.filter(([, a]) => odd(a));
  if (dirty.length) { bad++; console.log(`       !! ${dirty.length} author name(s) still look wrong: ${dirty.slice(0, 5).map(d => JSON.stringify(d[1])).join(', ')}`); }
  if (!ok) console.log('       (too few books: the shelf keeps its saved / hand-picked list. Check the source or its column rules in src/services/store/dynamic.ts)');
}
process.exit(bad ? 1 : 0);
