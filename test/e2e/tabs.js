'use strict';
/*
 * Tabs and single-instance hand-off: two books open as two tabs, switching keeps each book's
 * print layout, a book opened by a second process (as Explorer does) becomes a new tab, and
 * closing tabs works. Run: npm run test:tabs
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');
const JSZip = require('jszip');
const { _electron: electron } = require('playwright-core');
const { ROOT, OUT } = require('./harness');

const checks = [];
function check(name, ok, detail) {
  checks.push(Boolean(ok));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail !== undefined ? `  — ${detail}` : ''}`);
}

async function makeBook(file, title) {
  const doc = (t, b) => `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>${t}</title></head><body>${b}</body></html>`;
  const text = Array.from({ length: 30 }, (_, i) => `<p>${title} paragraph ${i} `.repeat(8) + '</p>').join('');
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  zip.file('OEBPS/content.opf', `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="b"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="b">urn:x:${title}</dc:identifier><dc:title>${title}</dc:title><dc:language>en</dc:language></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`);
  zip.file('OEBPS/nav.xhtml', doc('Contents', '<nav epub:type="toc"><ol><li><a href="c1.xhtml">One</a></li></ol></nav>'));
  zip.file('OEBPS/c1.xhtml', doc(title, `<h1>${title}</h1>${text}`));
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip' }));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const a = path.join(OUT, 'tabs-alpha.epub');
  const b = path.join(OUT, 'tabs-beta.epub');
  const c = path.join(OUT, 'tabs-gamma.epub');
  await makeBook(a, 'Alpha');
  await makeBook(b, 'Beta');
  await makeBook(c, 'Gamma');

  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfreader-tabs-'));
  const env = { ...process.env, WOLFREADER_USER_DATA: userData };
  const args = process.getuid && process.getuid() === 0 ? ['--no-sandbox', ROOT] : [ROOT];
  const app = await electron.launch({ executablePath: require('electron'), args, cwd: ROOT, env });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  const tabs = () => page.$$eval('#tabbar .tab', (els) => els.map((e) => ({ title: e.innerText.replace('×', '').trim(), active: e.classList.contains('active') })));
  const title = () => page.evaluate(() => window.WolfApp.state.info && window.WolfApp.state.info.title);
  const ready = (t) => page.waitForFunction((t) => { const s = window.WolfApp.state; return s.info && s.info.title === t && s.layout.status === 'ready'; }, t, { timeout: 120000 });

  try {
    await page.evaluate((p) => window.WolfApp.openPath(p), a);
    await ready('Alpha');
    await page.evaluate((p) => window.WolfApp.openPath(p), b);
    await ready('Beta');
    let t = await tabs();
    check('two books give two tabs, the new one active', t.length === 2 && t[1].active && t[1].title === 'Beta', JSON.stringify(t));

    await page.click('#tabbar .tab:first-child .tab-label');
    await page.waitForFunction(() => window.WolfApp.state.info && window.WolfApp.state.info.title === 'Alpha', null, { timeout: 30000 });
    const st = await page.evaluate(() => window.WolfApp.state.layout.status);
    check('switching back to a tab keeps its print layout', st === 'ready', st);
    check('reader shows the switched-to book', (await title()) === 'Alpha');

    await page.evaluate((p) => window.WolfApp.openPath(p), b);
    await page.waitForFunction(() => !window.WolfApp.state.opening && window.WolfApp.state.info.title === 'Beta', null, { timeout: 30000 }).catch(() => {});
    t = await tabs();
    check('opening an already open book switches to its tab', t.length === 2 && t[1].active, JSON.stringify(t));

    // a second process, as when double-clicking a .epub in Explorer
    await new Promise((r) => execFile(require('electron'), [...args, c], { cwd: ROOT, env }, () => r()));
    await ready('Gamma');
    t = await tabs();
    check('book opened by a second process becomes a new tab', t.length === 3 && t[2].active && t[2].title === 'Gamma', JSON.stringify(t));

    await page.click('#tabbar .tab.active .tab-close');
    await page.waitForFunction(() => window.WolfApp.state.info && window.WolfApp.state.info.title === 'Beta', null, { timeout: 30000 });
    t = await tabs();
    check('closing the active tab shows a neighbour', t.length === 2 && t[1].active, JSON.stringify(t));

    await page.click('#btn-print');
    await page.waitForSelector('#print-modal:not([hidden])');
    const heading = await page.$eval('#print-heading', (e) => e.textContent);
    check('print dialog is for the active book', /Beta/.test(heading), heading);
    await page.click('#print-modal [data-close]');

    await page.click('#tabbar .tab.active .tab-close');
    await page.click('#tabbar .tab.active .tab-close');
    await page.waitForSelector('#welcome:not([hidden])');
    check('closing the last tab returns to the welcome screen', (await tabs()).length === 0);
  } finally {
    await app.close();
    fs.rmSync(userData, { recursive: true, force: true });
  }
  process.exit(checks.every(Boolean) ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
