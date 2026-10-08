import test from 'node:test';
import assert from 'node:assert/strict';
import type { CuratedShelf } from '../../data/storeCatalog';
import { cleanSeeds, dynamicCuratedSource, mergeAppend, refreshShelf, type DynamicSpec } from './dynamic';
import { cleanWiki, parseWikiTables, picksFromTables, splitPairedTitle } from './wikiLists';
import { resolvedMatchesSeed } from './curated';
import { routeFetch } from './testkit';

test('{{sortname}} with named first/last gives the name, not "last=… first=…"', () => {
  assert.equal(cleanWiki('{{sortname|first=Yael|last=van der Wouden}}'), 'Yael van der Wouden');
  assert.equal(cleanWiki('{{sortname|last=van der Wouden|first=Yael|nolink=1}}'), 'Yael van der Wouden');
  assert.equal(cleanWiki('{{sortname|Yael|van der Wouden}}'), 'Yael van der Wouden');
  assert.equal(cleanWiki('{{sortname|Tara|Westover|dab=writer}}'), 'Tara Westover');
});

test('Women\'s Prize table with a named sortname author', () => {
  const rows = [2026, 2025, 2024, 2023, 2022, 2021].map((y, i) => `| ${y} || {{sortname|first=First${i}|last=Last${i}}} || ''[[Book ${i}]]'' || Winner`).join('\n|-\n');
  const picks = picksFromTables(parseWikiTables(`{| class="wikitable"\n! Year !! Author !! Title !! Result\n|-\n${rows}\n|}`), { title: /^(title|novel|book)/i, author: /^(author|writer|winner)/i, when: /^(year|date)/i, result: /^(result|status|outcome)/i, winner: /winner/i, onePerYear: true })!;
  assert.deepEqual([picks[0].title, picks[0].author], ['Book 0', 'First0 Last0']);
});

test('a bad author saved by an older version is dropped, and a fresh pick replaces the same book saved with another author', () => {
  assert.deepEqual(cleanSeeds([['The Safekeep', 'last=van der Wouden first=Yael', 'Women’s Prize 2024'], ['Fine', 'A B']]), [['Fine', 'A B']]);
  const merged = mergeAppend([['The Safekeep', 'Yael van der Wouden', 'Women’s Prize 2024']], [['The Safekeep', 'Yael van der Wouden (b. 1990)', 'old'], ['Older', 'O A']]);
  assert.deepEqual(merged.map(s => s[0]), ['The Safekeep', 'Older']);
  assert.equal(merged[0][1], 'Yael van der Wouden');
});

test('a saved list with a bad entry shows without it, right away', async () => {
  const sh: CuratedShelf = { id: 't-bad-saved', title: 'T', emoji: '📚', genre: 'Fiction', seeds: Array.from({ length: 10 }, (_, i) => [`Base ${i}`, `Author ${i}`] as [string, string]) };
  const spec = (seeds: [string, string, string][]): DynamicSpec => ({ source: 't', kind: 'fallback', refreshMs: 7 * 24 * 3600_000, minSeeds: 8, merge: 'append', fetch: async () => ({ seeds }) });
  const good = Array.from({ length: 9 }, (_, i) => [`Good ${i}`, `Writer ${i}`, 'x'] as [string, string, string]);
  routeFetch([]);
  await refreshShelf(sh, spec([['Bad One', 'last=Smith first=Ann', 'x'], ...good]));
  const books = dynamicCuratedSource(sh, spec(good)).cached();
  assert.ok(books && !books.some(b => b.title === 'Bad One'));
});

test('splitPairedTitle: two books chosen at once become two; one-word halves and single titles stay whole', () => {
  assert.deepEqual(splitPairedTitle('Great Expectations, A Tale of Two Cities'), ['Great Expectations', 'A Tale of Two Cities']);
  assert.deepEqual(splitPairedTitle('A Tale of Two Cities and Great Expectations'), ['A Tale of Two Cities', 'Great Expectations']);
  assert.deepEqual(splitPairedTitle('Great Expectations / A Tale of Two Cities'), ['Great Expectations', 'A Tale of Two Cities']);
  for (const t of ['Pride and Prejudice', 'War and Peace', 'Beloved', 'The Heart and the Fist', 'Hidden Valley Road: Inside the Mind of an American Family']) assert.deepEqual(splitPairedTitle(t), [t], t);
});

test('a found book is only used when it is the book the shelf asked for (no other book\'s cover under the right name)', () => {
  assert.equal(resolvedMatchesSeed({ title: 'Beloved', author: 'Toni Morrison' }, 'Great Expectations', 'Charles Dickens'), false);
  assert.equal(resolvedMatchesSeed({ title: 'Beloved', author: 'Toni Morrison' }, 'Great Expectations, A Tale of Two Cities', 'Charles Dickens'), false);
  assert.equal(resolvedMatchesSeed({ title: 'Home', author: 'Marilynne Robinson' }, 'Gilead', 'Marilynne Robinson'), false); // same author, other book
  assert.equal(resolvedMatchesSeed({ title: 'Demon Copperhead: A Novel', author: 'Barbara Kingsolver' }, 'Demon Copperhead', 'Barbara Kingsolver'), true);
  assert.equal(resolvedMatchesSeed({ title: 'The Underground Railroad', author: 'Colson Whitehead' }, 'Underground Railroad', 'Colson Whitehead'), true);
  assert.equal(resolvedMatchesSeed({ title: "Harry Potter and the Philosopher's Stone", author: 'J.K. Rowling' }, "Harry Potter and the Sorcerer's Stone", 'J. K. Rowling'), true); // another edition's title
});
