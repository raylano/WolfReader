/*
 * Page-range parsing and chapter <-> page selection logic.
 * Pure functions, shared by the main process (CommonJS), the renderer (global
 * `WolfSelection`) and the unit tests.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WolfSelection = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /**
   * Parses user input like "5-12, 20, 30-" into a sorted array of unique pages.
   * Accepts commas, semicolons or spaces as separators and -, – or — as range
   * dashes. "30-" means "30 to the end". Reversed ranges ("12-5") are accepted.
   * @returns {{pages: number[], errors: string[]}}
   */
  function parsePageRanges(text, totalPages) {
    const errors = [];
    const pages = new Set();
    const source = String(text || '').trim();
    if (!source) return { pages: [], errors };

    const tokens = source
      .replace(/\s*[-–—]\s*/g, '-')
      .split(/[\s,;]+/)
      .filter(Boolean);

    for (const token of tokens) {
      const m = /^(\d+)?(?:(-)(\d+)?)?$/.exec(token);
      if (!m || (!m[1] && !m[3])) {
        errors.push(`“${token}” isn’t a page number or range`);
        continue;
      }
      let from = m[1] ? parseInt(m[1], 10) : 1;
      let to = m[2] ? (m[3] ? parseInt(m[3], 10) : totalPages) : from;
      if (from > to) [from, to] = [to, from];
      if (from < 1) {
        errors.push('Page numbers start at 1');
        continue;
      }
      if (from > totalPages) {
        errors.push(`Page ${from} doesn’t exist (the book has ${totalPages} page${totalPages === 1 ? '' : 's'})`);
        continue;
      }
      if (to > totalPages) {
        errors.push(`Page ${to} doesn’t exist (the book has ${totalPages} page${totalPages === 1 ? '' : 's'})`);
        to = totalPages;
      }
      for (let p = from; p <= to; p++) pages.add(p);
    }
    return { pages: Array.from(pages).sort((a, b) => a - b), errors };
  }

  /** Collapses sorted page numbers into inclusive {from, to} ranges (1-based). */
  function toRanges(pages) {
    const ranges = [];
    for (const p of pages) {
      const last = ranges[ranges.length - 1];
      if (last && p === last.to + 1) last.to = p;
      else if (!last || p > last.to) ranges.push({ from: p, to: p });
    }
    return ranges;
  }

  /** "1–3, 10, 12–25" */
  function formatRanges(pages) {
    return toRanges(pages)
      .map((r) => (r.from === r.to ? String(r.from) : `${r.from}–${r.to}`))
      .join(', ');
  }

  /**
   * Gives every TOC entry an inclusive page span.
   * A chapter runs from its start page up to the page before the next entry
   * (in reading order) at the same or a shallower depth, so a part/section
   * spans all of its sub-chapters. Entries whose start couldn't be located get
   * null spans.
   * @param {{id:string, depth:number, startPage:number|null}[]} entries TOC order
   * @returns {Object<string, {startPage:number, endPage:number}|null>}
   */
  function computeChapterSpans(entries, totalPages) {
    const spans = {};
    const located = entries
      .map((e, order) => ({ ...e, order }))
      .filter((e) => Number.isInteger(e.startPage) && e.startPage >= 1 && e.startPage <= totalPages)
      .sort((a, b) => a.startPage - b.startPage || a.order - b.order);

    for (const e of entries) spans[e.id] = null;
    for (let i = 0; i < located.length; i++) {
      const e = located[i];
      let end = totalPages;
      for (let j = i + 1; j < located.length; j++) {
        if (located[j].depth <= e.depth) {
          end = located[j].startPage - 1;
          break;
        }
      }
      spans[e.id] = { startPage: e.startPage, endPage: Math.max(e.startPage, end) };
    }
    return spans;
  }

  /**
   * The set of pages to print.
   * mode "all": every page. mode "custom": union of the checked chapters' pages
   * and the typed page ranges, plus pages ticked one by one (includePages),
   * minus pages unticked one by one (excludePages).
   * @returns {{pages:number[], errors:string[], chapterCount:number}}
   */
  function resolveSelection(
    { mode, checkedChapterIds = [], rangeText = '', includePages = [], excludePages = [] },
    { totalPages, spans },
  ) {
    if (mode === 'all') {
      const pages = [];
      for (let p = 1; p <= totalPages; p++) pages.push(p);
      return { pages, errors: [], chapterCount: Object.values(spans || {}).filter(Boolean).length };
    }
    const set = new Set();
    let chapterCount = 0;
    for (const id of checkedChapterIds) {
      const span = spans && spans[id];
      if (!span) continue;
      chapterCount++;
      for (let p = span.startPage; p <= span.endPage; p++) set.add(p);
    }
    const parsed = parsePageRanges(rangeText, totalPages);
    for (const p of parsed.pages) set.add(p);
    for (const p of includePages) if (p >= 1 && p <= totalPages) set.add(p);
    for (const p of excludePages) set.delete(p);
    return { pages: Array.from(set).sort((a, b) => a - b), errors: parsed.errors, chapterCount };
  }

  /**
   * Updates the per-page overrides so that `pages` become selected (on) or
   * unselected (off) given the pages `base` already selected through chapters
   * and typed ranges. Returns new {includePages, excludePages} Sets.
   */
  function togglePages(pages, on, base, includePages, excludePages) {
    const include = new Set(includePages);
    const exclude = new Set(excludePages);
    for (const p of pages) {
      include.delete(p);
      exclude.delete(p);
      if (on && !base.has(p)) include.add(p);
      if (!on && base.has(p)) exclude.add(p);
    }
    return { includePages: include, excludePages: exclude };
  }

  return { togglePages, parsePageRanges, toRanges, formatRanges, computeChapterSpans, resolveSelection };
});
