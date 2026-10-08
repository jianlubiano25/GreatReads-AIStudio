/** Which NYT lists the Store shows. Add or swap an entry (e.g. 'hardcover-fiction') to change the Store. */
export interface NytShelf {
  id: string;
  list: string; // NYT list name (encoded)
  title: string;
  genre: string;
  kind: 'fiction' | 'nonfiction';
  /** false = official list only: no GreatReads-collated stand-in when the NYT is unreachable (right for niche lists). Default true. */
  fallback?: boolean;
  /** How many entries to show (default 15). */
  limit?: number;
}

export const NYT_SHELVES: NytShelf[] = [
  { id: 'nyt-fiction', list: 'combined-print-and-e-book-fiction', title: 'Top 15 this week · Fiction', genre: 'Fiction', kind: 'fiction' },
  { id: 'nyt-nonfiction', list: 'combined-print-and-e-book-nonfiction', title: 'Top 15 this week · Non-Fiction', genre: 'Non-fiction', kind: 'nonfiction' },
];

/**
 * More NYT lists, chosen because their books do NOT appear on the two combined lists above (those already merge print + e-book,
 * hardcover + paperback). Official list or nothing: when the NYT cannot be reached the shelf shows its last saved list (up to
 * 10 days old) or hides itself. Each list costs one cached request per 6 hours per visitor (and far fewer at the site's edge).
 */
/*
 * NYT Books API list names (list_name_encoded) noted for FUTURE shelves. Not used yet; none were verified live, run `npm run check:nyt`
 * with NYT_API_KEY to see which the NYT really publishes:
 *   Fiction & non-fiction : hardcover-fiction, hardcover-nonfiction, trade-fiction-paperback, paperback-nonfiction, mass-market-paperback
 *   Combined print & e-book: combined-print-and-e-book-fiction, combined-print-and-e-book-nonfiction   (used above)
 *   Advice                 : advice-how-to-and-miscellaneous (used below), hardcover-advice, paperback-books
 *   Children's & YA        : childrens-middle-grade-hardcover, childrens-middle-grade-paperback, childrens-middle-grade-e-book, series-books,
 *                            picture-books, young-adult-hardcover (used below), young-adult-paperback, young-adult-e-book
 *   Specialised            : graphic-books-and-manga, audio-fiction, audio-nonfiction, business-books, science, sports, crime-and-punishment,
 *                            celebrities, fashion-manners-and-customs, food-and-fitness, humor, love-and-relationships,
 *                            politics-and-american-history, religion-spirituality-and-faith, travel
 * Reported by the owner as "trade-paperback-fiction" for paperback fiction; the NYT API spec itself says trade-fiction-paperback, which is
 * what the shelf below uses (check:nyt settles it).
 */
export const NYT_EXTRA_SHELVES: NytShelf[] = [
  { id: 'nyt-ya', list: 'young-adult-hardcover', title: 'NYT Best Sellers · Young Adult', genre: 'Young adult', kind: 'fiction', fallback: false, limit: 10 },
  // The API's list name is the list_name, not the display name: NYT's own API spec shows "list_name": "Trade Fiction Paperback" with
  // "display_name": "Paperback Trade Fiction", and queries /lists/.../trade-fiction-paperback.json. `npm run check:nyt` re-checks all of these.
  { id: 'nyt-paperback-fiction', list: 'trade-fiction-paperback', title: 'NYT Best Sellers · Paperback Fiction', genre: 'Fiction', kind: 'fiction', fallback: false, limit: 10 },
  { id: 'nyt-paperback-nonfiction', list: 'paperback-nonfiction', title: 'NYT Best Sellers · Paperback Non-Fiction', genre: 'Non-fiction', kind: 'nonfiction', fallback: false, limit: 10 },
  { id: 'nyt-advice', list: 'advice-how-to-and-miscellaneous', title: 'NYT Best Sellers · Advice & How-To', genre: 'Self-help', kind: 'nonfiction', fallback: false, limit: 10 },
];
