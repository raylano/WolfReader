'use strict';
// Quick manual check: node test/e2e/smoke.js <book.epub> [screenshot-name]
const path = require('path');
const { launch, waitForBook, OUT } = require('./harness');

(async () => {
  const epub = path.resolve(process.argv[2]);
  const name = process.argv[3] || 'smoke';
  const { app, page, consoleErrors } = await launch(epub);
  const t0 = Date.now();
  try {
    const info = await waitForBook(page);
    const pag = info.layout.pagination;
    console.log(JSON.stringify({
      title: info.title,
      author: info.author,
      hasToc: info.hasToc,
      sections: info.sections,
      chapters: info.chapters.length,
      layout: info.layout.status,
      error: info.layout.error,
      totalPages: pag && pag.totalPages,
      firstSpans: pag && Object.entries(pag.spans).slice(0, 6),
      warnings: pag && pag.warnings,
      ms: Date.now() - t0,
    }, null, 1));
    await page.waitForTimeout(800);
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
  } finally {
    console.log('console errors:', consoleErrors.slice(0, 10));
    await app.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
