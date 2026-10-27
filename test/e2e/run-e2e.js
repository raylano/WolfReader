'use strict';
/*
 * End-to-end verification of Wolfreader, driving the real Electron app:
 * open → render → print dialog → "Save as PDF" for the whole book and for
 * chapter/page selections, then inspecting the produced PDFs.
 *
 * Run with: npm run test:e2e   (needs Xvfb; samples from scripts/fetch-samples.sh)
 * Output:   test/output/*.pdf, test/output/screens/*.png, test/output/e2e-report.json
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { launch, waitForBook, stubSaveDialog, ROOT, OUT } = require('./harness');

const SAMPLES = path.join(ROOT, 'test', 'samples');
const FIX = path.join(ROOT, 'test', 'fixtures', 'generated');
const SCREENS = path.join(OUT, 'screens');
fs.mkdirSync(SCREENS, { recursive: true });

let inspectPdf;
let pdfFonts;
const checks = [];
const report = { startedAt: new Date().toISOString(), books: {}, checks };

function check(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? undefined : String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`);
}

const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
const uniqSorted = (xs) => [...new Set(xs)].sort((a, b) => a - b);
const sameList = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function compactRanges(pages) {
  const out = [];
  for (const p of pages) {
    const last = out[out.length - 1];
    if (last && p === last[1] + 1) last[1] = p;
    else out.push([p, p]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(', ');
}

/* ---------------- UI helpers ---------------- */

async function openBook(page, file) {
  await page.evaluate((p) => window.WolfApp.openPath(p), file);
  return waitForBook(page);
}

async function layoutReady(page, paper) {
  await page.waitForFunction(
    (p) => {
      const L = window.WolfApp.state.layout;
      return L.status === 'ready' && L.pagination && (!p || L.pagination.paper === p);
    },
    paper || null,
    { timeout: 300000, polling: 200 },
  );
  return page.evaluate(() => window.WolfApp.state.layout.pagination);
}

async function openPrintDialog(page) {
  await page.click('#btn-print');
  await page.waitForSelector('#print-modal:not([hidden])');
}

async function setPaper(page, paper) {
  await page.click(`.segmented label:has(input[value="${paper}"])`);
  return layoutReady(page, paper);
}

async function setMode(page, mode) {
  await page.check(`input[name="print-mode"][value="${mode}"]`);
}

async function summary(page) {
  return page.$eval('#selection-summary', (el) => el.innerText.replace(/\s+/g, ' ').trim());
}

async function savePdf(app, page, name) {
  const file = path.join(OUT, name);
  fs.rmSync(file, { force: true });
  await stubSaveDialog(app, file);
  await page.click('#btn-save-pdf');
  await page.waitForSelector('#print-modal', { state: 'hidden', timeout: 120000 });
  for (let i = 0; i < 100 && !fs.existsSync(file); i++) await new Promise((r) => setTimeout(r, 100));
  return file;
}

/** Verifies a saved PDF: page count, page-number footers, no marker links, metadata. */
async function verifyPdf(label, file, expectedPages, { title, paper } = {}) {
  const pdf = await inspectPdf(file, { maxChars: 300 });
  const footers = pdf.pages.map((p) => parseInt(p.footer, 10));
  check(`${label}: PDF has ${expectedPages.length} pages`, pdf.numPages === expectedPages.length, `got ${pdf.numPages}`);
  check(
    `${label}: printed page numbers are exactly the selected pages`,
    sameList(footers, expectedPages),
    footers.length > 16 ? `${compactRanges(footers)}` : footers.join(','),
  );
  check(
    `${label}: no internal page markers left in PDF`,
    pdf.pages.every((p) => !p.annotations.some((u) => u.includes('wolfreader.invalid'))),
  );
  if (title) check(`${label}: PDF title metadata`, pdf.title === title, pdf.title);
  if (paper) {
    const want = paper === 'A4' ? [595, 842] : [612, 792];
    check(
      `${label}: page size is ${paper}`,
      pdf.pages.every((p) => Math.abs(p.width - want[0]) <= 1 && Math.abs(p.height - want[1]) <= 1),
      `${pdf.pages[0].width}x${pdf.pages[0].height}pt`,
    );
  }
  return pdf;
}

/** Chromium's own page-range selection (the mechanism webContents.print() uses) on the live print layout. */
async function chromiumPageRanges(app, paper, pages) {
  const b64 = await app.evaluate(
    async ({ BrowserWindow }, { paper, ranges }) => {
      const win = BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().endsWith('/print.html'));
      const pdf = await win.webContents.printToPDF({ pageSize: paper, preferCSSPageSize: true, printBackground: false, pageRanges: ranges });
      return pdf.toString('base64');
    },
    { paper, ranges: compactRanges(pages) },
  );
  const file = path.join(OUT, `chromium-pageranges-${Date.now()}.pdf`);
  fs.writeFileSync(file, Buffer.from(b64, 'base64'));
  return file;
}

function chapterIdsByLabel(info, labels) {
  return labels.map((l) => {
    const ch = info.chapters.find((c) => c.label === l);
    if (!ch) throw new Error(`No chapter labelled ${l}`);
    return ch.id;
  });
}

async function tick(page, ids) {
  for (const id of ids) await page.check(`#chapter-list input[data-id="${id}"]`);
}

/* ---------------- scenarios ---------------- */

async function scenarioCleanToc(app, page) {
  const file = path.join(SAMPLES, 'alice-pg11-images-3.epub');
  const t0 = Date.now();
  const info = await openBook(page, file);
  const book = (report.books.alice = { file: path.basename(file), title: info.title, chapters: info.chapters.length });
  check('Alice: opens and renders', info.layout.status === 'ready', `${info.sections} spine sections, ${info.chapters.length} TOC entries`);
  check('Alice: table of contents mapped to spine', info.hasToc && info.chapters.every((c) => c.sectionIndex !== null));
  const shown = await page
    .$eval('#viewer iframe', (f) => ({ els: f.contentDocument.body.querySelectorAll('*').length, imgs: f.contentDocument.images.length }))
    .catch(() => ({ els: 0, imgs: 0 }));
  check('Alice: reading pane shows book content', shown.els > 0, `first section (cover): ${shown.els} elements, ${shown.imgs} image(s)`);
  await page.evaluate((id) => document.querySelector(`#toc a[data-id="${id}"]`).click(), info.chapters.find((c) => /CHAPTER I\./.test(c.label)).id);
  await page.waitForFunction(() => /Down the Rabbit-Hole/.test(document.querySelector('#viewer iframe')?.contentDocument?.body?.innerText || ''), null, { timeout: 15000 }).catch(() => {});
  const text = await page.$eval('#viewer iframe', (f) => f.contentDocument.body.innerText.length).catch(() => 0);
  check('Alice: contents click shows Chapter I text', text > 1000, `${text} chars`);
  await page.screenshot({ path: path.join(SCREENS, '01-reader-alice.png') });

  await openPrintDialog(page);
  let pag = await setPaper(page, 'A4');
  book.layoutMs = Date.now() - t0;
  book.a4Pages = pag.totalPages;
  check('Alice: A4 pagination computed', pag.totalPages > 20, `${pag.totalPages} pages`);
  const s = await summary(page);
  check('Alice: whole-book summary', s.includes(`${pag.totalPages} pages /`), s);
  await page.screenshot({ path: path.join(SCREENS, '02-print-dialog-whole.png') });

  // 1. Entire document
  const whole = await savePdf(app, page, 'alice-whole-A4.pdf');
  await verifyPdf('Alice whole book', whole, range(1, pag.totalPages), { title: info.title, paper: 'A4' });

  // 2. Two chapters + a page range
  await openPrintDialog(page);
  await setMode(page, 'custom');
  const [c2, c5] = chapterIdsByLabel(info, ['CHAPTER II. The Pool of Tears', 'CHAPTER V. Advice from a Caterpillar']);
  await tick(page, [c2, c5]);
  await page.fill('#page-range', '1-2, 40');
  const expected = uniqSorted([
    ...range(pag.spans[c2].startPage, pag.spans[c2].endPage),
    ...range(pag.spans[c5].startPage, pag.spans[c5].endPage),
    1, 2, 40,
  ]);
  const sumText = await summary(page);
  check('Alice: live count for 2 chapters + "1-2, 40"', sumText.startsWith(`${expected.length} pages / 2 chapters selected`), sumText);
  await page.screenshot({ path: path.join(SCREENS, '03-print-dialog-custom.png') });
  const sel = await savePdf(app, page, 'alice-ch2-ch5-plus-1-2-40-A4.pdf');
  const selPdf = await verifyPdf('Alice chapters II+V + pages 1-2,40', sel, expected, { title: info.title });
  const idx = expected.indexOf(pag.spans[c2].startPage);
  check('Alice: chapter II starts on its page in the selection', /CHAPTER II/i.test(selPdf.pages[idx].fullText), selPdf.pages[idx].text.slice(0, 60));
  const idx5 = expected.indexOf(pag.spans[c5].startPage);
  check('Alice: chapter V starts on its page in the selection', /CHAPTER V/i.test(selPdf.pages[idx5].fullText), selPdf.pages[idx5].text.slice(0, 60));
  book.selection = { chapters: ['II', 'V'], range: '1-2, 40', pages: expected.length };

  // Same selection through Chromium's pageRanges (what the printer path uses).
  const viaChromium = await chromiumPageRanges(app, 'A4', expected);
  const cr = await inspectPdf(viaChromium, { maxChars: 300 });
  check(
    'Alice: Chromium pageRanges (printer path) selects identical pages',
    sameList(cr.pages.map((p) => parseInt(p.footer, 10)), expected) &&
      cr.pages.every((p, i) => p.fullText === selPdf.pages[i].fullText),
    `${cr.numPages} pages, text identical page-by-page`,
  );

  // 3. Page range only
  await openPrintDialog(page);
  await page.click('#chapters-none');
  await page.fill('#page-range', '5-7');
  check('Alice: page range only', (await summary(page)).startsWith('3 pages / 0 chapters selected'), await summary(page));
  const r3 = await savePdf(app, page, 'alice-pages-5-7-A4.pdf');
  await verifyPdf('Alice pages 5-7', r3, [5, 6, 7]);

  // 4. Invalid input is caught before printing
  await openPrintDialog(page);
  await page.fill('#page-range', 'abc, 999');
  const errors = await page.$$eval('#range-errors li', (els) => els.map((e) => e.textContent));
  const disabled = await page.$eval('#btn-save-pdf', (b) => b.disabled);
  check('Alice: invalid page input reported and blocks output', errors.length === 2 && disabled, errors.join(' | '));
  await page.fill('#page-range', '');

  // 5. Ticking a part/chapter then unticking
  await page.click('#chapters-all');
  const allCount = await summary(page);
  check('Alice: "Select all" covers every page', allCount.startsWith(`${pag.totalPages} pages`), allCount);
  await page.click('#chapters-none');

  // 6. Paper size changes pagination
  pag = await setPaper(page, 'Letter');
  book.letterPages = pag.totalPages;
  check('Alice: Letter re-pagination', pag.totalPages > 0 && pag.paper === 'Letter', `${pag.totalPages} Letter pages vs ${book.a4Pages} A4`);
  await setMode(page, 'all');
  const letter = await savePdf(app, page, 'alice-whole-Letter.pdf');
  await verifyPdf('Alice whole book (Letter)', letter, range(1, pag.totalPages), { paper: 'Letter' });

  // 7. Printer handling without any installed printer
  await openPrintDialog(page);
  await page.waitForFunction(() => !document.getElementById('printer').disabled || /No printers/.test(document.getElementById('printer').textContent));
  const printerUi = await page.evaluate(() => ({
    options: [...document.getElementById('printer').options].map((o) => o.textContent),
    printDisabled: document.getElementById('btn-do-print').disabled,
    status: document.getElementById('print-status').innerText,
  }));
  report.printers = printerUi;
  if (printerUi.options[0] === 'No printers found') {
    check('No printer installed: Print disabled with explanation, PDF still offered', printerUi.printDisabled && /save your selection as a PDF/i.test(printerUi.status), printerUi.status.replace(/\s+/g, ' '));
  } else {
    check('Printers listed', printerUi.options.length > 1, printerUi.options.join(', '));
  }
  const printRes = await page.evaluate(() =>
    window.wolf.print({ bookId: window.WolfApp.state.bookId, pages: [1, 2, 3], deviceName: 'Wolfreader Ghost Printer', copies: 1 }),
  );
  check('Printing to an unavailable printer fails gracefully', printRes.ok === false && typeof printRes.message === 'string', printRes.message || JSON.stringify(printRes));
  await page.click('#print-modal .modal-footer [data-close]');
}

async function scenarioImages(app, page) {
  const file = path.join(SAMPLES, 'alice-rackham-pg28885-images-3.epub');
  const t0 = Date.now();
  const info = await openBook(page, file);
  await openPrintDialog(page);
  const pag = await setPaper(page, 'A4');
  report.books.rackham = { file: path.basename(file), title: info.title, chapters: info.chapters.length, a4Pages: pag.totalPages, layoutMs: Date.now() - t0 };
  check('Rackham (image-heavy): pagination', pag.totalPages > 20, `${pag.totalPages} pages, ${info.chapters.length} TOC entries`);
  const whole = await savePdf(app, page, 'rackham-whole-A4.pdf');
  await verifyPdf('Rackham whole book', whole, range(1, pag.totalPages), { paper: 'A4' });
  const pdf = await inspectPdf(whole, { countImages: true });
  const imagePages = pdf.pages.filter((p) => p.images > 0).length;
  const totalImages = pdf.pages.reduce((n, p) => n + p.images, 0);
  report.books.rackham.imagesInPdf = totalImages;
  check('Rackham: illustrations are in the printed output', totalImages >= 20, `${totalImages} image draws on ${imagePages} pages`);
  // Every image must fit on its page (no image taller than the printable area).
  const shot = await page.screenshot({ path: path.join(SCREENS, '04-reader-rackham.png') });
  void shot;

  // The longest contents entry, and its illustrations must survive the selection.
  const size = (c) => (pag.spans[c.id] ? pag.spans[c.id].endPage - pag.spans[c.id].startPage : -1);
  const target = info.chapters.reduce((a, b) => (size(b) > size(a) ? b : a));
  await openPrintDialog(page);
  await setMode(page, 'custom');
  await page.click('#chapters-none');
  await page.fill('#page-range', '');
  await tick(page, [target.id]);
  const span = pag.spans[target.id];
  const sel = await savePdf(app, page, 'rackham-one-chapter-A4.pdf');
  await verifyPdf(`Rackham "${target.label}" only`, sel, range(span.startPage, span.endPage));
  const selImages = (await inspectPdf(sel, { countImages: true })).pages.reduce((n, p) => n + p.images, 0);
  const wholeImages = pdf.pages.slice(span.startPage - 1, span.endPage).reduce((n, p) => n + p.images, 0);
  check('Rackham: selected chapter keeps exactly its illustrations', selImages > 0 && selImages === wholeImages, `${selImages} images (whole book has ${wholeImages} on those pages)`);
}

async function scenarioLargeEpub2(app, page) {
  const file = path.join(SAMPLES, 'war-and-peace-pg2600-epub2.epub');
  const t0 = Date.now();
  const info = await openBook(page, file);
  await openPrintDialog(page);
  const pag = await setPaper(page, 'A4');
  report.books.warAndPeaceEpub2 = { file: path.basename(file), sections: info.sections, chapters: info.chapters.length, a4Pages: pag.totalPages, layoutMs: Date.now() - t0 };
  check('War and Peace (EPUB 2, NCX, 365 files): pagination', pag.totalPages > 1000, `${pag.totalPages} pages, ${info.sections} sections, ${info.chapters.length} TOC entries, ${Date.now() - t0} ms`);
  const located = Object.values(pag.spans).filter(Boolean).length;
  check('War and Peace EPUB2: every TOC entry located', located >= info.chapters.length, `${located}/${info.chapters.length}`);
  const starts = info.chapters.map((c) => pag.spans[c.id] && pag.spans[c.id].startPage).filter(Boolean);
  check('War and Peace EPUB2: chapter start pages ascend', starts.every((p, i) => i === 0 || p >= starts[i - 1]));
  const picks = [info.chapters[10], info.chapters[200]];
  await setMode(page, 'custom');
  await tick(page, picks.map((c) => c.id));
  const expected = uniqSorted(picks.flatMap((c) => range(pag.spans[c.id].startPage, pag.spans[c.id].endPage)));
  const sel = await savePdf(app, page, 'war-and-peace-epub2-two-chapters-A4.pdf');
  const pdf = await verifyPdf(`War and Peace EPUB2 "${picks[0].label}" + "${picks[1].label}"`, sel, expected);
  const firstWord = picks[1].label.split(/\s+/).slice(-1)[0];
  const i2 = expected.indexOf(pag.spans[picks[1].id].startPage);
  check('War and Peace EPUB2: 2nd chosen chapter begins at its page', pdf.pages[i2].fullText.includes(firstWord), pdf.pages[i2].text.slice(0, 80));
}

async function scenarioSingleFlow(app, page) {
  const file = path.join(FIX, 'single-flow-war-and-peace.epub');
  const t0 = Date.now();
  const info = await openBook(page, file);
  await openPrintDialog(page);
  const pag = await setPaper(page, 'A4');
  const ms = Date.now() - t0;
  report.books.singleFlow = { file: path.basename(file), sections: info.sections, chapters: info.chapters.length, a4Pages: pag.totalPages, layoutMs: ms };
  check('Single-file book (one 3.8 MB XHTML): opens and paginates', info.sections === 1 && pag.totalPages > 1000, `${pag.totalPages} pages in ${ms} ms`);
  const located = info.chapters.filter((c) => pag.spans[c.id]).length;
  check('Single-file book: chapters found via in-file anchors', located === info.chapters.length, `${located}/${info.chapters.length} located, ${pag.warnings.missingAnchors} missing anchors`);
  const distinct = new Set(info.chapters.map((c) => pag.spans[c.id] && pag.spans[c.id].startPage)).size;
  check('Single-file book: chapters get their own start pages', distinct > info.chapters.length * 0.9, `${distinct} distinct start pages`);

  const part = info.chapters.find((c) => /^BOOK TWO/.test(c.label));
  await setMode(page, 'custom');
  await tick(page, [part.id]);
  const partSpan = pag.spans[part.id];
  const children = info.chapters.filter((c) => c.depth === 1 && pag.spans[c.id] && pag.spans[c.id].startPage >= partSpan.startPage && pag.spans[c.id].endPage <= partSpan.endPage);
  const sText = await summary(page);
  check('Single-file book: ticking a part ticks its chapters', sText.startsWith(`${partSpan.endPage - partSpan.startPage + 1} pages / ${children.length} chapters selected`), sText);
  await page.screenshot({ path: path.join(SCREENS, '05-print-dialog-part.png') });
  const sel = await savePdf(app, page, 'single-flow-book-two-A4.pdf');
  const pdf = await verifyPdf(`Single-file "${part.label}"`, sel, range(partSpan.startPage, partSpan.endPage));
  check('Single-file book: part output starts with its heading', /BOOK TWO/.test(pdf.pages[0].fullText), pdf.pages[0].text.slice(0, 60));

  // Reader follows the reading position inside the single file.
  await page.evaluate((id) => document.querySelector(`#toc a[data-id="${id}"]`).click(), children[3].id);
  await page.waitForFunction((id) => document.querySelector(`#toc a.current`)?.dataset.id === id, children[3].id, { timeout: 20000 }).catch(() => {});
  const current = await page.$eval('#toc a.current', (a) => a.dataset.id).catch(() => null);
  check('Single-file book: contents highlight follows in-file navigation', current === children[3].id, `${current} vs ${children[3].id}`);
  await page.screenshot({ path: path.join(SCREENS, '06-reader-single-flow.png') });
}

async function scenarioCancel(app, page) {
  const file = path.join(FIX, 'single-flow-war-and-peace.epub');
  await page.evaluate((p) => window.WolfApp.openPath(p), file);
  await page.waitForSelector('#reader:not([hidden])', { timeout: 60000 });
  await openPrintDialog(page);
  const preparingShown = await page.waitForSelector('#preparing:not([hidden])', { timeout: 5000 }).then(() => true, () => false);
  await page.screenshot({ path: path.join(SCREENS, '07-preparing.png') });
  await page.click('#preparing-cancel');
  await page.waitForFunction(() => window.WolfApp.state.layout.status === 'cancelled', null, { timeout: 30000 });
  const status = await page.$eval('#print-status', (e) => e.innerText);
  check('Cancel while laying out: stops cleanly with a message', preparingShown && /cancelled/i.test(status), status.replace(/\s+/g, ' '));
  const windows = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
  check('Cancel: hidden print window is torn down', windows === 1, `${windows} window(s)`);
  await page.click('#print-modal .modal-footer [data-close]');
  await openPrintDialog(page);
  const pag = await layoutReady(page);
  check('Cancel: reopening the print dialog restarts layout', pag.totalPages > 1000, `${pag.totalPages} pages`);
  await page.click('#print-modal .modal-footer [data-close]');
}

async function scenarioNoToc(app, page) {
  const info = await openBook(page, path.join(FIX, 'no-toc.epub'));
  check('No-TOC book: opens, falls back to spine order', info.hasToc === false && info.sections === 3);
  const note = await page.$eval('#toc-note', (e) => (e.hidden ? '' : e.textContent));
  check('No-TOC book: sidebar explains the fallback', /no usable table of contents/i.test(note), note);
  await openPrintDialog(page);
  const pag = await setPaper(page, 'A4');
  await setMode(page, 'custom');
  const chNote = await page.$eval('#chapters-note', (e) => (e.hidden ? '' : e.textContent));
  check('No-TOC book: print dialog says chapter choice is unavailable', /can’t be picked by name/.test(chNote), chNote);
  await page.screenshot({ path: path.join(SCREENS, '08-print-dialog-no-toc.png') });
  await page.fill('#page-range', `2-${pag.totalPages}`);
  const sel = await savePdf(app, page, 'no-toc-pages.pdf');
  await verifyPdf('No-TOC book page range', sel, range(2, pag.totalPages));
}

async function scenarioBrokenToc(app, page) {
  const t0 = Date.now();
  const info = await openBook(page, path.join(FIX, 'broken-toc.epub'));
  check('Package with a bare "&" in its title opens (lenient XML repair)', info.title === 'Broken Contents & Bad Markup', `${info.title} in ${Date.now() - t0} ms`);
  const pag = info.layout.pagination;
  const byLabel = Object.fromEntries(info.chapters.map((c) => [c.label, c]));
  const missing = byLabel['Two (points to a missing file)'];
  check('Broken TOC: entry to a missing file is marked unavailable', missing.sectionIndex === null && pag.spans[missing.id] === null);
  const noAnchor = byLabel['Three (missing anchor)'];
  check('Broken TOC: missing anchor falls back to its file start', pag.spans[noAnchor.id] && pag.spans[noAnchor.id].startPage === pag.sectionStarts[1], JSON.stringify(pag.spans[noAnchor.id]));
  const late = byLabel['Four (anchor deep inside a chapter)'];
  check('Broken TOC: deep anchor starts after its file start', pag.spans[late.id].startPage > pag.sectionStarts[2], `file starts p.${pag.sectionStarts[2]}, anchor p.${pag.spans[late.id].startPage}`);
  await openPrintDialog(page);
  await setMode(page, 'all');
  const whole = await savePdf(app, page, 'broken-toc-whole.pdf');
  const pdf = await inspectPdf(whole);
  const all = pdf.pages.map((p) => p.fullText).join(' ');
  check('Broken TOC: malformed XHTML still printed (HTML-parser fallback)', all.includes('Two & a half') && all.includes('Unclosed paragraph'));
  check('Broken TOC: book scripts never ran in the print layout', pdf.title === info.title && !all.includes('pwned'), `PDF title "${pdf.title}"`);
}

async function scenarioEmbeddedFont(app, page) {
  const manifest = JSON.parse(fs.readFileSync(path.join(FIX, 'manifest.json'), 'utf8'));
  const meta = manifest.results.find((r) => r.name === 'embedded-font.epub');
  if (!meta) return;
  const info = await openBook(page, path.join(FIX, 'embedded-font.epub'));
  check('Nav document in sub-folder: both entries resolved (incl. first spine item)', info.chapters.length === 2 && info.chapters.every((c) => c.sectionIndex !== null), info.chapters.map((c) => `${c.label}→${c.sectionIndex}`).join(', '));
  const sha = await page.evaluate(async (bookId) => {
    const buf = await (await fetch(`wolfreader://app/book/${bookId}/OEBPS/fonts/wolf.ttf`)).arrayBuffer();
    const digest = await crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }, await page.evaluate(() => window.WolfApp.state.bookId));
  check('Obfuscated embedded font is de-obfuscated', sha === meta.fontSha256, sha.slice(0, 16) + '…');
  await openPrintDialog(page);
  await setPaper(page, 'A4');
  const whole = await savePdf(app, page, 'embedded-font-whole.pdf');
  const fonts = await pdfFonts(whole);
  check('Embedded font is used in the printed PDF', fonts.some((f) => /DejaVuSerif/.test(f)), fonts.join(', '));
  // Clicking the first contents entry navigates (epub.js index-0 lookup bug is patched).
  await page.evaluate(() => document.querySelector('#toc a[data-id="t1"]').click());
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelector('#toc a[data-id="t0"]').click());
  await page.waitForTimeout(800);
  const notice = await page.$eval('#reader-notice', (e) => e.hidden);
  check('Contents click on first spine item works', notice === true);
}

async function scenarioErrors(app, page) {
  const cases = [
    ['drm-encrypted.epub', /DRM/, /DRM-protected/],
    ['drm-adobe.epub', /Adobe DRM/, /DRM-protected/],
    ['empty-spine.epub', /no readable content/, /can’t be opened/],
    ['truncated-download.epub', /not a valid EPUB/, /can’t be opened/],
    ['not-a-zip.epub', /not a valid EPUB/, /can’t be opened/],
    ['zero-bytes.epub', /empty/, /can’t be opened/],
    ['does-not-exist.epub', /could not be found/, /can’t be opened/],
    ['damaged-opf.epub', /package document .*damaged/, /couldn’t be read/],
  ];
  await page.evaluate(() => window.WolfApp.closeBook());
  for (const [name, msgRe, titleRe] of cases) {
    const t0 = Date.now();
    await page.evaluate((p) => window.WolfApp.openPath(p), path.join(FIX, name));
    await page.waitForSelector('#welcome-error:not([hidden])', { timeout: 30000 });
    const ms = Date.now() - t0;
    const text = await page.$eval('#welcome-error', (e) => e.innerText.replace(/\s+/g, ' '));
    check(`Error file ${name}: friendly message within ${ms} ms, no crash`, msgRe.test(text) && titleRe.test(text) && !/at \w+ \(|Error:/.test(text) && ms < 5000, text);
  }
  await page.screenshot({ path: path.join(SCREENS, '09-welcome-error.png') });

  // A bad file while a good book is open keeps the good book open.
  await openBook(page, path.join(SAMPLES, 'alice-pg11-images-3.epub'));
  await page.evaluate((p) => window.WolfApp.openPath(p), path.join(FIX, 'drm-encrypted.epub'));
  await page.waitForSelector('#toast:not([hidden])');
  const still = await page.evaluate(() => ({ reader: !document.getElementById('reader').hidden, title: window.WolfApp.state.info && window.WolfApp.state.info.title }));
  check('Bad file while a book is open: current book stays open', still.reader && /Alice/.test(still.title), JSON.stringify(still));
}

async function scenarioWelcomeAndAbout(app, page) {
  await page.evaluate(() => window.WolfApp.closeBook());
  await page.screenshot({ path: path.join(SCREENS, '00-welcome.png') });
  await page.click('#btn-about');
  await page.waitForSelector('#about-modal:not([hidden])');
  const ver = await page.$eval('#about-version', (e) => e.textContent);
  check('About dialog shows product name and version', /Version 1\.0\.0/.test(ver), ver);
  await page.screenshot({ path: path.join(SCREENS, '10-about.png') });
  await page.keyboard.press('Escape');
  const title = await page.title();
  const winTitle = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle());
  check('Window title is "Wolfreader"', title === 'Wolfreader' && winTitle === 'Wolfreader', winTitle);
}

/* ---------------- main ---------------- */

(async () => {
  ({ inspectPdf } = await import('../tools/pdf-inspect.mjs'));
  ({ pdfFonts } = await import('../tools/pdf-fonts.mjs'));
  for (const f of ['alice-pg11-images-3.epub', 'alice-rackham-pg28885-images-3.epub', 'war-and-peace-pg2600-epub2.epub']) {
    if (!fs.existsSync(path.join(SAMPLES, f))) {
      console.error(`Missing sample ${f}. Run: bash scripts/fetch-samples.sh`);
      process.exit(2);
    }
  }

  // Launch with a book on the command line, exactly like a double-clicked .epub.
  const first = path.join(SAMPLES, 'alice-pg11-images-3.epub');
  const { app, page, consoleErrors } = await launch(first);
  const argvInfo = await waitForBook(page);
  check('Opening a book passed on the command line (file association)', argvInfo.title === "Alice's Adventures in Wonderland", argvInfo.title);

  const scenarios = [
    scenarioCleanToc,
    scenarioImages,
    scenarioLargeEpub2,
    scenarioSingleFlow,
    scenarioCancel,
    scenarioNoToc,
    scenarioBrokenToc,
    scenarioEmbeddedFont,
    scenarioErrors,
    scenarioWelcomeAndAbout,
  ];
  // `--only=scenarioEmbeddedFont,scenarioImages` runs a subset while iterating.
  const onlyArg = process.argv.find((a) => a.startsWith('--only='));
  const only = onlyArg ? onlyArg.slice('--only='.length).split(',') : null;
  for (const s of scenarios.filter((fn) => !only || only.includes(fn.name))) {
    try {
      await s(app, page);
    } catch (err) {
      check(`${s.name} completed without exceptions`, false, err.stack.split('\n').slice(0, 3).join(' | '));
      await page.screenshot({ path: path.join(SCREENS, `fail-${s.name}.png`) }).catch(() => {});
      await page.evaluate(() => {
        document.getElementById('print-modal').hidden = true;
      }).catch(() => {});
    }
  }

  // 404s are expected (broken-book fixtures, epub.js probing optional files) and so is
  // the logged failure of the deliberately damaged package document.
  // The broken-toc fixture contains a <script> and an onclick handler on purpose:
  // seeing them blocked by the reader's sandbox/CSP is the expected outcome.
  const expectedNoise = [
    /Failed to load resource/,
    /Book failed to load Error: damaged package/,
    /Blocked script execution in 'about:srcdoc' because the document's frame is sandboxed/,
    /Executing inline event handler violates the following Content Security Policy/,
  ];
  const unexpected = consoleErrors.filter((e) => !expectedNoise.some((re) => re.test(e)));
  const blocked = consoleErrors.filter((e) => /Blocked script execution|inline event handler violates/.test(e)).length;
  if (!only || only.includes('scenarioBrokenToc')) {
    check('Book scripts/handlers are blocked in the reading pane (sandbox + CSP)', blocked > 0, `${blocked} blocked attempt(s) logged`);
  }
  check('No unexpected errors in the UI console', unexpected.length === 0, unexpected.slice(0, 3).join(' | ') || 'none');
  const alive = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length > 0);
  check('App still running after all scenarios', alive);
  await app.close();

  report.finishedAt = new Date().toISOString();
  report.passed = checks.filter((c) => c.ok).length;
  report.failed = checks.filter((c) => !c.ok).length;
  fs.writeFileSync(path.join(OUT, 'e2e-report.json'), JSON.stringify(report, null, 2));
  console.log(`\n${report.passed} passed, ${report.failed} failed  (report: test/output/e2e-report.json)`);
  process.exit(report.failed ? 1 : 0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
