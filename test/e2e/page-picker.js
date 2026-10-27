'use strict';
/*
 * End-to-end check of the print dialog's expandable chapters: open a chapter,
 * untick/tick single pages, see a page preview, save the result as PDF.
 * Builds its own small EPUB (no downloads). Run: xvfb-run -a node test/e2e/page-picker.js
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { launch, waitForBook, stubSaveDialog, ROOT, OUT } = require('./harness');

const checks = [];
function check(name, ok, detail) {
  checks.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`);
}

async function makeBook(file) {
  const words = 'the wolf read on by lantern light while snow fell softly over the quiet pines'.split(' ');
  const text = (seed) =>
    Array.from({ length: 40 }, (_, i) => `<p>${Array.from({ length: 70 }, (_, w) => words[(i * 7 + w * 3 + seed) % words.length]).join(' ')}.</p>`).join('\n');
  const doc = (t, b) => `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${t}</title></head><body>${b}</body></html>`;
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="b"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="b">urn:x:picker</dc:identifier><dc:title>Picker Book</dc:title><dc:creator>Test</dc:creator><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="c2.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/><itemref idref="c2"/></spine></package>`);
  zip.file('OEBPS/nav.xhtml', doc('Contents', '<nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li><li><a href="c2.xhtml">Two</a></li></ol></nav>'));
  zip.file('OEBPS/c1.xhtml', doc('One', `<h1>One</h1>${text(1)}`));
  zip.file('OEBPS/c2.xhtml', doc('Two', `<h1>Two</h1>${text(5)}`));
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' }));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const epub = path.join(OUT, 'picker-book.epub');
  await makeBook(epub);
  const { app, page, consoleErrors } = await launch();
  try {
    await page.evaluate((p) => window.WolfApp.openPath(p), epub);
    const info = await waitForBook(page);
    const pag = info.layout.pagination;
    const [c1, c2] = info.chapters.map((c) => c.id);
    check('layout ready with two chapters', info.layout.status === 'ready' && pag.spans[c1] && pag.spans[c2], `${pag.totalPages} pages`);

    await page.click('#btn-print');
    await page.waitForSelector('#print-modal:not([hidden])');
    await page.check('input[name="print-mode"][value="custom"]');
    await page.check(`#chapter-list input[data-id="${c1}"]`);
    const n1 = pag.spans[c1].endPage - pag.spans[c1].startPage + 1;
    const summary = () => page.$eval('#selection-summary', (e) => e.innerText.replace(/\s+/g, ' ').trim());
    check('chapter 1 ticked', (await summary()).startsWith(`${n1} page`), await summary());

    // expand chapter 1
    await page.click(`.ch-toggle[data-toggle="${c1}"]`);
    const chips = await page.$$eval(`li[data-id="${c1}"] .page-chip`, (els) => els.map((e) => ({ page: +e.dataset.page, on: e.classList.contains('on') })));
    check('expanded chapter lists every page, all selected', chips.length === n1 && chips.every((c) => c.on), `${chips.length} pages`);

    // untick one page
    const drop = chips[1].page;
    await page.uncheck(`li[data-id="${c1}"] .page-chip[data-page="${drop}"] input`);
    check('unticking a page lowers the count', (await summary()).startsWith(`${n1 - 1} page`), await summary());
    const half = await page.$eval(`#chapter-list input[data-id="${c1}"]`, (e) => e.indeterminate);
    check('chapter checkbox becomes half-ticked', half);

    // preview
    await page.click(`li[data-id="${c1}"] .page-chip[data-page="${drop}"] .pg-num`);
    await page.waitForFunction(() => { const c = document.getElementById('preview-canvas'); return !c.hidden && c.width > 0; }, null, { timeout: 30000 });
    const painted = await page.$eval('#preview-canvas', (c) => {
      const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i] < 128) return true;
      return false;
    });
    check('clicking a page shows a rendered preview', painted);
    check('preview shows the page is unselected', !(await page.$eval('#preview-include', (e) => e.checked)));
    await page.screenshot({ path: path.join(OUT, 'screens', '10-page-picker.png') });
    await page.check('#preview-include');
    check('preview checkbox re-selects the page', (await summary()).startsWith(`${n1} page`), await summary());
    await page.click('#preview-next');
    await page.waitForFunction((p) => document.getElementById('preview-label').textContent.includes(`page ${p}`), drop + 1);
    check('next arrow moves the preview', true);

    // select a page of chapter 2 individually, drop another of chapter 1, save
    await page.click(`.ch-toggle[data-toggle="${c2}"]`);
    const p2 = pag.spans[c2].startPage;
    await page.check(`li[data-id="${c2}"] .page-chip[data-page="${p2}"] input`);
    await page.uncheck(`li[data-id="${c1}"] .page-chip[data-page="${drop}"] input`);
    const expected = [];
    for (let p = pag.spans[c1].startPage; p <= pag.spans[c1].endPage; p++) if (p !== drop) expected.push(p);
    expected.push(p2);
    check('mixed selection counts correctly', (await summary()).startsWith(`${expected.length} page`), await summary());

    const out = path.join(OUT, 'picker-selection.pdf');
    fs.rmSync(out, { force: true });
    await stubSaveDialog(app, out);
    await page.click('#btn-save-pdf');
    await page.waitForSelector('#print-modal', { state: 'hidden', timeout: 60000 });
    for (let i = 0; i < 100 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 100));
    const { PDFDocument } = require('pdf-lib');
    const pdf = await PDFDocument.load(fs.readFileSync(out));
    check('saved PDF has exactly the picked pages', pdf.getPageCount() === expected.length, `${pdf.getPageCount()} / ${expected.length}`);
    const bad = consoleErrors.filter((e) => !/DevTools|Failed to load resource/.test(e));
    check('no console errors', bad.length === 0, bad.join(' | '));
  } finally {
    await app.close();
  }
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
