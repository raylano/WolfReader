# Changelog

## 1.3.1

- Closing Wolfreader no longer flashes a console window with “Pinging 127.0.0.1…”. The safety
  net that makes sure the app really exits now runs invisibly and stops as soon as the app is gone.

## 1.3.0

- **Automatic updates.** Wolfreader checks GitHub for a newer release shortly after starting
  (and every few hours). A bar at the top offers **Download and install**; once downloaded,
  **Restart now** installs it — or it installs when you close Wolfreader. You can also check
  yourself via *Help → Check for Updates…* or the About window.

## 1.2.0

- **Tabs.** Every book you open gets its own tab; switch between books without losing your
  place or their page layout. Opening a book that is already open switches to its tab.
- **Opening from Explorer while Wolfreader runs** now opens the book as a new tab and brings
  the window to the front (Windows used to keep it in the background).
- **Closing really ends Wolfreader.** The app no longer relies on a graceful shutdown: it exits
  directly, and a small watchdog ends the process if Windows' shutdown hangs, so Wolfreader can
  always be started again and uninstalled. Start/stop events are logged to
  `%APPDATA%\Wolfreader\app.log`.
- Opening, switching or closing while a book is still loading is no longer ignored.

## 1.1.2

- **Wolfreader now really exits when you close it** (and starts again afterwards). A hidden
  page-layout window or an unfinished print job could keep a background process alive that
  blocked starting the app again and the uninstaller. The process is now ended explicitly, and
  starting Wolfreader recovers if an old process is still around.
- **Printing:** if a printer driver (e.g. Epson) aborts the job, the pages are printed as images
  through plain Windows (GDI) printing instead.

## 1.1.1

- **Closing the app now really quits it.** A hidden page-layout window kept Wolfreader running
  in the background after the window was closed, so it wouldn't start again and the
  uninstaller said the app must be closed. Starting Wolfreader again also recovers if an old
  process is still around.
- **Printing:** when the printer or Windows cancels a job after it was sent, Wolfreader now says
  so instead of the misleading “Printing was cancelled”, and the reason is logged.
- **Printer compatibility (e.g. Epson):** if a driver still aborts the job, the pages are printed
  as images through plain Windows (GDI) printing instead, bypassing Chromium's print pipeline.
  Before that, a job that the driver aborts is retried automatically
  with fewer settings (no paper size, margins or collate — the printer's own defaults). Every
  attempt is logged to `%APPDATA%\Wolfreader\print.log`.
- **New “Print via PDF viewer” button:** opens your selection in your PDF viewer so you can
  print with its own print window — a reliable way around printers that refuse silent jobs.

## 1.1.0 — 2026-10-27

- **Pick single pages.** In the print dialog every chapter can be opened to show its pages;
  tick or untick pages one by one. A chapter shows a half-ticked box when only some of its
  pages are selected.
- **Page preview.** Click a page number to see a small preview of exactly how that page will
  print, step through neighbouring pages with the arrows, and include/exclude the page from
  the preview.
- Packaging: the installer is now published on GitHub Releases, built by GitHub Actions.

## 1.0.1

- Rebuilt installer.

## 1.0.0

- First release: open EPUBs, read them, print the whole book or selected chapters and pages,
  save selections as PDF.
