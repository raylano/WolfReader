/* global ePub, WolfSelection, PrintDialog */
/*
 * Wolfreader UI: open a book, show cover/metadata/contents, render the reading
 * pane with epub.js, and keep a print layout (exact page numbers per chapter)
 * ready in the background for the print dialog.
 */
(function () {
  'use strict';

  const wolf = window.wolf;
  const $ = (id) => document.getElementById(id);
  const BOOK_READY_TIMEOUT_MS = 30000;

  const state = {
    bookId: null,
    book: null,
    rendition: null,
    info: null, // {title, author, language, fileName}
    sections: [], // [{index, href, url}] in print order
    chapters: [], // flattened TOC: [{id, label, depth, sectionIndex, fragment, navHref}]
    hasToc: false,
    layout: { status: 'idle', pagination: null, error: null, progress: null, paper: 'A4' },
    settings: {},
    fontScale: 100,
    currentSection: null,
    lastCfi: null, // reading position, kept when switching tabs
    opening: false,
  };

  /** Open books, one tab each: {bookId, res, filePath, title, cfi, layout}. */
  const tabs = [];
  const activeTab = () => tabs.find((t) => t.bookId === state.bookId) || null;
  const samePath = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

  /* ---------------- small UI helpers ---------------- */

  function setView(view) {
    $('welcome').hidden = view !== 'welcome';
    $('loading').hidden = view !== 'loading';
    $('reader').hidden = view !== 'reader';
    document.body.className = 'state-' + view;
    $('btn-print').disabled = view !== 'reader';
    $('topbar-book').hidden = view !== 'reader';
  }

  let toastTimer = null;
  function toast(message, { error = false, timeout = 5000 } = {}) {
    const el = $('toast');
    el.textContent = message;
    el.classList.toggle('error', error);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), timeout);
  }

  function showWelcomeError(title, message) {
    const el = $('welcome-error');
    el.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = title;
    el.append(strong, document.createTextNode(message));
    el.hidden = false;
  }

  function cleanLabel(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function withTimeout(promise, ms, message) {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]).finally(() => clearTimeout(timer));
  }

  function normalizeUrl(u) {
    try {
      const url = new URL(u);
      return decodeURIComponent(url.pathname).toLowerCase();
    } catch {
      return null;
    }
  }

  function decodeFragment(f) {
    try {
      return decodeURIComponent(f);
    } catch {
      return f;
    }
  }

  /* ---------------- modals ---------------- */

  function openModal(id) {
    const m = $(id);
    m.hidden = false;
    const focusable = m.querySelector('[data-autofocus], button.btn-primary, button');
    if (focusable) setTimeout(() => focusable.focus(), 0);
  }
  function closeModal(id) {
    $(id).hidden = true;
  }
  document.addEventListener('click', (e) => {
    const closer = e.target.closest('[data-close]');
    if (closer) {
      const modal = closer.closest('.modal-backdrop');
      if (modal && modal.id === 'print-modal') PrintDialog.close();
      else if (modal) modal.hidden = true;
    }
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('print-modal').hidden) PrintDialog.close();
    else if (!$('about-modal').hidden) closeModal('about-modal');
  });

  async function showAbout() {
    try {
      const info = await wolf.appInfo();
      $('about-version').textContent = `Version ${info.version}`;
    } catch {
      $('about-version').textContent = '';
    }
    openModal('about-modal');
  }

  /* ---------------- updates ---------------- */

  let updateDismissed = null; // version the user said "Later" to
  let lastUpdate = { state: 'idle' };

  function showUpdate(s) {
    lastUpdate = s || { state: 'idle' };
    const banner = $('update-banner');
    const text = $('update-text');
    const action = $('update-action');
    const later = $('update-later');
    const about = $('about-update');
    action.disabled = false;
    later.hidden = false;
    let show = false;
    let aboutText = '';
    switch (lastUpdate.state) {
      case 'available':
        show = updateDismissed !== lastUpdate.version;
        text.textContent = `Wolfreader ${lastUpdate.version} is available (you have ${lastUpdate.current}).`;
        action.textContent = 'Download and install';
        action.dataset.do = 'download';
        aboutText = `Version ${lastUpdate.version} is available.`;
        break;
      case 'downloading':
        show = true;
        text.textContent = `Downloading the update… ${lastUpdate.percent || 0}%`;
        action.textContent = 'Downloading…';
        action.disabled = true;
        later.hidden = true;
        aboutText = text.textContent;
        break;
      case 'downloaded':
        show = true;
        text.textContent = `Wolfreader ${lastUpdate.version} is ready. Restart to update — or it installs when you close Wolfreader.`;
        action.textContent = 'Restart now';
        action.dataset.do = 'install';
        aboutText = `Version ${lastUpdate.version} is ready to install.`;
        break;
      case 'checking':
        aboutText = 'Checking for updates…';
        break;
      case 'latest':
        aboutText = 'You have the latest version.';
        break;
      case 'unsupported':
        aboutText = 'Updates are only available in the installed Windows app.';
        break;
      case 'error':
        aboutText = lastUpdate.message || 'Checking for updates didn’t work.';
        break;
    }
    banner.hidden = !show;
    about.textContent = aboutText;
    about.hidden = !aboutText;
  }

  async function checkForUpdates() {
    showAbout();
    showUpdate({ state: 'checking' });
    showUpdate(await wolf.checkForUpdates());
  }

  $('update-action').addEventListener('click', async () => {
    const what = $('update-action').dataset.do;
    if (what === 'download') showUpdate(await wolf.downloadUpdate());
    else if (what === 'install') wolf.installUpdate();
  });
  $('update-later').addEventListener('click', () => {
    if (lastUpdate.state === 'available') updateDismissed = lastUpdate.version;
    $('update-banner').hidden = true;
  });
  $('btn-check-updates').addEventListener('click', async () => {
    showUpdate({ state: 'checking' });
    showUpdate(await wolf.checkForUpdates());
  });
  wolf.onUpdateStatus(showUpdate);

  /* ---------------- opening books ---------------- */

  async function pickAndOpen() {
    const file = await wolf.pickBook();
    if (file) await openPath(file);
  }

  // A request that arrives while a book is still opening (a click, a file from Explorer) runs
  // right after it instead of being dropped. Only the latest one is kept.
  let queued = null;
  function runQueued() {
    const next = queued;
    queued = null;
    if (next) next();
  }

  async function openPath(filePath) {
    if (!filePath) return;
    if (state.opening) {
      queued = () => openPath(filePath);
      return;
    }
    const existing = tabs.find((t) => samePath(t.filePath, filePath));
    if (existing) {
      await switchTab(existing);
      return;
    }
    state.opening = true;
    const hadBook = Boolean(state.bookId);
    $('welcome-error').hidden = true;
    PrintDialog.close(true);
    setView('loading');
    $('loading-text').textContent = 'Opening book…';

    try {
      const res = await wolf.openBook(filePath);
      if (!res.ok) {
        const title = res.code === 'drm' ? 'This book is DRM-protected' : 'This book can’t be opened';
        if (hadBook && state.bookId) {
          setView('reader');
          toast(`${title}. ${res.message}`, { error: true, timeout: 9000 });
        } else {
          setView('welcome');
          showWelcomeError(title, res.message);
        }
        return;
      }
      saveActiveTab();
      teardownBook(false);
      const tab = {
        bookId: res.bookId,
        res,
        filePath,
        title: res.fileName.replace(/\.epub$/i, ''),
        cfi: null,
        layout: { status: 'idle', pagination: null, error: null, progress: null, paper: defaultPaper() },
      };
      tabs.push(tab);
      await loadBook(res, filePath, tab);
    } finally {
      state.opening = false;
      runQueued();
    }
  }

  /* ---------------- tabs ---------------- */

  function saveActiveTab() {
    const tab = activeTab();
    if (tab) tab.cfi = state.lastCfi;
  }

  async function switchTab(tab) {
    if (!tab) return;
    if (state.opening) {
      queued = () => switchTab(tab);
      return;
    }
    if (tab.bookId === state.bookId) {
      setView('reader');
      return;
    }
    state.opening = true;
    try {
      PrintDialog.close(true);
      saveActiveTab();
      teardownBook(false);
      setView('loading');
      $('loading-text').textContent = 'Opening book…';
      await loadBook(tab.res, tab.filePath, tab);
    } finally {
      state.opening = false;
      runQueued();
    }
  }

  async function closeTab(tab) {
    if (!tab) return;
    if (state.opening) {
      queued = () => closeTab(tab);
      return;
    }
    const index = tabs.indexOf(tab);
    if (index < 0) return;
    const wasActive = tab.bookId === state.bookId;
    tabs.splice(index, 1);
    if (!wasActive) {
      wolf.closeBook(tab.bookId);
      renderTabs();
      return;
    }
    PrintDialog.close(true);
    teardownBook(true, tab.bookId);
    const next = tabs[Math.min(index, tabs.length - 1)];
    if (next) await switchTab(next);
    else {
      document.title = 'Wolfreader';
      setView('welcome');
    }
    renderTabs();
  }

  function renderTabs() {
    const bar = $('tabbar');
    bar.innerHTML = '';
    bar.hidden = tabs.length === 0;
    for (const tab of tabs) {
      const el = document.createElement('div');
      el.className = 'tab' + (tab.bookId === state.bookId ? ' active' : '');
      el.dataset.bookId = tab.bookId;
      el.setAttribute('role', 'tab');
      el.setAttribute('aria-selected', String(tab.bookId === state.bookId));
      const label = document.createElement('button');
      label.className = 'tab-label';
      label.textContent = tab.title;
      label.title = tab.filePath;
      label.addEventListener('click', () => switchTab(tab));
      const close = document.createElement('button');
      close.className = 'tab-close';
      close.textContent = '×';
      close.setAttribute('aria-label', `Close ${tab.title}`);
      close.addEventListener('click', (e) => {
        e.stopPropagation();
        closeTab(tab);
      });
      el.append(label, close);
      bar.appendChild(el);
    }
  }

  function friendlyReadError(err) {
    const msg = String((err && err.message) || err || '');
    if (/took too long/i.test(msg)) return 'Reading the book took too long. The file may be damaged or extremely large.';
    if (/damaged package/i.test(msg)) return 'Its package document (the list of everything in the book) is damaged.';
    return 'Its contents seem to be damaged or use a structure Wolfreader doesn’t understand.';
  }

  async function loadBook(res, filePath, tab) {
    state.bookId = res.bookId;
    if (tab) state.layout = tab.layout; // shared object: background layout results land in the tab
    renderTabs();
    let book;
    try {
      // epub.js silently hangs on an unparseable package document; check it first.
      const opfText = await (await fetch(res.opfUrl)).text();
      const opfDoc = new DOMParser().parseFromString(opfText, 'application/xml');
      if (opfDoc.getElementsByTagName('parsererror').length) throw new Error('damaged package document');
      book = ePub(res.opfUrl, { openAs: 'opf' });
      state.book = book;
      patchSpineLookup(book);
      await withTimeout(book.ready, BOOK_READY_TIMEOUT_MS, 'Reading the book took too long.');
      if (!book.spine.spineItems.length) throw new Error('empty spine');
    } catch (err) {
      console.error('Book failed to load', err);
      const id = state.bookId;
      teardownBook(true, id);
      const i = tabs.findIndex((t) => t.bookId === id);
      if (i >= 0) tabs.splice(i, 1);
      renderTabs();
      if (tabs.length) {
        const fallback = tabs[tabs.length - 1];
        state.opening = false;
        await switchTab(fallback);
        toast(`This EPUB couldn’t be read. ${friendlyReadError(err)}`, { error: true, timeout: 9000 });
        return;
      }
      setView('welcome');
      showWelcomeError('This EPUB couldn’t be read', friendlyReadError(err));
      return;
    }

    const meta = (book.packaging && book.packaging.metadata) || {};
    state.info = {
      title: cleanLabel(meta.title) || res.fileName.replace(/\.epub$/i, ''),
      author: cleanLabel(meta.creator),
      language: cleanLabel(meta.language),
      fileName: res.fileName,
      filePath,
    };
    if (tab) {
      tab.title = state.info.title;
      renderTabs();
    }

    buildModel(book, res.opfUrl);
    renderBookCard(book);
    renderToc();
    setView('reader');
    $('topbar-title').textContent = state.info.title + (state.info.author ? ` — ${state.info.author}` : '');
    document.title = `${state.info.title} – Wolfreader`;

    await renderReader(book, tab && tab.cfi);
    // A tab that was already laid out (or still is) keeps that work.
    if (['idle', 'cancelled', 'error'].includes(state.layout.status)) startLayout();
    else setLayout({});
  }

  /** epub.js' spine.get() can't find the first spine item by href (`0 || …`). */
  function patchSpineLookup(book) {
    const spine = book.spine;
    const original = spine.get.bind(spine);
    spine.get = function (target) {
      if (typeof target === 'string' && target && target[0] !== '#' && !spine.epubcfi.isCfiString(target)) {
        const href = target.split('#')[0];
        for (const key of [href, encodeURI(href), safeDecode(href)]) {
          if (Object.prototype.hasOwnProperty.call(spine.spineByHref, key)) {
            return spine.spineItems[spine.spineByHref[key]] || null;
          }
        }
      }
      return original(target);
    };
  }

  function safeDecode(s) {
    try {
      return decodeURI(s);
    } catch {
      return s;
    }
  }

  /** Works out print sections and chapters (TOC entries mapped onto spine items). */
  function buildModel(book, opfUrl) {
    const items = book.spine.spineItems;
    const byUrl = new Map();
    for (const s of items) {
      const key = normalizeUrl(s.url);
      if (key && !byUrl.has(key)) byUrl.set(key, s);
    }
    const nav = book.packaging.navPath || book.packaging.ncxPath;
    const bases = [];
    try {
      if (nav) bases.push(new URL(nav, opfUrl).href);
    } catch {
      /* ignore */
    }
    bases.push(opfUrl);

    function resolve(href) {
      if (!href) return null;
      const [path, frag] = String(href).split('#');
      let section = null;
      if (path) {
        for (const base of bases) {
          let key = null;
          try {
            key = normalizeUrl(new URL(path, base).href);
          } catch {
            /* ignore */
          }
          if (key && byUrl.has(key)) {
            section = byUrl.get(key);
            break;
          }
        }
        if (!section) section = book.spine.get(path);
      }
      if (!section) return null;
      return { section, fragment: frag ? decodeFragment(frag) : null };
    }

    const chapters = [];
    let n = 0;
    (function walk(list, depth) {
      for (const item of list || []) {
        const r = resolve(item.href);
        chapters.push({
          id: 't' + n++,
          label: cleanLabel(item.label) || 'Untitled',
          depth,
          sectionIndex: r ? r.section.index : null,
          fragment: r ? r.fragment : null,
          navHref: r ? r.section.href + (r.fragment ? '#' + r.fragment : '') : null,
        });
        walk(item.subitems, depth + 1);
      }
    })(book.navigation && book.navigation.toc, 0);

    state.hasToc = chapters.some((c) => c.sectionIndex !== null);
    state.chapters = state.hasToc ? chapters : [];

    const referenced = new Set(state.chapters.map((c) => c.sectionIndex));
    let sections = items.filter((s) => s.linear || referenced.has(s.index));
    if (!sections.length) sections = items;
    state.sections = sections.map((s) => ({ index: s.index, href: s.href, url: s.url }));
  }

  async function renderBookCard(book) {
    $('book-title').textContent = state.info.title;
    $('book-author').textContent = state.info.author;
    $('book-author').hidden = !state.info.author;
    $('book-pages').textContent = '';
    const cover = $('cover');
    cover.innerHTML = '<span class="cover-fallback" aria-hidden="true">📖</span>';
    try {
      const url = await book.coverUrl();
      if (url && state.book === book) {
        const img = new Image();
        img.alt = 'Cover';
        img.onload = () => {
          cover.innerHTML = '';
          cover.appendChild(img);
        };
        img.src = url;
      }
    } catch {
      /* no cover: keep the fallback */
    }
  }

  function renderToc() {
    const toc = $('toc');
    toc.innerHTML = '';
    const note = $('toc-note');
    if (state.hasToc) {
      note.hidden = true;
      for (const ch of state.chapters) {
        const a = document.createElement('a');
        a.textContent = ch.label;
        a.style.paddingLeft = 10 + ch.depth * 16 + 'px';
        a.dataset.id = ch.id;
        if (ch.navHref) a.addEventListener('click', () => display(ch.navHref));
        else {
          a.classList.add('unavailable');
          a.title = 'This entry points to a part of the book that could not be found';
        }
        toc.appendChild(a);
      }
    } else {
      note.hidden = false;
      note.textContent = 'This book has no usable table of contents, so its parts are listed in reading order.';
      state.sections.forEach((s, i) => {
        const a = document.createElement('a');
        a.textContent = `Part ${i + 1}`;
        a.dataset.section = String(s.index);
        a.addEventListener('click', () => display(s.index));
        toc.appendChild(a);
      });
    }
  }

  /* ---------------- reading pane ---------------- */

  const READER_THEME = {
    body: {
      color: '#2a1b12',
      'line-height': '1.6',
      'max-width': '46em',
      margin: '0 auto !important',
      padding: '32px 48px 48px !important',
      background: 'transparent !important',
    },
    img: { 'max-width': '100% !important', height: 'auto' },
    svg: { 'max-width': '100% !important' },
    a: { color: '#9a5418' },
    '::selection': { background: '#f6d3a2' },
  };

  async function renderReader(book, startCfi) {
    const viewer = $('viewer');
    viewer.innerHTML = '';
    $('reader-notice').hidden = true;
    const rendition = book.renderTo(viewer, {
      width: '100%',
      height: '100%',
      flow: 'scrolled-doc',
      spread: 'none',
      allowScriptedContent: false,
    });
    state.rendition = rendition;
    rendition.themes.default(READER_THEME);
    rendition.themes.fontSize(state.fontScale + '%');
    rendition.hooks.content.register((contents) => {
      const doc = contents.document;
      // External links: open in the system browser (the sandboxed frame can't).
      doc.addEventListener('click', (e) => {
        const a = e.target.closest && e.target.closest('a[href]');
        if (a && /^(https?:|mailto:)/i.test(a.getAttribute('href'))) {
          e.preventDefault();
          wolf.openExternal(a.getAttribute('href'));
        }
      });
      doc.addEventListener('dragenter', onDragEnter);
      doc.addEventListener('dragover', (e) => e.preventDefault());
      doc.addEventListener('keydown', onKey);
    });
    rendition.on('relocated', (location) => onRelocated(location));

    const first = state.sections[0] ? state.sections[0].index : 0;
    try {
      await display(startCfi || first);
    } catch {
      /* display() already reported it */
    }
    if (rendition.manager && rendition.manager.container) {
      rendition.manager.container.addEventListener('scroll', onReaderScroll, { passive: true });
    }
  }

  async function display(target) {
    if (!state.rendition) return;
    try {
      await state.rendition.display(target);
      $('reader-notice').hidden = true;
    } catch (err) {
      console.error('display failed', target, err);
      const notice = $('reader-notice');
      notice.textContent = 'This part of the book couldn’t be displayed. It may be damaged — you can still print the rest.';
      notice.hidden = false;
    }
  }

  function onRelocated(location) {
    if (location && location.start && location.start.cfi) state.lastCfi = location.start.cfi;
    state.currentSection = location && location.start ? location.start.index : null;
    $('btn-prev').disabled = !location || location.atStart;
    $('btn-next').disabled = !location || location.atEnd;
    updateCurrent();
  }

  /**
   * The chapter being read: the last TOC entry whose anchor is above the
   * reading position. Needed because one spine file can hold many chapters
   * (single-file books), so the section alone isn't enough.
   */
  function currentChapter() {
    if (!state.hasToc || state.currentSection === null) return null;
    const index = state.currentSection;
    const r = state.rendition;
    const container = r && r.manager && r.manager.container;
    const view = r && r.manager && r.manager.views && r.manager.views.all().find((v) => v.section && v.section.index === index);
    const doc = view && view.contents && view.contents.document;

    let current = null;
    for (const ch of state.chapters) {
      if (ch.sectionIndex === null) continue;
      if (ch.sectionIndex < index) {
        current = ch; // a chapter that began in an earlier file
        continue;
      }
      if (ch.sectionIndex > index) break;
      if (!ch.fragment || !doc || !container) {
        current = ch;
        continue;
      }
      const el = doc.getElementById(ch.fragment) || doc.getElementsByName(ch.fragment)[0];
      if (!el) continue;
      const top = el.getBoundingClientRect().top + view.element.offsetTop;
      if (top <= container.scrollTop + 120) current = ch;
      else break;
    }
    return current;
  }

  function updateCurrent() {
    const current = currentChapter();
    const index = state.currentSection;
    const key = current ? current.id : 'section-' + index;
    if (key !== state.currentKey) {
      state.currentKey = key;
      for (const a of $('toc').querySelectorAll('a')) {
        const isCurrent = current ? a.dataset.id === current.id : a.dataset.section === String(index);
        a.classList.toggle('current', isCurrent);
        if (isCurrent) a.scrollIntoView({ block: 'nearest' });
      }
    }
    updatePagerLabel(current, index);
  }

  let scrollQueued = false;
  function onReaderScroll() {
    if (scrollQueued) return;
    scrollQueued = true;
    requestAnimationFrame(() => {
      scrollQueued = false;
      updateCurrent();
    });
  }

  function updatePagerLabel(chapter, sectionIndex) {
    const pag = state.layout.pagination;
    let label = chapter ? chapter.label : '';
    if (!label) {
      const pos = state.sections.findIndex((s) => s.index === sectionIndex);
      label = pos >= 0 ? `Part ${pos + 1} of ${state.sections.length}` : '';
    }
    if (pag) {
      const span = chapter && pag.spans[chapter.id];
      const start = span ? span.startPage : pag.sectionStarts[sectionIndex];
      if (span) label += ` · print pages ${span.startPage}–${span.endPage}`;
      else if (start) label += ` · print page ${start}`;
    }
    $('pager-label').textContent = label;
  }

  function changeFont(delta) {
    state.fontScale = Math.max(70, Math.min(180, state.fontScale + delta));
    if (state.rendition) state.rendition.themes.fontSize(state.fontScale + '%');
  }

  function onKey(e) {
    if (e.target && /^(input|textarea|select)$/i.test(e.target.tagName)) return;
    if (!$('print-modal').hidden || !state.rendition) return;
    if (e.key === 'ArrowLeft' && e.altKey) state.rendition.prev();
    if (e.key === 'ArrowRight' && e.altKey) state.rendition.next();
  }

  /* ---------------- print layout (background) ---------------- */

  function defaultPaper() {
    if (state.settings.paper) return state.settings.paper;
    return /^(en-US|en-CA|es-MX|fr-CA)$/i.test(navigator.language) ? 'Letter' : 'A4';
  }

  /** Updates the layout of book `bookId` — also when that book's tab isn't the active one. */
  function setLayoutFor(bookId, patch) {
    const tab = tabs.find((t) => t.bookId === bookId);
    if (bookId === state.bookId) setLayout(patch);
    else if (tab) Object.assign(tab.layout, patch);
  }

  function setLayout(patch) {
    Object.assign(state.layout, patch);
    PrintDialog.onLayoutChanged();
    const pag = state.layout.pagination;
    $('book-pages').textContent =
      state.layout.status === 'ready' && pag
        ? `${pag.totalPages} printed pages (${pag.paper})`
        : state.layout.status === 'running'
          ? 'Counting printed pages…'
          : '';
    if (state.layout.status === 'ready') updateCurrent();
  }

  function startLayout(paper) {
    if (!state.bookId) return;
    const bookId = state.bookId;
    const chosen = paper || state.layout.paper || defaultPaper();
    setLayout({ status: 'running', pagination: null, error: null, progress: null, paper: chosen });
    wolf
      .prepareLayout({
        bookId,
        title: state.info.title,
        author: state.info.author,
        language: state.info.language,
        paper: chosen,
        sections: state.sections,
        chapters: state.chapters.map(({ id, depth, sectionIndex, fragment }) => ({ id, depth, sectionIndex, fragment })),
      })
      .then((res) => {
        if (res.ok) setLayoutFor(bookId, { status: 'ready', pagination: res.pagination, error: null });
        else if (res.cancelled) setLayoutFor(bookId, { status: 'cancelled' });
        else setLayoutFor(bookId, { status: 'error', error: res.message });
      })
      .catch((err) => setLayoutFor(bookId, { status: 'error', error: String(err.message || err) }));
  }

  /** Called by the print dialog: (re)start the layout if it isn't usable. */
  function ensureLayout() {
    if (['idle', 'cancelled', 'error'].includes(state.layout.status)) startLayout();
  }

  async function changePaper(paper) {
    if (!state.bookId || paper === state.layout.paper) return;
    wolf.setSettings({ paper });
    state.settings.paper = paper;
    if (state.layout.status !== 'ready') {
      startLayout(paper);
      return;
    }
    const bookId = state.bookId;
    setLayout({ status: 'running', paper, progress: { phase: 'paginating' } });
    const res = await wolf.setPaper(bookId, paper);
    if (res.ok) setLayoutFor(bookId, { status: 'ready', pagination: res.pagination });
    else if (res.cancelled) setLayoutFor(bookId, { status: 'cancelled' });
    else setLayoutFor(bookId, { status: 'error', error: res.message });
  }

  function cancelLayout() {
    if (state.bookId) wolf.cancelLayout(state.bookId);
  }

  wolf.onLayoutProgress((p) => {
    if (p.bookId !== state.bookId || state.layout.status !== 'running') return;
    state.layout.progress = p;
    PrintDialog.onLayoutChanged();
  });

  /* ---------------- closing ---------------- */

  function teardownBook(closeInMain, id = state.bookId) {
    if (state.rendition) {
      try {
        state.rendition.destroy();
      } catch {
        /* ignore */
      }
    }
    if (state.book) {
      try {
        state.book.destroy();
      } catch {
        /* ignore */
      }
    }
    if (closeInMain && id) wolf.closeBook(id);
    state.book = null;
    state.rendition = null;
    state.bookId = null;
    state.info = null;
    state.sections = [];
    state.chapters = [];
    state.hasToc = false;
    state.currentSection = null;
    state.currentKey = null;
    state.lastCfi = null;
    state.layout = { status: 'idle', pagination: null, error: null, progress: null, paper: state.layout.paper };
    $('viewer').innerHTML = '';
  }

  function closeBook() {
    const tab = activeTab();
    if (tab) closeTab(tab);
  }

  /* ---------------- drag and drop ---------------- */

  function hasFiles(e) {
    return e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  }
  function onDragEnter(e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    $('drop-overlay').hidden = false;
  }
  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => e.preventDefault());
  const overlay = $('drop-overlay');
  overlay.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });
  overlay.addEventListener('dragleave', (e) => {
    if (e.target === overlay) overlay.hidden = true;
  });
  overlay.addEventListener('drop', (e) => {
    e.preventDefault();
    overlay.hidden = true;
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (!file) return;
    if (!/\.epub$/i.test(file.name)) {
      toast('Only EPUB files (.epub) can be opened in Wolfreader.', { error: true });
      return;
    }
    let p = '';
    try {
      p = wolf.pathForFile(file);
    } catch {
      /* ignore */
    }
    if (p) openPath(p);
    else toast('That file couldn’t be opened from here. Use the Open button instead.', { error: true });
  });

  /* ---------------- wiring ---------------- */

  $('btn-open').addEventListener('click', pickAndOpen);
  $('btn-open-welcome').addEventListener('click', pickAndOpen);
  $('btn-print').addEventListener('click', () => PrintDialog.open());
  $('btn-about').addEventListener('click', showAbout);
  $('btn-prev').addEventListener('click', () => state.rendition && state.rendition.prev());
  $('btn-next').addEventListener('click', () => state.rendition && state.rendition.next());
  $('btn-font-down').addEventListener('click', () => changeFont(-10));
  $('btn-font-up').addEventListener('click', () => changeFont(10));
  document.addEventListener('keydown', onKey);

  wolf.onMenu((cmd) => {
    if (cmd === 'open') pickAndOpen();
    else if (cmd === 'print' && state.bookId) PrintDialog.open();
    else if (cmd === 'close') closeBook();
    else if (cmd === 'about') showAbout();
    else if (cmd === 'check-updates') checkForUpdates();
  });
  wolf.onOpenFile((file) => openPath(file));

  window.WolfApp = { state, toast, openModal, closeModal, ensureLayout, changePaper, cancelLayout, startLayout, openPath, closeBook };

  (async function init() {
    setView('welcome');
    try {
      state.settings = (await wolf.getSettings()) || {};
    } catch {
      state.settings = {};
    }
    state.layout.paper = defaultPaper();
    wolf.updateStatus().then(showUpdate, () => {});
    const pending = await wolf.takePendingFile();
    if (pending) openPath(pending);
  })();
})();
