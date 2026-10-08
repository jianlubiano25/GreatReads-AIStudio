/**
 * Live check of the Service95 reader (functions/api/service95.js) against the real service95.com. Needs internet; nothing is saved.
 *
 *   npm run check:service95
 *
 * Runs the same code Cloudflare runs and prints the Monthly Reads it found. Exits 1 when the site's layout no longer matches
 * (fewer than 4 books found), which is the sign the parser in functions/api/service95.js needs updating.
 */
// @ts-ignore plain JS module with no type declarations
import { onRequestGet } from '../functions/api/service95.js';

const res: Response = await onRequestGet();
const body: any = await res.json();
if (res.status !== 200) {
  console.error(`FAILED (${res.status}): ${JSON.stringify(body)}`);
  console.error('The shelf would keep its saved list and fall back to Wikipedia. Compare https://www.service95.com/book-club with parseBookClub().');
  process.exit(1);
}
console.log(`Service95 Book Club: ${body.books.length} Monthly Reads found\n`);
for (const b of body.books) console.log(`${b.when.padEnd(9)} ${b.title}  —  ${b.author}`);
console.log('\nCheck the newest few against https://www.service95.com/book-club');
