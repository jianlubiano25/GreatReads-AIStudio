# My Reading Life (GreatReads)

Reading companion: daily page goal and streak, reading nook, library, book store, Word Garden and on-device shelf.
React + Vite + Tailwind. Reading data stays in the browser (use Backup to keep copies).

    npm install
    npm run dev          # local
    npm run build        # production build into dist/
    npm run lint         # type check
    npm test             # garden rules (plants earned / taken back / never celebrated twice)
    npm run prefetch:store -- --max-minutes=10   # optional: pre-fill store covers/ratings (needs internet)
    npm run check:shelves                        # live check: what each self-refreshing Store shelf's source returns right now
    NYT_API_KEY=... npm run check:nyt            # live check: are the NYT list names the Store uses real NYT list names (names.json)
    npm run check:oprah                          # live check: reads Oprah Daily's complete list the way the Cloudflare function does
    npm run check:service95                      # live check: reads Service95's own Book Club page the way the Cloudflare function does

Deploy (free): Cloudflare Pages. Build command `npm run build`, output directory `dist`, Node 22 (`.node-version`).
Headers are in `public/_headers`. Pages serves index.html for unknown paths by itself, so no redirect file is needed.
`npm start` (server.js) is only used by AI Studio / Cloud Run.

## How the "new version" prompt works
Each build gets an id that is a hash of the source files. The app only shows "New version ready" when a downloaded
update has a different id than the one running. Redeploying unchanged code never prompts. Settings > App Updates
shows the version and has "Check for updates".
The build id is also written to `version.json` at build time (never cached: `public/_headers`, `public/sw.js`). The app compares it with
the id it was built from, so the prompt does not depend on a service worker being active (a hard refresh, or a browser that is not
letting the worker control the page, used to hide updates). The rule is `services/updateRule.ts`.

## Garden rules (src/services/garden.ts)
- Plants come from milestones in `src/data/gardenCatalog.ts` (add a plant + a milestone, nothing else changes).
- Reading-log progress (best streak, 10+ page days, biggest day, best week, total pages) is worked out from the pages you logged.
  A streak that ended still counts, but correcting a wrongly typed page count takes the plants and growth it earned back.
- Books finished, highlights and words are high-water marks: removing a word never takes a plant away.
- The "Congratulations" prompt shows once per new plant. Restoring a backup never shows prompts.
- The nook shelf shows books from your Library (reading now, finished, up next, then the rest) that have a cover.

## Store shelves: which refresh themselves
Code: `src/services/store/dynamic.ts` (schedule + sources), `wikiLists.ts` (reads Wikipedia list tables), `bestsellers.ts` (NYT).
A shelf's hand-picked list in `src/data/storeSeeds.json` is always the floor. Fresh lists go through the same resolver, identity
and cache pipeline as any shelf. A failed or too-short refresh changes nothing (the last saved list stays; retry after 1 hour).
Nothing generated is presented as an official ranking.

| Shelf | Source | Refreshes |
|---|---|---|
| Trending Today | GreatReads blend of Open Library trending, Apple Books charts, NYT, ratings (collate.ts); labelled as GreatReads' own | every 6 h |
| Top 15 Fiction / Non-fiction | NYT combined print + e-book lists (official); GreatReads-collated stand-in, labelled, if the NYT is down | every 6 h (NYT publishes weekly) |
| NYT Young Adult, Paperback Fiction, Paperback Non-Fiction, Advice & How-To | NYT lists, official only (hide themselves if unavailable); top 10 | every 6 h |
| New in <year> | Open Library: books first published this year, by reader activity; heading follows the calendar year | weekly |
| Oprah's Book Club | Oprah Daily's own list (`/api/oprah`) for the newest picks, Wikipedia's table for the dates; Wikipedia alone (labelled fallback) if Oprah Daily can't be read. A double pick becomes two books | every 3 days |
| Women's Prize, International Booker | Wikipedia winners tables | weekly |
| Romance, Mystery, Sci-fi, Self-help, Fantasy, Memoir, Historical | Open Library: recent (last 5 years), widely read, one book per author, explicit / study guides left out; 4 hand-picked staples stay at the end | monthly |
| Service95 | the club's own Book Club page via `/api/service95` (official); Wikipedia's list, labelled, if that page can't be read | weekly |
| Reese's Book Club | Wikipedia's picks table (a stand-in, not Reese's own list) | weekly |
| Inklings (both), Top Fiction / Non-fiction, Classics | hand-picked: no reliable public machine-readable source has been found or verified (Classics are evergreen); covers and ratings still re-resolve | edit `storeSeeds.json` |

NYT quota: lists are cached 6 h in the browser and at Cloudflare's edge (`functions/api/nyt.js`), and extra lists only load when scrolled into view.
Wikipedia lists are cached 12 h by the service worker (`public/sw.js`). To change a source or schedule, edit its entry in `DYNAMIC_SPECS`.

### Book clubs: where each stands
- **Service95**: the club's **own page** (service95.com/book-club). The Cloudflare function `functions/api/service95.js` reads the page's
  list of Monthly Reads, then each book's own page for its title and author (one request each, cached at the edge: 12 hours for the list,
  a week per book), and the app refreshes the shelf weekly (a new pick appears at the start of a month, so weekly keeps it at most days
  late). If the official page cannot be read (the function is not deployed, the site is down, or its layout changed so fewer than 4 books
  can be found) the shelf falls back to Wikipedia's Service95 list and Customize Store says so; with neither, the saved list stays.
  The page structure was read on 7 Oct 2026 from a text rendering, not raw HTML, so run `npm run check:service95` after deploying to
  confirm it against the live site. `robots.txt` was not checked.
- **Oprah**: Oprah Daily's complete list (`functions/api/oprah.js`, entries like `112. “Title,” Author`, newest first) finds picks Wikipedia does not
  have yet; they sit on top with no date until Wikipedia's table (which supplies every date) catches up. If Oprah Daily can't be read the shelf is
  Wikipedia alone and Customize Store says it is the fallback. **Not verified against the live page**: it blocks automated readers where this was
  written, so the parser follows the quoted entry format. Run `npm run check:oprah` after deploying; a changed layout makes the function answer 502
  and nothing breaks.
- **Reese's**: dynamic from Wikipedia's picks table (a stand-in, not Reese's own list). **Inklings (Jack Edwards, and the Inklings Book
  Club)**: hand-picked. No official feed or structured public source has been verified for either, and scraping a page without being able to check its
  markup would risk replacing good data with junk. If you find a source, add an entry to `DYNAMIC_SPECS` (it needs a `fetch`,
  `refreshMs`, `minSeeds`, `kind`) and everything else (caching, refresh, Customize Store) works without further changes.
- **Honors & Awards**: a book club label stays under the cover on its own shelf. When a book's info is opened, Honors & Awards lists
  every label any shelf has given that book (prizes first, then shortlists, then club picks), so a club pick that also won a prize shows
  both. Only labels shelves actually carried are used (`services/store/honors.ts`); nothing is looked up or guessed.

### NYT list names
The API's list name is the list's `list_name` lower-cased with hyphens, not its display name: NYT's own API spec shows
`"list_name": "Trade Fiction Paperback"`, `"display_name": "Paperback Trade Fiction"` and the path `/lists/.../trade-fiction-paperback.json`.
The paperback fiction shelf therefore uses `trade-fiction-paperback`. This comes from NYT's published spec and example responses, not
from a live `names.json` call: run `NYT_API_KEY=... npm run check:nyt` to confirm every list name against the live API.

### Reliability notes (what keeps shelves correct)
- **Author names** from Wikipedia are cleaned (`cleanAuthorName`: footnote marks, "(US)" notes, `[a]`, line-break lists become "A & B",
  trailing original-script names). Saved book-club / prize lists are cleaned again every time they are read, so entries saved by an
  earlier version are repaired and not duplicated. A dirty name is what made covers disappear: the cover search could not match it.
- **Several Wikipedia pages** for one shelf are combined (newest first); the first page that answers no longer hides the others.
- **Covers on a refreshed list**: each list version owns the shelf, so the previous list's late cover lookups cannot overwrite the new
  list. Placeholder ids belong to the book (`seedId`), not the slot. A book that no source could place is retried after 2 hours (it was
  remembered for 14 days, so one dropped connection left a blank cover for two weeks).
- **NYT limits**: the NYT allows only a few requests a minute for the whole site. Lists load two at a time and a rate-limited one is
  waited out and retried (8 s, then 20 s). `functions/api/nyt.js` keeps the last good list per list (up to 10 days) and serves it when the
  NYT answers 429 or fails (never for 401/403/503, which are setup mistakes and stay visible). A shelf that is not loading says why in
  Customize Store.
- **Location**: the saved position (rounded to about 1 km), the weather and a refusal are kept in localStorage, not sessionStorage (which
  phones and installed apps empty on every launch, so each launch looked like a first visit). The device is asked only when asking can
  work (`locationPlan` in `services/weather.ts`). Turn "Match weather to my location" off and on to forget the position and ask again.

## Customize Store
The sliders icon opens Customize Store. It is in the footer (Store tab only, next to Backup and Refresh) and also below the Store search box.
- Drag the grip (or focus it and use the arrow keys) to reorder shelves; the eye hides or shows a shelf; **Done** exits. Hidden shelves
  stay in the list and load nothing. **Reset layout** restores the default order.
- Layout is saved on the device in `readlife.storeprefs1` (`{ order, hidden }`, `services/store/prefs.ts`). It is separate from shelf
  data (books, caches, refresh times) in both directions: moving or hiding never edits a shelf, and a scheduled or manual refresh never
  edits the layout. Shelves added by a later update appear in their default place. "Reset Everything" also clears it.
- Each row shows the shelf's **last successful update**, its automatic schedule, and where its books come from (official, public-record
  stand-in, GreatReads discovery, or hand-picked). A failed refresh never moves the time.
- The refresh button refreshes only that shelf, through the shelf source's own `refresh()` (the same code as the schedule), via
  `manualRefresh()` in `services/store/refresh.ts`: 10 minutes between manual refreshes after a success, 2 after a failure, and taps
  during a refresh share it. On failure the saved list stays.
- **Refresh all shelves** goes through the shelves that are showing (hidden ones are skipped), strictly one at a time, each through that
  same rate-limited `manualRefresh`, so a shelf checked in the last few minutes is skipped. It ends with a count of what updated, was
  already current, was checked recently, or could not update. Leaving Customize Store stops it.
