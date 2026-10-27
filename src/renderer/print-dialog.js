/* global WolfSelection */
/*
 * Print options dialog: "entire book" vs "choose chapters or pages", with
 * chapter checkboxes and a page-range field that combine (union), a live
 * page/chapter count, paper size, printer settings, Print and Save as PDF.
 */
window.PrintDialog = (function () {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const wolf = window.wolf;
  const FRONT_LABEL = 'Cover & front matter';

  let ui = null; // per-book dialog state, kept between openings
  let printers = [];
  let busy = false;
  let renderedFor = null; // pagination object the chapter list was built for
  let previewDoc = null; // {pag, promise} pdf.js document of the laid-out book
  let previewToken = 0;

  const app = () => window.WolfApp;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /* ---------------- model helpers ---------------- */

  /** TOC entries plus the synthetic front-matter entry, with child links. */
  function entries() {
    const { state } = app();
    const pag = state.layout.pagination;
    const list = state.chapters.map((c) => ({ ...c }));
    if (pag && pag.frontMatterId) {
      list.unshift({ id: pag.frontMatterId, label: FRONT_LABEL, depth: 0, front: true });
    }
    list.forEach((e, i) => {
      e.descendants = [];
      for (let j = i + 1; j < list.length && list[j].depth > e.depth; j++) e.descendants.push(list[j].id);
      e.ancestors = [];
      let depth = e.depth;
      for (let j = i - 1; j >= 0 && depth > 0; j--) {
        if (list[j].depth < depth) {
          e.ancestors.push(list[j].id);
          depth = list[j].depth;
        }
      }
    });
    return list;
  }

  function selection(withOverrides = true, mode = ui.mode) {
    const { state } = app();
    const pag = state.layout.pagination;
    if (!pag) return null;
    const list = entries();
    const sel = WolfSelection.resolveSelection(
      {
        mode,
        checkedChapterIds: [...ui.checked],
        rangeText: ui.rangeText,
        includePages: withOverrides ? [...ui.include] : [],
        excludePages: withOverrides ? [...ui.exclude] : [],
      },
      { totalPages: pag.totalPages, spans: pag.spans },
    );
    // "chapters" = chapters (entries without sub-entries) that have at least one selected page
    const chosen = new Set(sel.pages);
    const leaves = list.filter((e) => e.descendants.length === 0 && pag.spans[e.id]);
    sel.chapterCount =
      mode === 'all'
        ? leaves.length
        : leaves.filter((e) => {
            const sp = pag.spans[e.id];
            for (let p = sp.startPage; p <= sp.endPage; p++) if (chosen.has(p)) return true;
            return false;
          }).length;
    return sel;
  }

  /** Makes `pages` (un)selected, on top of what chapters and typed ranges already give. */
  function setPages(pages, on) {
    const base = new Set(selection(false, 'custom').pages);
    const next = WolfSelection.togglePages(pages, on, base, ui.include, ui.exclude);
    ui.include = next.includePages;
    ui.exclude = next.excludePages;
  }

  const spanPages = (span) => {
    const out = [];
    for (let p = span.startPage; p <= span.endPage; p++) out.push(p);
    return out;
  };

  /* ---------------- rendering ---------------- */

  function renderChapters() {
    const { state } = app();
    const pag = state.layout.pagination;
    const listEl = $('chapter-list');
    listEl.innerHTML = '';
    const note = $('chapters-note');
    if (!state.hasToc) {
      note.hidden = false;
      note.textContent =
        'This book has no usable table of contents, so chapters can’t be picked by name. ' +
        'Print the entire book, or type the pages you want on the right.';
      $('chapters-all').hidden = $('chapters-none').hidden = true;
      return;
    }
    $('chapters-all').hidden = $('chapters-none').hidden = false;
    const missing = state.chapters.filter((c) => !pag.spans[c.id]).length;
    note.hidden = missing === 0;
    if (missing) {
      note.textContent = `${missing} contents ${missing === 1 ? 'entry' : 'entries'} couldn’t be located in the book and can’t be selected.`;
    }

    for (const e of entries()) {
      const span = pag.spans[e.id];
      const li = document.createElement('li');
      if (!span) li.classList.add('disabled');
      if (e.front) li.classList.add('front');
      const row = document.createElement('div');
      row.className = 'ch-row';
      row.style.paddingLeft = e.depth * 18 + 'px';
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'ch-toggle';
      toggle.dataset.toggle = e.id;
      toggle.textContent = '▸';
      toggle.disabled = !span;
      toggle.setAttribute('aria-label', `Show the pages of ${e.label}`);
      toggle.setAttribute('aria-expanded', 'false');
      const label = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.dataset.id = e.id;
      cb.disabled = !span;
      const text = document.createElement('span');
      text.className = 'ch-label';
      text.textContent = e.label;
      const pages = document.createElement('span');
      pages.className = 'ch-pages';
      pages.textContent = span
        ? span.startPage === span.endPage
          ? `p. ${span.startPage}`
          : `pp. ${span.startPage}–${span.endPage}`
        : 'not found';
      label.append(cb, text, pages);
      row.append(toggle, label);
      li.dataset.id = e.id;
      li.appendChild(row);
      listEl.appendChild(li);
      if (span && ui.expanded.has(e.id)) setExpanded(li, e, true);
    }
    syncCheckboxes();
  }

  function syncCheckboxes() {
    const pag = app().state.layout.pagination;
    if (!pag) return;
    const chosen = new Set(selection(true, 'custom').pages);
    // A chapter is ticked when all of its pages are selected, half-ticked when only some are.
    for (const cb of $('chapter-list').querySelectorAll('input[data-id]')) {
      const span = pag.spans[cb.dataset.id];
      if (!span) {
        cb.checked = cb.indeterminate = false;
        continue;
      }
      let n = 0;
      for (let p = span.startPage; p <= span.endPage; p++) if (chosen.has(p)) n++;
      const total = span.endPage - span.startPage + 1;
      cb.checked = n === total;
      cb.indeterminate = n > 0 && n < total;
    }
    for (const chip of $('chapter-list').querySelectorAll('.page-chip')) {
      const on = chosen.has(Number(chip.dataset.page));
      chip.classList.toggle('on', on);
      chip.querySelector('input').checked = on;
      chip.classList.toggle('current', ui.previewPage === Number(chip.dataset.page));
    }
    if (ui.previewPage) $('preview-include').checked = chosen.has(ui.previewPage);
  }

  /* ---------------- expandable page lists ---------------- */

  function setExpanded(li, entry, open) {
    const pag = app().state.layout.pagination;
    const span = pag.spans[entry.id];
    const toggle = li.querySelector('.ch-toggle');
    li.classList.toggle('open', open);
    toggle.setAttribute('aria-expanded', String(open));
    let grid = li.querySelector('.page-grid');
    if (!open) {
      ui.expanded.delete(entry.id);
      if (grid) grid.hidden = true;
      return;
    }
    ui.expanded.add(entry.id);
    if (!grid) {
      grid = document.createElement('div');
      grid.className = 'page-grid';
      for (const p of spanPages(span)) {
        const chip = document.createElement('span');
        chip.className = 'page-chip';
        chip.dataset.page = p;
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.setAttribute('aria-label', `Print page ${p}`);
        const num = document.createElement('button');
        num.type = 'button';
        num.className = 'pg-num';
        num.textContent = `p. ${p}`;
        num.title = `Preview page ${p}`;
        chip.append(cb, num);
        grid.appendChild(chip);
      }
      li.appendChild(grid);
    }
    grid.hidden = false;
    syncCheckboxes();
  }

  /* ---------------- page preview ---------------- */

  function loadPreviewDoc() {
    const pag = app().state.layout.pagination;
    if (previewDoc && previewDoc.pag === pag) return previewDoc.promise;
    const promise = (async () => {
      const pdfjs = await import('./vendor/pdf.min.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', location.href).href;
      const bytes = await wolf.getLayoutPdf(app().state.bookId);
      if (!bytes) throw new Error('The page layout isn’t available.');
      return pdfjs.getDocument({ data: bytes, isEvalSupported: false }).promise;
    })();
    previewDoc = { pag, promise };
    promise.catch(() => {
      if (previewDoc && previewDoc.promise === promise) previewDoc = null;
    });
    return promise;
  }

  async function showPreview(page) {
    const pag = app().state.layout.pagination;
    if (!pag || page < 1 || page > pag.totalPages) return;
    ui.previewPage = page;
    const token = ++previewToken;
    $('page-preview').hidden = false;
    $('preview-label').textContent = `Print page ${page} of ${pag.totalPages}`;
    $('preview-prev').disabled = page <= 1;
    $('preview-next').disabled = page >= pag.totalPages;
    const msg = $('preview-msg');
    const canvas = $('preview-canvas');
    syncCheckboxes();
    const chip = $('chapter-list').querySelector(`.page-chip[data-page="${page}"]`);
    if (chip) chip.scrollIntoView({ block: 'nearest' });
    msg.hidden = false;
    msg.textContent = 'Loading preview…';
    canvas.hidden = true;
    try {
      const doc = await loadPreviewDoc();
      const pdfPage = await doc.getPage(page);
      if (token !== previewToken) return;
      const base = pdfPage.getViewport({ scale: 1 });
      const cssWidth = 220;
      const ratio = window.devicePixelRatio || 1;
      const viewport = pdfPage.getViewport({ scale: (cssWidth / base.width) * ratio });
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = cssWidth + 'px';
      await pdfPage.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
      if (token !== previewToken) return;
      canvas.hidden = false;
      msg.hidden = true;
    } catch (err) {
      if (token !== previewToken) return;
      canvas.hidden = true;
      msg.hidden = false;
      msg.textContent = 'This page can’t be previewed.';
    }
  }

  function renderSummary() {
    const el = $('selection-summary');
    const { state } = app();
    const pag = state.layout.pagination;
    const printBtn = $('btn-do-print');
    const pdfBtn = $('btn-save-pdf');
    const errorsEl = $('range-errors');
    errorsEl.innerHTML = '';
    $('page-range').classList.remove('invalid');

    if (!pag) {
      el.className = 'summary empty';
      el.innerHTML = '<span class="count">Counting pages…</span>';
      printBtn.disabled = pdfBtn.disabled = $('btn-open-pdf').disabled = true;
      return;
    }
    const sel = selection();
    syncCheckboxes();
    for (const msg of sel.errors) {
      const li = document.createElement('li');
      li.textContent = msg;
      errorsEl.appendChild(li);
    }
    if (sel.errors.length) $('page-range').classList.add('invalid');

    el.innerHTML = '';
    const count = document.createElement('span');
    count.className = 'count';
    const detail = document.createElement('span');
    detail.className = 'ranges';
    if (ui.mode === 'all') {
      el.className = 'summary';
      count.textContent = `${plural(pag.totalPages, 'page')} / ${plural(sel.chapterCount, 'chapter')} selected`;
      detail.textContent = `The entire book on ${pag.paper} paper`;
    } else if (sel.pages.length === 0) {
      el.className = 'summary empty';
      count.textContent = '0 pages / 0 chapters selected';
      detail.textContent = state.hasToc
        ? 'Tick one or more chapters, or type page numbers.'
        : 'Type the page numbers you want to print.';
    } else {
      el.className = 'summary';
      count.textContent = `${plural(sel.pages.length, 'page')} / ${plural(sel.chapterCount, 'chapter')} selected`;
      detail.textContent = `Pages ${WolfSelection.formatRanges(sel.pages)} of ${pag.totalPages} (${pag.paper})`;
    }
    el.append(count, detail);

    const blocked = busy || sel.pages.length === 0 || sel.errors.length > 0;
    pdfBtn.disabled = blocked;
    $('btn-open-pdf').disabled = blocked;
    printBtn.disabled = blocked || printers === null || (Array.isArray(printers) && printers.length === 0);
    printBtn.textContent = sel.pages.length ? `Print ${plural(sel.pages.length, 'page')}` : 'Print';
  }

  function renderPreparing() {
    const { state } = app();
    const L = state.layout;
    const overlay = $('preparing');
    const bar = $('preparing-bar');
    if (L.status === 'running') {
      overlay.hidden = false;
      const p = L.progress || {};
      let title = 'Laying out pages…';
      let detail = 'Wolfreader is arranging the book onto printable pages so every chapter gets exact page numbers.';
      let pct = null;
      if (p.phase === 'reading') {
        title = 'Reading chapters…';
        detail = `${p.done} of ${p.total} parts read`;
        pct = (p.done / p.total) * 40;
      } else if (p.phase === 'layout') {
        title = 'Arranging chapters…';
        detail = `${p.done} of ${p.total} parts arranged`;
        pct = 40 + (p.done / p.total) * 40;
      } else if (p.phase === 'images') {
        title = 'Loading pictures and fonts…';
        pct = 85;
      } else if (p.phase === 'paginating') {
        title = 'Counting pages…';
        detail = `Splitting the book into ${L.paper} pages.`;
        pct = null;
      }
      $('preparing-title').textContent = title;
      $('preparing-detail').textContent = detail;
      bar.parentElement.classList.toggle('indeterminate', pct === null);
      bar.style.width = pct === null ? '' : Math.round(pct) + '%';
    } else {
      overlay.hidden = true;
    }
  }

  function setStatus(kind, title, message) {
    const el = $('print-status');
    if (!kind) {
      el.hidden = true;
      return;
    }
    el.className = 'notice ' + (kind === 'error' ? 'notice-error' : kind === 'ok' ? 'notice-ok' : 'notice-warn');
    el.innerHTML = '';
    if (title) {
      const s = document.createElement('strong');
      s.textContent = title;
      el.appendChild(s);
    }
    el.appendChild(document.createTextNode(message || ''));
    el.hidden = false;
  }

  function renderLayoutState() {
    const { state } = app();
    const L = state.layout;
    renderPreparing();
    if (L.status === 'error') {
      setStatus('error', 'The book couldn’t be laid out for printing.', ` ${L.error || ''} Close this window and try again.`);
    } else if (L.status === 'cancelled') {
      setStatus('warn', 'Page layout was cancelled.', ' Reopen the print window to try again.');
    } else if (L.status === 'ready' && L.pagination) {
      const w = L.pagination.warnings || {};
      if (w.failedSections && w.failedSections.length) {
        setStatus(
          'warn',
          'Some parts of this book couldn’t be read.',
          ` ${plural(w.failedSections.length, 'part')} will be missing from the printout.`,
        );
      } else if (!busy) showPrinterNotice();
    }
    if (L.pagination && renderedFor !== L.pagination) {
      renderedFor = L.pagination;
      ui.previewPage = null;
      $('page-preview').hidden = true;
      $('mode-all-detail').textContent = `All ${plural(L.pagination.totalPages, 'page')}`;
      renderChapters();
    }
    for (const r of document.querySelectorAll('input[name=paper]')) r.checked = r.value === L.paper;
    renderSummary();
  }

  /* ---------------- printers ---------------- */

  /** Default status line: warn when there's nothing to print to, otherwise clear. */
  function showPrinterNotice() {
    if (Array.isArray(printers) && printers.length === 0) {
      setStatus('warn', 'No printer is installed on this computer.', ' You can still save your selection as a PDF.');
    } else {
      setStatus(null);
    }
  }

  async function loadPrinters() {
    const select = $('printer');
    select.innerHTML = '<option>Looking for printers…</option>';
    select.disabled = true;
    printers = null;
    let list = [];
    try {
      list = await wolf.listPrinters();
    } catch {
      list = [];
    }
    printers = list;
    select.innerHTML = '';
    if (!list.length) {
      const opt = document.createElement('option');
      opt.textContent = 'No printers found';
      select.appendChild(opt);
      select.disabled = true;
      if (!busy && app().state.layout.status === 'ready') showPrinterNotice();
    } else {
      const def = document.createElement('option');
      def.value = '';
      def.textContent = 'System default printer';
      select.appendChild(def);
      for (const p of list) {
        const opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.displayName;
        select.appendChild(opt);
      }
      const saved = app().state.settings.printer;
      select.value = list.some((p) => p.name === saved) ? saved : '';
      select.disabled = false;
    }
    renderSummary();
  }

  /* ---------------- actions ---------------- */

  function suggestedName(sel) {
    const { state } = app();
    const base = state.info ? state.info.title : 'book';
    if (ui.mode === 'all' || !sel) return base;
    const ranges = WolfSelection.formatRanges(sel.pages).replace(/–/g, '-');
    return `${base} (pages ${ranges.length > 60 ? ranges.slice(0, 57) + '…' : ranges})`;
  }

  function setBusy(on) {
    busy = on;
    for (const id of ['btn-do-print', 'btn-save-pdf', 'btn-open-pdf']) $(id).disabled = on;
    if (!on) renderSummary();
  }

  async function doSavePdf() {
    const sel = selection();
    if (!sel || !sel.pages.length || sel.errors.length) return;
    setBusy(true);
    setStatus('info', 'Preparing PDF…', '');
    try {
      const res = await wolf.savePdf({ bookId: app().state.bookId, pages: sel.pages, fileName: suggestedName(sel) });
      if (res.ok) {
        showPrinterNotice();
        close(true);
        app().toast(`Saved ${plural(sel.pages.length, 'page')} as PDF: ${res.path}`, { timeout: 7000 });
      } else if (res.cancelled) {
        showPrinterNotice();
      } else {
        setStatus('error', 'The PDF couldn’t be saved.', ' ' + (res.message || ''));
      }
    } finally {
      setBusy(false);
    }
  }

  async function doOpenPdf() {
    const sel = selection();
    if (!sel || !sel.pages.length || sel.errors.length) return;
    setBusy(true);
    setStatus('info', 'Preparing PDF…', '');
    try {
      const res = await wolf.openPdf({ bookId: app().state.bookId, pages: sel.pages, fileName: suggestedName(sel) });
      if (res.ok) {
        setStatus(null);
        close(true);
        app().toast(`Opened ${plural(sel.pages.length, 'page')} in your PDF viewer — print from there.`, { timeout: 7000 });
      } else {
        setStatus('error', 'The PDF couldn’t be opened.', ' ' + (res.message || ''));
      }
    } finally {
      setBusy(false);
    }
  }

  /** Renders the pages with pdf.js and hands the PNGs to the main process for GDI printing. */
  async function printAsImages(pages, { deviceName, copies, duplex, color }) {
    let jobId = null;
    try {
      const doc = await loadPreviewDoc();
      jobId = await wolf.gdiBegin();
      const canvas = document.createElement('canvas');
      for (let i = 0; i < pages.length; i++) {
        setStatus('info', `Preparing page ${i + 1} of ${pages.length}…`, '');
        const page = await doc.getPage(pages[i]);
        const viewport = page.getViewport({ scale: 200 / 72 }); // 200 dpi
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
        await wolf.gdiPage({ jobId, index: i + 1, bytes: new Uint8Array(await blob.arrayBuffer()) });
        page.cleanup();
      }
      setStatus('info', `Sending ${plural(pages.length, 'page')} to the printer…`, '');
      return await wolf.gdiRun({ jobId, deviceName, copies, duplex, color, paper: app().state.layout.paper });
    } catch (err) {
      return { ok: false, message: 'The pages couldn’t be prepared for printing. Use “Print via PDF viewer” instead.' };
    } finally {
      if (jobId) wolf.gdiEnd(jobId);
    }
  }

  async function doPrint() {
    const sel = selection();
    if (!sel || !sel.pages.length || sel.errors.length) return;
    const select = $('printer');
    const deviceName = select.value;
    const printerLabel = deviceName ? select.options[select.selectedIndex].textContent : 'the default printer';
    const copies = Math.max(1, Math.min(99, parseInt($('copies').value, 10) || 1));
    const duplex = $('duplex').value;
    const color = $('color').checked;
    wolf.setSettings({ printer: deviceName, duplex, color });
    Object.assign(app().state.settings, { printer: deviceName, duplex, color });

    setBusy(true);
    setStatus('info', `Sending ${plural(sel.pages.length, 'page')} to ${printerLabel}…`, '');
    try {
      let res = await wolf.print({ bookId: app().state.bookId, pages: sel.pages, deviceName, copies, duplex, color });
      if (!res.ok && res.fallback) {
        // The driver aborted Chromium's job: print the pages as images through plain Windows printing.
        setStatus('info', 'The first way of printing didn’t work — trying another way…', '');
        res = await printAsImages(sel.pages, { deviceName, copies, duplex, color });
      }
      if (res.ok) {
        setStatus(null);
        close(true);
        app().toast(`Sent ${plural(sel.pages.length, 'page')}${copies > 1 ? ` × ${copies}` : ''} to ${printerLabel}.`);
      } else if (res.cancelled) {
        setStatus('warn', 'Printing was cancelled.', '');
      } else {
        setStatus('error', 'Printing didn’t work.', ' ' + (res.message || ''));
      }
    } finally {
      setBusy(false);
    }
  }

  /* ---------------- events ---------------- */

  function onModeChange() {
    ui.mode = document.querySelector('input[name=print-mode]:checked').value;
    $('custom-select').hidden = ui.mode !== 'custom';
    if (ui.mode === 'custom' && !app().state.hasToc) setTimeout(() => $('page-range').focus(), 0);
    renderSummary();
  }

  function onChapterToggle(e) {
    const cb = e.target;
    if (!cb.matches('input[type=checkbox]')) return;
    const pag = app().state.layout.pagination;
    const chip = cb.closest('.page-chip');
    if (chip) {
      setPages([Number(chip.dataset.page)], cb.checked);
      syncCheckboxes();
      renderSummary();
      return;
    }
    const entry = entries().find((x) => x.id === cb.dataset.id);
    if (!entry) return;
    const ids = [entry.id, ...entry.descendants].filter((id) => pag.spans[id]);
    if (cb.checked) ids.forEach((id) => ui.checked.add(id));
    else {
      ids.forEach((id) => ui.checked.delete(id));
      entry.ancestors.forEach((id) => ui.checked.delete(id)); // a part is only "whole" if all of it is ticked
    }
    setPages(spanPages(pag.spans[entry.id]), cb.checked);
    syncCheckboxes();
    renderSummary();
  }

  function onListClick(e) {
    const pag = app().state.layout.pagination;
    const toggle = e.target.closest('.ch-toggle');
    if (toggle) {
      const li = toggle.closest('li');
      const entry = entries().find((x) => x.id === li.dataset.id);
      if (entry && pag.spans[entry.id]) setExpanded(li, entry, !li.classList.contains('open'));
      return;
    }
    const num = e.target.closest('.pg-num');
    if (num) showPreview(Number(num.closest('.page-chip').dataset.page));
  }

  function selectAll(on) {
    const pag = app().state.layout.pagination;
    ui.checked = new Set(on ? entries().filter((e) => pag.spans[e.id]).map((e) => e.id) : []);
    ui.include = new Set();
    ui.exclude = new Set();
    syncCheckboxes();
    renderSummary();
  }

  document.querySelectorAll('input[name=print-mode]').forEach((r) => r.addEventListener('change', onModeChange));
  $('chapter-list').addEventListener('change', onChapterToggle);
  $('chapter-list').addEventListener('click', onListClick);
  $('preview-prev').addEventListener('click', () => showPreview(ui.previewPage - 1));
  $('preview-next').addEventListener('click', () => showPreview(ui.previewPage + 1));
  $('preview-include').addEventListener('change', (e) => {
    setPages([ui.previewPage], e.target.checked);
    syncCheckboxes();
    renderSummary();
  });
  $('chapters-all').addEventListener('click', () => selectAll(true));
  $('chapters-none').addEventListener('click', () => selectAll(false));
  $('page-range').addEventListener('input', (e) => {
    ui.rangeText = e.target.value;
    renderSummary();
  });
  document.querySelectorAll('input[name=paper]').forEach((r) =>
    r.addEventListener('change', (e) => app().changePaper(e.target.value)),
  );
  $('preparing-cancel').addEventListener('click', () => app().cancelLayout());
  $('btn-do-print').addEventListener('click', doPrint);
  $('btn-save-pdf').addEventListener('click', doSavePdf);
  $('btn-open-pdf').addEventListener('click', doOpenPdf);
  $('copies').addEventListener('change', (e) => {
    e.target.value = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1));
  });

  /* ---------------- public API ---------------- */

  function open() {
    const { state } = app();
    if (!state.bookId) return;
    if (!ui || ui.bookId !== state.bookId) {
      ui = {
        bookId: state.bookId,
        mode: 'all',
        checked: new Set(),
        include: new Set(),
        exclude: new Set(),
        expanded: new Set(),
        previewPage: null,
        rangeText: '',
      };
      renderedFor = null;
    }
    $('print-heading').textContent = `Print “${state.info.title}”`;
    document.querySelector(`input[name=print-mode][value=${ui.mode}]`).checked = true;
    $('custom-select').hidden = ui.mode !== 'custom';
    $('page-range').value = ui.rangeText;
    $('duplex').value = state.settings.duplex || 'simplex';
    $('color').checked = state.settings.color !== false;
    setStatus(null);
    app().ensureLayout();
    renderLayoutState();
    app().openModal('print-modal');
    loadPrinters();
  }

  function close(force) {
    if (busy && !force) return;
    $('print-modal').hidden = true;
    const { state } = app();
    // Leaving mid-layout cancels it; it restarts the next time the dialog opens.
    if (state.layout.status === 'running' && !force) app().cancelLayout();
  }

  function onLayoutChanged() {
    if (!ui || $('print-modal').hidden) return;
    renderLayoutState();
  }

  return { open, close, onLayoutChanged };
})();
