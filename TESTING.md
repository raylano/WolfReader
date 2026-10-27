# Testing

How Wolfreader 1.0.0 was verified: unit tests, end-to-end runs against real books, PDF
inspection, installer build and package checks — and what could **not** be checked, because
no real Windows machine or physical printer was available.

All results below are from a single run on **2026-10-27**, on a Linux host (Node v22.22.0,
npm 10.9.4, `xvfb-run`, Wine 8.0 32-bit-only).

## 1. Unit tests — `npm test`

```bash
npm test            # runs node --test "test/unit/**/*.test.js" (needs Node ≥ 21)
```

**Result: 11 tests, 11 pass, 0 fail, 0 skip** (~102 ms).

- `test/unit/selection.test.js` (7 tests) — page-range parsing (separators, open and
  reversed ranges), invalid input handling, ranges folding and formatting, chapter span
  depth-cascading, same-page chapter starts, selection union.
- `test/unit/epub-archive.test.js` (4 tests) — opening a valid book with case-insensitive
  entries; rejection with error codes for non-zip, empty, DRM and empty-spine files; IDPF
  font-obfuscation deobfuscation not misread as DRM; bare-ampersand XML repair.

## 2. End-to-end tests — `npm run test:e2e`

```bash
npm run samples     # first: download the Project Gutenberg sample books
npm run test:e2e    # build → generate fixtures → drive the real app under Xvfb
```

`npm run test:e2e` runs `npm run build`, generates the fixtures
(`test/fixtures/make-fixtures.js`) and launches the real Electron app via Playwright under
`xvfb-run` against real EPUBs: 4 Project Gutenberg samples (Alice pg11, Alice Rackham
pg28885, War and Peace pg2600 in EPUB2 and EPUB3) plus 11 generated fixtures
(single-flow 3.8 MB book, no-toc, broken-toc, embedded-font, drm-encrypted, drm-adobe,
empty-spine, damaged-opf, truncated-download, not-a-zip, zero-bytes). Save dialogs are
stubbed to `test/output/`.

**Result: 92 checks passed, 0 failed.** Report: `test/output/e2e-report.json`; scenario
screenshots in `test/output/screens/` (no failure shots).

Checks per scenario (all green):

- **Alice, clean TOC — 30**: open / TOC mapping / render, A4 + Letter pagination,
  whole-book print, chapters + page-range selection, range-only print, invalid input
  blocking, select all/none, parity with Chromium's `printToPDF` page ranges.
- **Rackham images — 10**: illustration counts preserved exactly in selections.
- **War and Peace EPUB2 — 7**: >1000 pages, 2-chapter selection.
- **Single-flow book — 9**: in-file anchors, part-tick cascade, TOC highlight.
- **No-TOC book — 6**: spine fallback.
- **Error files — 8**: friendly message within 5 s, no crash, previously opened good book
  stays open.
- **Broken-TOC book — 5**: bare-`&` repair, missing file/anchor, parser fallback, scripts
  blocked.
- **Embedded font — 2**.
- **Remaining checks — 15**: file association via command line, cancel mid-layout +
  reopen, CSP enforcement, About version, window title, console cleanliness, app alive,
  no-printer UI, graceful failure on a nonexistent printer, deep anchor starts after its
  file start.

## 3. PDF inspection — `node test/tools/pdf-inspect.mjs`

Independent inspection (pdf.js) of the produced PDFs in `test/output/`, beyond the suite's
own assertions:

- **Whole book** (`alice-whole-A4.pdf`): 62 pages, footers exactly 1–62, all twelve chapter
  headings (CHAPTER I–XII) present, page size 595×842 pt (A4).
- **Chapter + page selection** (chapters II & V plus pages `1-2, 40`): 11 pages, footer
  numbers exactly 1, 2, 9, 10, 11, 20, 21, 22, 23, 24, 40; only the headings “CHAPTER II.
  The Pool of Tears” and “CHAPTER V. Advice from a Caterpillar” present; cover image +
  Gutenberg frontmatter with working link annotations.
- **Page-range-only selection** (`5-7`): 3 pages, footers exactly 5, 6, 7, continuous
  CHAPTER I text as expected.
- All three PDFs carry title metadata “Alice's Adventures in Wonderland”.
- **Embedded-font scenario**: `test/tools/pdf-fonts.mjs` shows subset fonts
  `AAAAAA+LiberationSerif`, `BAAAAA+DejaVuSerif-Bold`, `CAAAAA+LiberationSerif-Italic` —
  the book's obfuscated embedded font was loaded, deobfuscated and embedded as
  DejaVuSerif.

## 4. Installer build — `npm run dist`

```bash
npm run dist        # npm run build && electron-builder --win nsis --x64
```

Built on Linux with electron-builder 26.18.0 and Electron 45.0.0. Artifacts (built
2026-10-27 14:21):

- `release/Wolfreader-Setup-1.0.0.exe` — 123,719,401 bytes (≈ 118 MB)
- `release/Wolfreader-Setup-1.0.0.exe.blockmap` — 131,446 bytes
- `release/win-unpacked/Wolfreader.exe` — 249,959,936 bytes

Code signing was skipped (no certificate configured).

## 5. Package verification — `npm run verify:package`

**All 10 checks PASS**: installer exists; is a Windows PE executable; is an NSIS package;
carries the Wolfreader icon (sizes 16–256); `win-unpacked/Wolfreader.exe` is 64-bit;
ProductName “Wolfreader” (ProductVersion 1.0.0.0); the exe has every icon size from
`build/icon.ico`; `app.asar` contains the app plus runtime deps pdf-lib/yauzl (622 entries);
`app.asar` contains no tests or dev-only packages; packaged `package.json`
name/productName/version correct.

## 6. Installer-under-Wine check — `npm run verify:wine-install` — SKIPPED

Exit code 3 (SKIP): *“This Wine build created a win32 prefix; the x64 installer needs win64
Wine (install wine64).”* The host has Wine 8.0 (Debian) 32-bit-only. The silent
install/uninstall/shortcut/registry checks therefore did **not** run; installer structure
was still validated by `verify:package` (§5).

## 7. What is NOT verified (explicit gap)

- **No real Windows machine was available** — the installer was never run on Windows. Real
  install/uninstall UX, shortcut creation, `.epub` file-association double-click behavior,
  SmartScreen/driver prompts and app performance on Windows are unverified.
- **No physical printer was available** — the actual Windows print spooler, real printer
  drivers, duplex/color handoff and printed output on paper are unverified. All print-path
  verification is via Electron's `printToPDF` and PDF inspection (§3).
- **Wine silent-install check skipped** (see §6) because only 32-bit Wine is installed.

## How to re-run

```bash
npm install               # dependencies
npm run build             # copies epub.js into src/renderer/vendor
npm run samples           # downloads the Gutenberg samples (gitignored — needed before test:e2e)
npm test                  # unit tests
npm run test:e2e          # end-to-end tests (needs xvfb-run)
npm run dist              # Windows installer -> release/
npm run verify:package    # inspect the built installer + exe
npm run verify:wine-install  # silent install under Wine (needs win64 Wine)
```

Artifacts land in `test/output/` (e2e report, screenshots, produced PDFs) and `release/`
(installer, blockmap, unpacked app).
