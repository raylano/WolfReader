#!/usr/bin/env node
// Copies browser-side vendor files into the renderer so the app runs without a bundler.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const vendorDir = path.join(root, 'src', 'renderer', 'vendor');

const pdfjsBuild = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'build');
const files = [
  { from: require.resolve('epubjs/dist/epub.min.js'), to: 'epub.min.js' },
  // page previews in the print dialog
  { from: path.join(pdfjsBuild, 'pdf.min.mjs'), to: 'pdf.min.mjs' },
  { from: path.join(pdfjsBuild, 'pdf.worker.min.mjs'), to: 'pdf.worker.min.mjs' },
];

fs.mkdirSync(vendorDir, { recursive: true });
for (const f of files) {
  fs.copyFileSync(f.from, path.join(vendorDir, f.to));
  console.log(`vendor: ${path.relative(root, f.from)} -> src/renderer/vendor/${f.to}`);
}
