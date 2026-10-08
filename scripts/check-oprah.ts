/**
 * Live check of the Oprah Daily reader (functions/api/oprah.js) against the real page. Needs internet; nothing is saved.
 *
 *   npm run check:oprah
 *
 * Runs the same code Cloudflare runs and prints the newest picks it found. Exits 1 when the page's layout no longer matches
 * (fewer than 8 numbered picks), which means the parser in functions/api/oprah.js needs updating. Until then the Oprah shelf keeps
 * using Wikipedia's list, so nothing breaks. (The parser was written from the entry format the page is quoted in, not from a live read.)
 */
// @ts-ignore plain JS module with no type declarations
import { onRequestGet } from '../functions/api/oprah.js';

const res: Response = await onRequestGet();
const body: any = await res.json();
if (res.status !== 200) {
  console.error(`FAILED (${res.status}): ${JSON.stringify(body)}`);
  console.error('The shelf keeps its saved list and uses Wikipedia. Compare https://www.oprahdaily.com/entertainment/books/g23067476/oprah-book-club-list/ with parseOprahList().');
  process.exit(1);
}
console.log(`Oprah Daily list: ${body.picks.length} newest picks found\n`);
for (const p of body.picks.slice(0, 12)) console.log(`#${String(p.n).padEnd(4)} ${p.title}  —  ${p.author}`);
console.log('\nCheck the newest few against the page.');
