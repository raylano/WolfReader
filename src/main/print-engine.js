'use strict';
/*
 * Owns the hidden "print layout" window for one open book.
 *
 *  prepare()  builds the whole book as one paginated document (print-layout.js),
 *             runs printToPDF once and reads the chapter markers back out of the
 *             PDF -> exact page numbers for every chapter.
 *  savePdf()  copies the selected pages out of that same PDF (pdf-lib), so the
 *             saved file is page-for-page what the user picked.
 *  print()    sends the same laid-out document to a printer with Chromium's
 *             pageRanges, so printed pages match the numbers shown in the UI.
 */
const path = require('path');
const { BrowserWindow } = require('electron');
const { readMarkers, buildSelectionPdf } = require('./pdf-tools');
const { computeChapterSpans, toRanges } = require('../shared/selection');
const { ORIGIN } = require('./protocol');

const PAPERS = { A4: 'A4', Letter: 'Letter' };
const LAYOUT_TIMEOUT_MS = 10 * 60 * 1000;
const FRONT_MATTER_ID = '__front';

class CancelledError extends Error {
  constructor() {
    super('Cancelled');
    this.cancelled = true;
  }
}

class PrintEngine {
  /**
   * @param {{title?:string, author?:string, onProgress?:(p:object)=>void}} options
   */
  constructor({ title, author, onProgress } = {}) {
    this.title = title || 'Untitled';
    this.author = author || '';
    this.onProgress = onProgress || (() => {});
    this.win = null;
    this.job = null;
    this.paper = null;
    this.pdfBytes = null;
    this.pagination = null;
    this.pending = null; // {resolve, reject} of the in-flight layout step
    this.busy = null; // promise of the in-flight prepare/setPaper
  }

  _createWindow() {
    const win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload', 'print-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: false,
      },
    });
    const { ipc } = win.webContents;
    ipc.on('layout:progress', (_e, p) => this.onProgress(p));
    ipc.on('layout:ready', (_e, info) => this._settle(null, info));
    ipc.on('layout:error', (_e, message) => this._settle(new Error(message)));
    win.webContents.on('render-process-gone', (_e, details) => {
      this._settle(new Error(`The print layout stopped unexpectedly (${details.reason}). The book may be too large.`));
    });
    win.on('closed', () => {
      if (this.win === win) this.win = null;
      this._settle(new CancelledError());
    });
    return win;
  }

  _settle(err, value) {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    clearTimeout(pending.timer);
    if (err) pending.reject(err);
    else pending.resolve(value);
  }

  _waitForLayout(send) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this._settle(new Error('Laying out the book took too long.')),
        LAYOUT_TIMEOUT_MS,
      );
      this.pending = { resolve, reject, timer };
      send();
    });
  }

  /**
   * @param {{sections:{index:number,href:string,url:string}[],
   *          chapters:{id:string,depth:number,sectionIndex:number,fragment:string|null}[],
   *          paper:string, language?:string}} job
   */
  async prepare(job) {
    this.cancel();
    this.job = { ...job, title: this.title, author: this.author };
    this.paper = PAPERS[job.paper] || 'A4';
    this.job.paper = this.paper;
    const win = (this.win = this._createWindow());
    const run = (async () => {
      try {
        await win.loadURL(`${ORIGIN}/print.html`);
        const info = await this._waitForLayout(() => this._liveWin(win).webContents.send('layout:build', this.job));
        const pagination = await this._paginate(win);
        pagination.warnings = {
          failedSections: info.failedSections || [],
          missingAnchors: info.missingAnchors || 0,
        };
        this.pagination = pagination;
        return pagination;
      } catch (err) {
        if (win.isDestroyed() || win !== this.win) throw new CancelledError();
        throw err;
      }
    })();
    this.busy = run;
    return run;
  }

  /** Re-paginates the already-built layout for another paper size. */
  async setPaper(paper) {
    if (!this.win || !this.job) throw new Error('No print layout for this book yet.');
    if (this.busy) await this.busy.catch(() => {});
    const win = this._liveWin(this.win);
    const run = (async () => {
      this.paper = PAPERS[paper] || 'A4';
      this.job.paper = this.paper;
      await this._waitForLayout(() => this._liveWin(win).webContents.send('layout:paper', this.paper));
      const pagination = await this._paginate(win);
      pagination.warnings = this.pagination ? this.pagination.warnings : { failedSections: [], missingAnchors: 0 };
      this.pagination = pagination;
      return pagination;
    })();
    this.busy = run;
    return run;
  }

  /** Throws CancelledError if `win` has been replaced or destroyed meanwhile. */
  _liveWin(win) {
    if (!win || win.isDestroyed() || win !== this.win) throw new CancelledError();
    return win;
  }

  async _paginate(win) {
    this.onProgress({ phase: 'paginating' });
    const pdf = await this._liveWin(win).webContents.printToPDF({
      pageSize: this.paper,
      preferCSSPageSize: true,
      printBackground: false,
    });
    const { pageCount, markers } = await readMarkers(pdf);
    this._liveWin(win);
    this.pdfBytes = pdf;

    const sectionStarts = {};
    for (const s of this.job.sections) {
      const page = markers.get('s' + s.index);
      if (page) sectionStarts[s.index] = page;
    }

    const entries = this.job.chapters.map((c) => ({
      id: c.id,
      depth: c.depth,
      startPage: markers.get('c' + c.id) || sectionStarts[c.sectionIndex] || null,
    }));
    const firstStart = Math.min(...entries.map((e) => e.startPage || Infinity));
    if (entries.length && Number.isFinite(firstStart) && firstStart > 1) {
      entries.unshift({ id: FRONT_MATTER_ID, depth: 0, startPage: 1 });
    }
    return {
      paper: this.paper,
      totalPages: pageCount,
      sectionStarts,
      spans: computeChapterSpans(entries, pageCount),
      frontMatterId: entries.length && entries[0].id === FRONT_MATTER_ID ? FRONT_MATTER_ID : null,
    };
  }

  _checkPages(pages) {
    if (!this.pdfBytes || !this.pagination) throw new Error('The book hasn’t been laid out for printing yet.');
    const total = this.pagination.totalPages;
    const clean = [...new Set(pages)].filter((p) => Number.isInteger(p) && p >= 1 && p <= total).sort((a, b) => a - b);
    if (clean.length === 0) throw new Error('No pages selected.');
    return clean;
  }

  /** @returns {Promise<Uint8Array>} */
  async buildPdf(pages) {
    const clean = this._checkPages(pages);
    return buildSelectionPdf(this.pdfBytes, clean, { title: this.title, author: this.author });
  }

  /**
   * @returns {Promise<{success:boolean, reason?:string}>}
   */
  print({ pages, deviceName, copies = 1, duplex = 'simplex', color = true }) {
    const clean = this._checkPages(pages);
    if (!this.win) throw new Error('The print layout is not available. Reopen the book and try again.');
    const options = {
      silent: true,
      deviceName: deviceName || '',
      copies: Math.max(1, Math.min(99, Number(copies) || 1)),
      collate: true,
      color: Boolean(color),
      duplexMode: ['simplex', 'longEdge', 'shortEdge'].includes(duplex) ? duplex : 'simplex',
      printBackground: false,
      pageSize: this.paper,
      landscape: false,
      margins: { marginType: 'default' },
    };
    if (clean.length !== this.pagination.totalPages) {
      // Electron wants 0-based inclusive ranges.
      options.pageRanges = toRanges(clean).map((r) => ({ from: r.from - 1, to: r.to - 1 }));
    }
    return new Promise((resolve) => {
      this.win.webContents.print(options, (success, reason) => resolve({ success, reason }));
    });
  }

  cancel() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this._settle(new CancelledError());
    this.pdfBytes = null;
    this.pagination = null;
    this.busy = null;
  }

  destroy() {
    this.cancel();
  }
}

module.exports = { PrintEngine, CancelledError, FRONT_MATTER_ID };
