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

  function selection() {
    const { state } = app();
    const pag = state.layout.pagination;
    if (!pag) return null;
    const list = entries();
    const sel = WolfSelection.resolveSelection(
      { mode: ui.mode, checkedChapterIds: [...ui.checked], rangeText: ui.rangeText },
      { totalPages: pag.totalPages, spans: pag.spans },
    );
    // "chapters" = checked entries without sub-entries (a ticked part counts its chapters)
    const leaves = list.filter((e) => e.descendants.length === 0 && pag.spans[e.id]);
    sel.chapterCount =
      ui.mode === 'all' ? leaves.length : leaves.filter((e) => ui.checked.has(e.id)).length;
    return sel;
  }

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
      const label = document.createElement('label');
      label.style.paddingLeft = 6 + e.depth * 18 + 'px';
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
      li.appendChild(label);
      listEl.appendChild(li);
    }
    syncCheckboxes();
  }

  function syncCheckboxes() {
    const list = entries();
    const byId = new Map(list.map((e) => [e.id, e]));
    for (const cb of $('chapter-list').querySelectorAll('input[type=checkbox]')) {
      const e = byId.get(cb.dataset.id);
      cb.checked = ui.checked.has(e.id);
      cb.indeterminate = !cb.checked && e.descendants.some((id) => ui.checked.has(id));
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
      printBtn.disabled = pdfBtn.disabled = true;
      return;
    }
    const sel = selection();
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
    for (const id of ['btn-do-print', 'btn-save-pdf']) $(id).disabled = on;
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
      const res = await wolf.print({ bookId: app().state.bookId, pages: sel.pages, deviceName, copies, duplex, color });
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
    const entry = entries().find((x) => x.id === cb.dataset.id);
    if (!entry) return;
    const ids = [entry.id, ...entry.descendants].filter((id) => pag.spans[id]);
    if (cb.checked) ids.forEach((id) => ui.checked.add(id));
    else {
      ids.forEach((id) => ui.checked.delete(id));
      entry.ancestors.forEach((id) => ui.checked.delete(id)); // a part is only "whole" if all of it is ticked
    }
    syncCheckboxes();
    renderSummary();
  }

  function selectAll(on) {
    const pag = app().state.layout.pagination;
    ui.checked = new Set(on ? entries().filter((e) => pag.spans[e.id]).map((e) => e.id) : []);
    syncCheckboxes();
    renderSummary();
  }

  document.querySelectorAll('input[name=print-mode]').forEach((r) => r.addEventListener('change', onModeChange));
  $('chapter-list').addEventListener('change', onChapterToggle);
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
  $('copies').addEventListener('change', (e) => {
    e.target.value = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1));
  });

  /* ---------------- public API ---------------- */

  function open() {
    const { state } = app();
    if (!state.bookId) return;
    if (!ui || ui.bookId !== state.bookId) {
      ui = { bookId: state.bookId, mode: 'all', checked: new Set(), rangeText: '' };
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
