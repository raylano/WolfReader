// Inspects a PDF with pdf.js (no native tools needed): per-page text, the
// running header / footer (by position), link annotations and image draws.
// CLI: node test/tools/pdf-inspect.mjs file.pdf [maxCharsPerPage]
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function inspectPdf(file, { maxChars = 160, countImages = false } = {}) {
  const data = new Uint8Array(fs.readFileSync(file));
  const task = getDocument({ data, useSystemFonts: false, verbosity: 0 });
  const doc = await task.promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const { width, height } = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    const items = content.items.filter((it) => it.str && it.str.trim());
    const y = (it) => it.transform[5];
    const join = (list) => list.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();
    // Page margins are 20mm (~57pt); header/footer boxes live inside them.
    const header = join(items.filter((it) => y(it) > height - 57));
    const footer = join(items.filter((it) => y(it) < 57));
    const body = join(items.filter((it) => y(it) >= 57 && y(it) <= height - 57));
    const annotations = (await page.getAnnotations()).filter((a) => a.url).map((a) => a.url);
    let images = 0;
    if (countImages) {
      const ops = await page.getOperatorList();
      images = ops.fnArray.filter((f) => f === OPS.paintImageXObject || f === OPS.paintInlineImageXObject).length;
    }
    pages.push({
      page: i,
      width: Math.round(width),
      height: Math.round(height),
      header,
      footer,
      text: body.slice(0, maxChars),
      fullText: body,
      annotations,
      images,
    });
  }
  const meta = await doc.getMetadata().catch(() => ({}));
  await task.destroy();
  return { numPages: pages.length, title: meta.info && meta.info.Title, pages };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await inspectPdf(process.argv[2], { maxChars: Number(process.argv[3]) || 160, countImages: true });
  console.log(`pages: ${result.numPages}  title: ${result.title || ''}`);
  for (const p of result.pages) {
    console.log(
      `#${p.page} [${p.width}x${p.height}pt] footer="${p.footer}" header="${p.header}"` +
        `${p.images ? ` images=${p.images}` : ''}${p.annotations.length ? ' links=' + p.annotations.join(',') : ''} | ${p.text}`,
    );
  }
}
