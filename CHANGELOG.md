# Changelog

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
