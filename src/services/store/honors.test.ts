import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { honorKind, honorsFor, mergeHonors, rememberHonor } from './honors';
import { honorsListFor } from '../../components/BookMeta';
import { StoreShelf } from '../../components/StoreShelf';
import { makeBook } from '../books/model';
import type { ShelfSource } from './shelves';

const book = (title: string, author: string, awardLabel?: string) => makeBook({ id: `t_${title}`, title, author, awardLabel });

test('honorKind: prizes win, shortlists are medals, club picks are plain', () => {
  assert.equal(honorKind("Women's Prize 2021"), 'w');
  assert.equal(honorKind('Pulitzer Prize Winner'), 'w');
  assert.equal(honorKind('Booker shortlist 2005'), 's');
  assert.equal(honorKind("Oprah's Book Club · Mar 2026"), 'c');
  assert.equal(honorKind('Service95 Monthly Read · Oct 2026'), 'c');
});

test('a label a shelf gave a book is remembered by title + author, once, and the NYT weekly label is not an honor', () => {
  rememberHonor(book('Beloved', 'Toni Morrison', "Oprah's Book Club · Sep 1998"));
  rememberHonor(book('Beloved', 'Toni Morrison', "Oprah's Book Club · Sep 1998")); // again: no repeat
  rememberHonor(book('The Beloved!', 'Toni  Morrison', 'Pulitzer Prize Winner')); // another shelf, same book (titles and names compare loosely)
  rememberHonor(book('Beloved', 'Toni Morrison', 'NYT bestseller · 12 weeks'));
  rememberHonor(book('Nothing', 'Nobody'));
  assert.deepEqual(honorsFor({ title: 'Beloved', author: 'Toni Morrison' }), ["Oprah's Book Club · Sep 1998", 'Pulitzer Prize Winner']);
  assert.deepEqual(honorsFor({ title: 'Nothing', author: 'Nobody' }), []);
});

test('the book info lists prizes first, then shortlists, then club picks, without repeating the label it was opened with', () => {
  rememberHonor(book('Kin', 'Tayari Jones', "Oprah's Book Club · Feb 2026"));
  rememberHonor(book('Kin', 'Tayari Jones', "Women's Prize 2026"));
  rememberHonor(book('Kin', 'Tayari Jones', 'Booker shortlist 2026'));
  // opened from the Oprah shelf: its own label is in the base, the others come from what other shelves called it
  const opened = book('Kin', 'Tayari Jones', "Oprah's Book Club · Feb 2026");
  assert.deepEqual(honorsListFor(opened).map(h => [h.type, h.label]), [['w', "Women's Prize 2026"], ['s', 'Booker shortlist 2026'], ['c', "Oprah's Book Club · Feb 2026"]]);
  // opened from the Library (no label of its own) it still lists what is known
  assert.equal(honorsListFor(book('Kin', 'Tayari Jones')).length, 3);
  assert.deepEqual(mergeHonors([], { title: 'Unknown', author: 'Book' }), []);
});

test('Store shelf: every shelf, book clubs included, keeps its label under the cover', () => {
  const b = book('Little Wonder', 'Sophie Chen Keller', "Oprah's Book Club · Jun 2026");
  const source: ShelfSource = { id: 'x', cached: () => [b], load: async () => [b] };
  const html = renderToStaticMarkup(createElement(StoreShelf, { id: 'x', title: 'Shelf', source, onOpen: () => {} }));
  assert.match(html, /Oprah&#x27;s Book Club · Jun 2026|Oprah's Book Club · Jun 2026/);
  assert.match(html, /Little Wonder/);
});
