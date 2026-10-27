#!/usr/bin/env node
/*
 * Inspects the electron-builder output without running Windows:
 *   - release/Wolfreader-Setup-<version>.exe is a PE32 NSIS installer with the Wolfreader icon
 *   - release/win-unpacked/Wolfreader.exe carries Wolfreader version info + all icon sizes
 *   - app.asar contains the app (and not the tests)
 * Usage: node test/tools/verify-package.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const asar = require('@electron/asar');
const ResEdit = require('resedit');

const ROOT = path.join(__dirname, '..', '..');
const pkg = require(path.join(ROOT, 'package.json'));
const REL = path.join(ROOT, 'release');
const installer = path.join(REL, `Wolfreader-Setup-${pkg.version}.exe`);
const appExe = path.join(REL, 'win-unpacked', 'Wolfreader.exe');
const appAsar = path.join(REL, 'win-unpacked', 'resources', 'app.asar');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

function iconSizes(exePath) {
  const exe = ResEdit.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
  const res = ResEdit.NtExecutableResource.from(exe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  const sizes = new Set();
  for (const g of groups) for (const icon of g.icons) sizes.add(icon.width || 256);
  const versions = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  const strings = versions.length ? versions[0].getAllLanguagesForStringValues().map((l) => versions[0].getStringValues(l))[0] : {};
  return { sizes: [...sizes].sort((a, b) => a - b), strings, is64: exe.newHeader.is32bit() === false };
}

// 1. Installer
check('Installer exists', fs.existsSync(installer), installer);
const instBuf = fs.readFileSync(installer);
check('Installer is a Windows PE executable', instBuf.subarray(0, 2).toString() === 'MZ', `${(instBuf.length / 1048576).toFixed(1)} MB (${instBuf.length} bytes)`);
check('Installer is an NSIS package', instBuf.includes('Nullsoft') || instBuf.includes('NullsoftInst'));
const inst = iconSizes(installer);
check('Installer carries the Wolfreader icon', inst.sizes.length > 0, `icon sizes ${inst.sizes.join(',')}`);

// 2. Application executable
const app = iconSizes(appExe);
check('Wolfreader.exe is 64-bit', app.is64);
check('Wolfreader.exe ProductName is "Wolfreader"', app.strings.ProductName === 'Wolfreader', JSON.stringify({ ProductName: app.strings.ProductName, FileDescription: app.strings.FileDescription, ProductVersion: app.strings.ProductVersion }));
const icoSizes = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'build', 'icon.ico'))).icons.map((i) => i.width || 256);
check('Wolfreader.exe has every icon size from build/icon.ico', icoSizes.every((s) => app.sizes.includes(s)), `exe: ${app.sizes.join(',')} / ico: ${icoSizes.join(',')}`);

// 3. Packaged app contents
const files = asar.listPackage(appAsar).map((f) => f.replace(/\\/g, '/'));
const must = [
  '/package.json',
  '/src/main/main.js',
  '/src/main/print-engine.js',
  '/src/preload/preload.js',
  '/src/renderer/index.html',
  '/src/renderer/print-layout.js',
  '/src/renderer/vendor/epub.min.js',
  '/src/renderer/img/logo.png',
  '/src/shared/selection.js',
  '/node_modules/pdf-lib/package.json',
  '/node_modules/yauzl/package.json',
];
const missing = must.filter((m) => !files.includes(m));
check('app.asar contains the app and its runtime dependencies', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${files.length} entries`);
const leaked = files.filter((f) => /^\/(test|scripts|assets\/branding|\.scratch)\//.test(f) || /node_modules\/(electron|epubjs|playwright-core|pdfjs-dist)\//.test(f));
check('app.asar contains no tests or dev-only packages', leaked.length === 0, leaked.slice(0, 5).join(', '));
const packedPkg = JSON.parse(asar.extractFile(appAsar, 'package.json').toString());
check('Packaged package.json: name/productName/version', packedPkg.name === 'wolfreader' && packedPkg.productName === 'Wolfreader', `${packedPkg.name} / ${packedPkg.productName} / ${packedPkg.version}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nAll package checks passed');
process.exit(failures ? 1 : 0);
