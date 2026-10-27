const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parsePageRanges,
  toRanges,
  formatRanges,
  computeChapterSpans,
  resolveSelection,
} = require('../../src/shared/selection');

test('parses single pages and ranges in any separator style', () => {
  assert.deepEqual(parsePageRanges('5-8, 20', 50).pages, [5, 6, 7, 8, 20]);
  assert.deepEqual(parsePageRanges('5 – 7; 9 3', 50).pages, [3, 5, 6, 7, 9]);
  assert.deepEqual(parsePageRanges('  ', 50), { pages: [], errors: [] });
});

test('open-ended and reversed ranges', () => {
  assert.deepEqual(parsePageRanges('48-', 50).pages, [48, 49, 50]);
  assert.deepEqual(parsePageRanges('-3', 50).pages, [1, 2, 3]);
  assert.deepEqual(parsePageRanges('7-5', 50).pages, [5, 6, 7]);
});

test('reports invalid and out-of-range input without throwing', () => {
  const r = parsePageRanges('abc, 0, 60, 45-70', 50);
  assert.equal(r.errors.length, 4);
  assert.match(r.errors[0], /abc/);
  assert.match(r.errors[2], /Page 60 doesn’t exist/);
  // 45-70 is clamped to the end of the book (and reported)
  assert.deepEqual(r.pages, [45, 46, 47, 48, 49, 50]);
});

test('collapses pages into ranges and formats them', () => {
  assert.deepEqual(toRanges([1, 2, 3, 7, 9, 10]), [
    { from: 1, to: 3 },
    { from: 7, to: 7 },
    { from: 9, to: 10 },
  ]);
  assert.equal(formatRanges([1, 2, 3, 7, 9, 10]), '1–3, 7, 9–10');
  assert.equal(formatRanges([]), '');
});

test('chapter spans run to the next entry at the same or shallower depth', () => {
  const entries = [
    { id: 'part1', depth: 0, startPage: 3 },
    { id: 'c1', depth: 1, startPage: 3 },
    { id: 'c2', depth: 1, startPage: 8 },
    { id: 'part2', depth: 0, startPage: 15 },
    { id: 'c3', depth: 1, startPage: 15 },
    { id: 'lost', depth: 1, startPage: null },
  ];
  const spans = computeChapterSpans(entries, 20);
  assert.deepEqual(spans.part1, { startPage: 3, endPage: 14 });
  assert.deepEqual(spans.c1, { startPage: 3, endPage: 7 });
  assert.deepEqual(spans.c2, { startPage: 8, endPage: 14 });
  assert.deepEqual(spans.part2, { startPage: 15, endPage: 20 });
  assert.deepEqual(spans.c3, { startPage: 15, endPage: 20 });
  assert.equal(spans.lost, null);
});

test('two entries starting on the same page each keep at least that page', () => {
  const spans = computeChapterSpans(
    [
      { id: 'a', depth: 0, startPage: 4 },
      { id: 'b', depth: 0, startPage: 4 },
      { id: 'c', depth: 0, startPage: 6 },
    ],
    9,
  );
  assert.deepEqual(spans.a, { startPage: 4, endPage: 4 });
  assert.deepEqual(spans.b, { startPage: 4, endPage: 5 });
  assert.deepEqual(spans.c, { startPage: 6, endPage: 9 });
});

test('selection is the union of checked chapters and typed ranges', () => {
  const model = {
    totalPages: 30,
    spans: { a: { startPage: 1, endPage: 4 }, b: { startPage: 5, endPage: 12 }, c: null },
  };
  const sel = resolveSelection({ mode: 'custom', checkedChapterIds: ['a', 'c'], rangeText: '3-6, 20' }, model);
  assert.deepEqual(sel.pages, [1, 2, 3, 4, 5, 6, 20]);
  assert.equal(sel.chapterCount, 1);

  const onlyRanges = resolveSelection({ mode: 'custom', rangeText: '29-' }, model);
  assert.deepEqual(onlyRanges.pages, [29, 30]);
  assert.equal(onlyRanges.chapterCount, 0);

  const all = resolveSelection({ mode: 'all', rangeText: 'ignored' }, model);
  assert.equal(all.pages.length, 30);
  assert.equal(all.chapterCount, 2);
});
