# Wolfreader

<img src="src/renderer/img/logo.png" alt="Wolfreader logo" width="200" align="right" />

Wolfreader is a small Windows desktop app for **opening EPUB books and printing them** — the
entire book, or only the chapters and pages you pick.

- Open an `.epub` (Open button, drag-and-drop, or double-click a `.epub` file once installed)
- Read it: cover, title, author, table of contents and a comfortable reading pane
- Print:
  - **Entire book**, or
  - **Choose chapters or pages** — tick chapters from the book's table of contents, type page
    ranges such as `5-12, 20`, or both. A live counter shows *“X pages / Y chapters selected”*.
- Pick paper size (A4 / Letter), printer, copies, two-sided and color — or **Save as PDF**.

Wolfreader is deliberately simple: no library, bookmarks, sync or annotations.

## Using the installed app

1. Run `Wolfreader-Setup-1.0.1.exe` and follow the installer (per-user install, no admin
   rights needed; you can choose the folder). It adds Start Menu and desktop shortcuts and
   registers Wolfreader for `.epub` files.
2. Start **Wolfreader** and click **Open EPUB…** (or drop a `.epub` file on the window).
3. Click **Print** (or press **Ctrl+P**).
4. Choose **Entire book**, or **Choose chapters or pages**:
   - tick one or more chapters (ticking a part ticks all of its chapters), and/or
   - type pages in the *Pages* box, e.g. `1-3, 10, 25-`.
   Every chapter shows the pages it occupies, so you can see exactly what will print.
5. Pick paper size and printer, then **Print** — or **Save as PDF…**.

Page numbers are printed at the bottom of every page and always match the numbers shown in
the print window, so a selection like “pages 12–20” prints the pages labelled 12–20.

Only DRM-free EPUB 2 / EPUB 3 books can be opened. Books bought with DRM (Adobe, Apple,
Readium LCP, …) are detected and Wolfreader says so instead of failing silently.

## Development

Requirements: Node.js 21+ (the `npm test` glob needs it) and npm. Building the Windows installer on Linux/macOS also needs
Wine (electron-builder uses it to stamp the icon and version info into `Wolfreader.exe`).

```bash
npm install
npm run build      # copies epub.js into src/renderer/vendor
npm start          # build + run the app in development mode
npm test           # unit tests (page ranges, chapter spans, selection)
```

### Building the Windows installer

```bash
npm run dist       # -> release/Wolfreader-Setup-1.0.1.exe (NSIS, win32 x64)
npm run dist:dir   # unpacked app only, in release/win-unpacked/
```

Two checks work without a Windows machine: `npm run verify:package` inspects the built
installer and `Wolfreader.exe` (NSIS package, icon, version info, asar contents), and
`npm run verify:wine-install` runs the installer silently under Wine and checks what it
installed (program files, uninstaller, shortcuts, `.epub` registration).

The installer is not code-signed, so Windows SmartScreen will show an “unknown publisher”
warning until a signing certificate is added to the electron-builder config.

### End-to-end tests

```bash
npm run samples    # downloads public-domain Project Gutenberg EPUBs into test/samples/
npm run test:e2e   # generates edge-case fixtures, drives the real app under Xvfb
```

See [TESTING.md](TESTING.md) for how the app was verified — unit tests, e2e runs, PDF
inspection, installer build — and what could not be checked because no real Windows
machine or physical printer was available.

### Branding assets

`assets/branding/wolfreader-logo-source.jpg` is the single source of truth. `npm run icons`
(ImageMagick 6) regenerates `build/icon.ico` (16–256 px), the installer sidebar bitmap and the
in-app logo, badge and wordmark images in `src/renderer/img/`.

## How it works

| Part | Where |
| --- | --- |
| Main process: window, menu, IPC, single-instance / file association | `src/main/main.js` |
| EPUB container access, validation, DRM detection, font de-obfuscation | `src/main/epub-archive.js` |
| `wolfreader://` protocol serving app files and book contents | `src/main/protocol.js` |
| Print layout, pagination and printing | `src/main/print-engine.js`, `src/renderer/print-layout.js` |
| PDF page markers, selection PDFs | `src/main/pdf-tools.js` |
| UI (reader, print dialog) | `src/renderer/` |
| Page-range parsing and chapter ↔ page logic (shared, unit-tested) | `src/shared/selection.js` |

**Reading** uses [epub.js](https://github.com/futurepress/epub.js) in a sandboxed iframe (book
scripts never run).

**Printing.** EPUB has no pages, so Wolfreader makes its own: when a book is opened, a hidden
window lays out the whole book as one document at the chosen paper size, every spine file
starting on a new page, with each file's CSS scoped to its own section. Invisible marker links
are placed at the start of every file and at every table-of-contents anchor. Chromium's print
engine paginates the document once (`printToPDF`), and the markers come back as link
annotations on the exact pages where each chapter starts. That gives every chapter a precise
page span, which the print dialog shows and combines with typed page ranges.

- **Save as PDF** copies the selected pages out of that PDF (pdf-lib), so the file is
  page-for-page what was selected.
- **Print** sends the same laid-out document to the printer with `webContents.print()` and the
  selected `pageRanges`, so printed pages are the same pages, with the same page numbers.

## License

MIT — see [LICENSE](LICENSE). Sample books used in tests are public-domain Project Gutenberg
texts and are downloaded on demand, not distributed with the app.
