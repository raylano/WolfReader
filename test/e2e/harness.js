'use strict';
// Shared helpers for driving the real Wolfreader app through Playwright's Electron support.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { _electron: electron } = require('playwright-core');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'test', 'output');

async function launch(epubPath) {
  fs.mkdirSync(OUT, { recursive: true });
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfreader-test-'));
  const args = [];
  // Linux CI/dev boxes often run as root, where Chromium refuses its sandbox.
  if (process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  args.push(ROOT);
  if (epubPath) args.push(epubPath);
  const app = await electron.launch({
    executablePath: require('electron'),
    args,
    cwd: ROOT,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: '0', WOLFREADER_USER_DATA: userData },
    timeout: 60000,
  });
  app.on('close', () => fs.rmSync(userData, { recursive: true, force: true }));
  const page = await app.firstWindow();
  const consoleErrors = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => consoleErrors.push('pageerror: ' + err.message));
  await page.waitForLoadState('domcontentloaded');
  return { app, page, consoleErrors };
}

/** Waits until the book is shown and its print layout is ready (or failed). */
async function waitForBook(page, timeout = 240000) {
  await page.waitForSelector('#reader:not([hidden])', { timeout: 60000 });
  await page.waitForFunction(
    () => ['ready', 'error'].includes(window.WolfApp.state.layout.status),
    null,
    { timeout, polling: 250 },
  );
  return page.evaluate(() => {
    const s = window.WolfApp.state;
    return {
      title: s.info.title,
      author: s.info.author,
      hasToc: s.hasToc,
      chapters: s.chapters.map((c) => ({ id: c.id, label: c.label, depth: c.depth, sectionIndex: c.sectionIndex, fragment: c.fragment })),
      sections: s.sections.length,
      layout: { status: s.layout.status, error: s.layout.error, pagination: s.layout.pagination },
    };
  });
}

/** Replaces the native save dialog so "Save as PDF" writes to `filePath`. */
async function stubSaveDialog(app, filePath) {
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, filePath);
}

module.exports = { ROOT, OUT, launch, waitForBook, stubSaveDialog };
