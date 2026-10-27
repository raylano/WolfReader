/*
 * Runs inside the hidden print window. Builds one continuous, printable HTML
 * document out of the book's spine so Chromium's own print engine can
 * paginate it at a fixed paper size:
 *
 *   <section class="wr-section wr-css-N">      one per spine item
 *     <a class="wr-marker" href="…/marker/s7">  -> "section 7 starts here"
 *     <div class="wr-html"><div class="wr-body"> the section's <body> content
 *       … <h2 id="ch3"><a class="wr-marker" href="…/marker/c12"> …
 *
 * Every spine item starts on a new page, so chapters map cleanly onto pages.
 * Each item's stylesheets are rewritten to apply only inside its own section.
 */
(function () {
  'use strict';

  const MARKER_PREFIX = 'https://wolfreader.invalid/marker/';
  const XLINK = 'http://www.w3.org/1999/xlink';
  const PAPER = {
    A4: { size: 'A4', heightMm: 297 },
    Letter: { size: 'letter', heightMm: 279.4 },
  };
  const MARGINS_MM = { top: 20, right: 18, bottom: 20, left: 18 };
  const REMOVE_TAGS = 'script, noscript, iframe, frame, frameset, object, embed, applet, base, meta, title, template, audio';
  const VOID_TAGS = new Set(['img', 'br', 'hr', 'input', 'col', 'area', 'wbr', 'source', 'track']);

  const book = document.getElementById('wr-book');
  const cssTextCache = new Map(); // absolute stylesheet URL -> Promise<string>
  const styleSets = new Map(); // style-set key -> scope class
  let job = null;

  /* ---------------- page setup ---------------- */

  function cssString(s) {
    return '"' + String(s || '').replace(/[\r\n]+/g, ' ').replace(/\\/g, '\\\\').replace(/"/g, '\\"').slice(0, 90) + '"';
  }

  function applyPaper(paperName) {
    const paper = PAPER[paperName] || PAPER.A4;
    const m = MARGINS_MM;
    const maxMedia = paper.heightMm - m.top - m.bottom - 12;
    document.documentElement.style.setProperty('--wr-max-media-height', maxMedia + 'mm');
    document.getElementById('wr-page-style').textContent = `
      @page {
        size: ${paper.size};
        margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm;
        @top-center { content: ${cssString(job && job.title)}; font: italic 8pt Georgia, serif; color: #777; }
        @bottom-center { content: counter(page); font: 9pt Georgia, serif; color: #555; }
      }
      @page :first { @top-center { content: none; } }
    `;
  }

  /* ---------------- helpers ---------------- */

  async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
  }

  async function fetchText(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return res.text();
  }

  function absolutize(value, base) {
    const v = String(value || '').trim();
    if (!v || /^(data:|blob:|#)/i.test(v)) return v;
    try {
      return new URL(v, base).href;
    } catch {
      return v;
    }
  }

  function hash(text) {
    let h = 5381;
    for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }

  function marker(key) {
    const a = document.createElement('a');
    a.className = 'wr-marker';
    a.href = MARKER_PREFIX + key;
    a.setAttribute('aria-hidden', 'true');
    return a;
  }

  /* ---------------- CSS scoping ---------------- */

  function rewriteCssUrls(text, base) {
    return text.replace(/url\(\s*(['"]?)([^'")]*?)\1\s*\)/gi, (whole, q, u) => {
      if (/^(data:|blob:|#)/i.test(u.trim())) return whole;
      return `url("${absolutize(u, base)}")`;
    });
  }

  /** Inlines @import rules (depth-limited), then rewrites url()s to absolute. */
  async function loadCss(text, base, depth = 0) {
    const imports = [];
    text = text.replace(/@import\s+(?:url\(\s*)?(['"]?)([^'")\s;]+)\1\s*\)?([^;]*);/gi, (_, _q, href, media) => {
      imports.push({ href: absolutize(href, base), media: media.trim() });
      return '';
    });
    let prefix = '';
    if (depth < 3) {
      for (const imp of imports) {
        try {
          const inner = await loadCss(await fetchText(imp.href), imp.href, depth + 1);
          prefix += imp.media ? `@media ${imp.media} {\n${inner}\n}\n` : inner + '\n';
        } catch {
          /* missing imported stylesheet: ignore */
        }
      }
    }
    return prefix + rewriteCssUrls(text, base);
  }

  function splitSelectorList(sel) {
    const parts = [];
    let depth = 0;
    let quote = null;
    let start = 0;
    for (let i = 0; i < sel.length; i++) {
      const c = sel[i];
      if (quote) {
        if (c === quote && sel[i - 1] !== '\\') quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ',' && depth === 0) {
        parts.push(sel.slice(start, i));
        start = i + 1;
      }
    }
    parts.push(sel.slice(start));
    return parts.map((p) => p.trim()).filter(Boolean);
  }

  function scopeSelector(selectorText, scope) {
    return splitSelectorList(selectorText)
      .map((part) => {
        const s = part
          .replace(/:root\b/gi, '.wr-html')
          .replace(/(^|[\s>+~(])html(?=$|[\s>+~.#:[)])/gi, '$1.wr-html')
          .replace(/(^|[\s>+~(])body(?=$|[\s>+~.#:[)])/gi, '$1.wr-body');
        return `.${scope} ${s}`;
      })
      .join(', ');
  }

  function scopeRules(rules, scope, out) {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        out.body.push(`${scopeSelector(rule.selectorText, scope)} { ${rule.style.cssText} }`);
      } else if (rule instanceof CSSNamespaceRule) {
        out.namespaces.push(rule.cssText);
      } else if (rule instanceof CSSImportRule || rule instanceof CSSPageRule) {
        // imports are inlined beforehand; page geometry is ours to decide
      } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) {
        const kw = rule instanceof CSSMediaRule ? '@media' : '@supports';
        const inner = { namespaces: out.namespaces, body: [] };
        scopeRules(rule.cssRules, scope, inner);
        out.body.push(`${kw} ${rule.conditionText} {\n${inner.body.join('\n')}\n}`);
      } else {
        // @font-face, @keyframes, … are global by nature
        out.body.push(rule.cssText);
      }
    }
  }

  function scopeCss(cssText, scope) {
    const sheet = new CSSStyleSheet();
    try {
      sheet.replaceSync(cssText);
    } catch {
      return { namespaces: [], body: [] };
    }
    const out = { namespaces: [], body: [] };
    scopeRules(sheet.cssRules, scope, out);
    return out;
  }

  /** Returns the scope class for a section's list of stylesheets, creating it once. */
  async function scopeForStyles(sources) {
    const key = sources.map((s) => (s.href ? s.href : 'inline:' + hash(s.text))).join('|');
    if (styleSets.has(key)) return styleSets.get(key);
    const scope = 'wr-css-' + styleSets.size;
    styleSets.set(key, scope);

    const namespaces = [];
    const body = [];
    for (const src of sources) {
      let text;
      try {
        if (src.href) {
          if (!cssTextCache.has(src.href)) {
            cssTextCache.set(src.href, fetchText(src.href).then((t) => loadCss(t, src.href)));
          }
          text = await cssTextCache.get(src.href);
        } else {
          text = await loadCss(src.text, src.base);
        }
      } catch {
        continue; // missing stylesheet: render with defaults
      }
      const scoped = scopeCss(text, scope);
      namespaces.push(...scoped.namespaces);
      body.push(...scoped.body);
    }
    const style = document.createElement('style');
    style.dataset.scope = scope;
    style.textContent = [...new Set(namespaces), ...body].join('\n');
    document.head.appendChild(style);
    return scope;
  }

  /* ---------------- content import ---------------- */

  function parseDocument(text) {
    let doc = new DOMParser().parseFromString(text, 'application/xhtml+xml');
    if (doc.getElementsByTagName('parsererror').length || !doc.body) {
      // Plenty of real-world "XHTML" isn't well-formed; the HTML parser is forgiving.
      doc = new DOMParser().parseFromString(text, 'text/html');
    }
    return doc;
  }

  function collectStyleSources(doc, base) {
    const sources = [];
    for (const el of doc.querySelectorAll('link, style')) {
      const tag = el.localName.toLowerCase();
      if (tag === 'link') {
        const rel = (el.getAttribute('rel') || '').toLowerCase();
        const href = el.getAttribute('href');
        if (/\bstylesheet\b/.test(rel) && !/\balternate\b/.test(rel) && href) {
          sources.push({ href: absolutize(href, base) });
        }
      } else {
        sources.push({ text: el.textContent || '', base });
      }
    }
    return sources;
  }

  function sanitizeAndRewrite(root, base) {
    root.querySelectorAll(REMOVE_TAGS + ', link, style').forEach((el) => el.remove());
    const all = [root, ...root.querySelectorAll('*')];
    for (const el of all) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || /^\s*(javascript|vbscript):/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
      const tag = el.localName.toLowerCase();
      if (el.hasAttribute('src')) el.setAttribute('src', absolutize(el.getAttribute('src'), base));
      if (el.hasAttribute('poster')) el.setAttribute('poster', absolutize(el.getAttribute('poster'), base));
      if (el.hasAttribute('srcset')) {
        el.setAttribute(
          'srcset',
          el
            .getAttribute('srcset')
            .split(',')
            .map((c) => c.trim().replace(/^(\S+)/, (u) => absolutize(u, base)))
            .join(', '),
        );
      }
      if (el.hasAttribute('style') && /url\(/i.test(el.getAttribute('style'))) {
        el.setAttribute('style', rewriteCssUrls(el.getAttribute('style'), base));
      }
      if (el.namespaceURI === 'http://www.w3.org/2000/svg') {
        for (const name of ['href']) {
          if (el.hasAttribute(name)) el.setAttribute(name, absolutize(el.getAttribute(name), base));
        }
        if (el.hasAttributeNS(XLINK, 'href')) {
          el.setAttributeNS(XLINK, 'xlink:href', absolutize(el.getAttributeNS(XLINK, 'href'), base));
        }
      } else if (tag === 'a' && el.hasAttribute('href')) {
        // Keep real web links clickable in a saved PDF; drop in-book links.
        if (!/^(https?:|mailto:)/i.test(el.getAttribute('href').trim())) el.removeAttribute('href');
      }
      if (tag === 'img') {
        el.setAttribute('loading', 'eager');
        el.setAttribute('decoding', 'sync');
      }
    }
  }

  function findAnchor(section, fragment) {
    const id = CSS.escape(fragment);
    return section.querySelector(`[id="${id}"]`) || section.querySelector(`[name="${id}"]`);
  }

  async function buildSection(item, text) {
    const doc = parseDocument(text);
    const scope = await scopeForStyles(collectStyleSources(doc, item.url));

    const section = document.createElement('section');
    section.className = `wr-section ${scope}`;
    section.dataset.index = String(item.index);

    const html = document.createElement('div');
    html.className = 'wr-html';
    const body = document.createElement('div');
    const srcHtml = doc.documentElement;
    const srcBody = doc.body;
    for (const [from, to] of [
      [srcHtml, html],
      [srcBody, body],
    ]) {
      if (!from) continue;
      for (const a of ['class', 'dir', 'lang', 'style']) {
        if (from.getAttribute(a)) to.setAttribute(a, from.getAttribute(a));
      }
      const xmlLang = from.getAttributeNS('http://www.w3.org/XML/1998/namespace', 'lang');
      if (xmlLang && !to.getAttribute('lang')) to.setAttribute('lang', xmlLang);
    }
    if (srcBody && srcBody.id) body.id = srcBody.id;
    body.className = ('wr-body ' + (body.getAttribute('class') || '')).trim();
    html.className = ('wr-html ' + (html.getAttribute('class') || '').replace(/\bwr-html\b/, '')).trim();

    if (srcBody) {
      for (const child of [...srcBody.childNodes]) body.appendChild(document.importNode(child, true));
    }
    sanitizeAndRewrite(body, item.url);
    if (body.hasAttribute('style')) body.setAttribute('style', rewriteCssUrls(body.getAttribute('style'), item.url));

    html.appendChild(body);
    section.appendChild(marker('s' + item.index));
    section.appendChild(html);

    // Chapter markers for table-of-contents entries pointing inside this section.
    let missing = 0;
    for (const ch of job.chapters) {
      if (ch.sectionIndex !== item.index || !ch.fragment) continue;
      const target = findAnchor(section, ch.fragment);
      if (!target) {
        missing++;
        continue;
      }
      const m = marker('c' + ch.id);
      if (VOID_TAGS.has(target.localName.toLowerCase()) || target.namespaceURI === 'http://www.w3.org/2000/svg') {
        target.parentNode.insertBefore(m, target);
      } else {
        target.insertBefore(m, target.firstChild);
      }
    }
    return { section, missing };
  }

  async function waitForMedia(timeoutMs) {
    const waits = [];
    for (const img of document.images) {
      if (!img.complete) waits.push(img.decode().catch(() => {}));
    }
    const svgImages = document.querySelectorAll('image');
    for (const el of svgImages) {
      const href = el.getAttribute('href') || el.getAttributeNS(XLINK, 'href');
      if (!href) continue;
      const probe = new Image();
      probe.src = href;
      waits.push(probe.decode().catch(() => {}));
    }
    // Web fonts only start loading once layout asks for them, and print doesn't
    // wait for them: force layout, then load every declared face explicitly.
    void document.body.offsetHeight;
    for (const face of document.fonts) {
      if (face.status === 'unloaded') waits.push(face.load().catch(() => {}));
    }
    await Promise.race([Promise.all(waits), new Promise((r) => setTimeout(r, timeoutMs))]);
    await document.fonts.ready;
  }

  /* ---------------- entry point ---------------- */

  async function build(incoming) {
    job = incoming;
    document.title = job.title || 'Book';
    if (job.language) document.documentElement.lang = job.language;
    applyPaper(job.paper);

    const total = job.sections.length;
    let fetched = 0;
    const texts = await mapLimit(job.sections, 6, async (item) => {
      try {
        return await fetchText(item.url);
      } catch {
        return null;
      } finally {
        window.wolfPrint.progress(++fetched, total, 'reading');
      }
    });

    const failedSections = [];
    let missingAnchors = 0;
    for (let i = 0; i < job.sections.length; i++) {
      const item = job.sections[i];
      if (texts[i] == null) {
        failedSections.push(item.href);
        continue;
      }
      try {
        const { section, missing } = await buildSection(item, texts[i]);
        missingAnchors += missing;
        book.appendChild(section);
      } catch {
        failedSections.push(item.href);
      }
      if (i % 10 === 9) {
        window.wolfPrint.progress(i + 1, total, 'layout');
        await new Promise((r) => setTimeout(r, 0)); // keep the window responsive
      }
    }

    if (!book.querySelector('.wr-section')) {
      throw new Error('None of the book’s content could be read.');
    }
    window.wolfPrint.progress(total, total, 'images');
    await waitForMedia(60000);
    return { sections: book.children.length, failedSections, missingAnchors, styleSets: styleSets.size };
  }

  window.wolfPrint.onBuild(async (incoming) => {
    try {
      window.wolfPrint.ready(await build(incoming));
    } catch (err) {
      window.wolfPrint.fail(String((err && err.message) || err));
    }
  });

  window.wolfPrint.onPaper(async (paper) => {
    applyPaper(paper);
    await document.fonts.ready;
    window.wolfPrint.ready({ paper });
  });
})();
