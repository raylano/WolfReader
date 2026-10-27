// Lists the fonts used on each page of a PDF. CLI: node test/tools/pdf-fonts.mjs file.pdf
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { getDocument, OPS } from 'pdfjs-dist/legacy/build/pdf.mjs';

export async function pdfFonts(file) {
  const task = getDocument({ data: new Uint8Array(fs.readFileSync(file)), verbosity: 0, fontExtraProperties: true });
  const doc = await task.promise;
  const names = new Set();
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const ops = await page.getOperatorList();
    for (let j = 0; j < ops.fnArray.length; j++) {
      if (ops.fnArray[j] !== OPS.setFont) continue;
      const id = ops.argsArray[j][0];
      const font = page.commonObjs.has(id) ? page.commonObjs.get(id) : null;
      if (font) names.add(font.name || font.loadedName);
    }
  }
  await task.destroy();
  return [...names];
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log((await pdfFonts(process.argv[2])).join('\n'));
}
