'use strict';
/*
 * The print layout embeds an invisible 2px link at the start of every spine
 * section and every table-of-contents target. Chromium turns each into a link
 * annotation on whichever printed page it lands on, so reading those
 * annotations back tells us exactly which page every chapter starts on.
 */
const { PDFDocument, PDFName, PDFDict, PDFArray } = require('pdf-lib');

const MARKER_PREFIX = 'https://wolfreader.invalid/marker/';

function annotationUri(annot) {
  if (!(annot instanceof PDFDict)) return null;
  const action = annot.lookupMaybe(PDFName.of('A'), PDFDict);
  const uri = action && action.get(PDFName.of('URI'));
  return uri && typeof uri.decodeText === 'function' ? uri.decodeText() : null;
}

function pageAnnotations(page) {
  return page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
}

/**
 * @returns {Promise<{pageCount:number, markers: Map<string, number>}>} marker key -> first 1-based page
 */
async function readMarkers(pdfBytes) {
  const doc = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const markers = new Map();
  doc.getPages().forEach((page, index) => {
    const annots = pageAnnotations(page);
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const uri = annotationUri(annots.lookup(i));
      if (uri && uri.startsWith(MARKER_PREFIX)) {
        const key = uri.slice(MARKER_PREFIX.length);
        if (!markers.has(key)) markers.set(key, index + 1);
      }
    }
  });
  return { pageCount: doc.getPageCount(), markers };
}

function stripMarkers(doc) {
  for (const page of doc.getPages()) {
    const annots = pageAnnotations(page);
    if (!annots) continue;
    const keep = [];
    for (let i = 0; i < annots.size(); i++) {
      const uri = annotationUri(annots.lookup(i));
      if (!(uri && uri.startsWith(MARKER_PREFIX))) keep.push(annots.get(i));
    }
    if (keep.length === 0) page.node.delete(PDFName.of('Annots'));
    else if (keep.length !== annots.size()) page.node.set(PDFName.of('Annots'), doc.context.obj(keep));
  }
}

/**
 * Builds a PDF containing only `pages` (1-based, ascending) of the laid-out book.
 * @returns {Promise<Uint8Array>}
 */
async function buildSelectionPdf(pdfBytes, pages, { title, author } = {}) {
  const source = await PDFDocument.load(pdfBytes, { updateMetadata: false });
  const total = source.getPageCount();
  const indices = pages.map((p) => p - 1).filter((i) => i >= 0 && i < total);
  if (indices.length === 0) throw new Error('No pages selected');

  let out;
  if (indices.length === total) {
    out = source;
  } else {
    out = await PDFDocument.create();
    const copied = await out.copyPages(source, indices);
    copied.forEach((p) => out.addPage(p));
  }
  stripMarkers(out);
  if (title) out.setTitle(title);
  if (author) out.setAuthor(author);
  out.setCreator('Wolfreader');
  out.setProducer('Wolfreader');
  return out.save();
}

module.exports = { MARKER_PREFIX, readMarkers, buildSelectionPdf };
