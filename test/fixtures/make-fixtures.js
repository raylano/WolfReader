#!/usr/bin/env node
/*
 * Generates edge-case EPUBs into test/fixtures/generated/.
 * The single-flow book is derived from the downloaded War and Peace sample
 * (scripts/fetch-samples.sh); everything else is synthetic.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(__dirname, 'generated');
const SAMPLES = path.join(ROOT, 'test', 'samples');
fs.mkdirSync(OUT, { recursive: true });

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function xhtml(title, body, { head = '' } = {}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>${title}</title>${head}</head>
<body>${body}</body>
</html>`;
}

function para(n, seed) {
  const words = 'the wolf read on by lantern light while snow fell softly over the quiet pines and the pages turned'.split(' ');
  let out = '';
  for (let i = 0; i < n; i++) {
    let s = '';
    for (let w = 0; w < 70; w++) s += words[(i * 7 + w * 3 + seed) % words.length] + ' ';
    out += `<p>${s.trim()}.</p>\n`;
  }
  return out;
}

/**
 * @param {{id?:string, title:string, files:{path:string, data:string|Buffer, mediaType?:string, id?:string, props?:string}[],
 *          spine:string[], navPath?:string|null, extra?:{path:string,data:string|Buffer}[], spineXml?:string}} b
 */
async function writeEpub(name, b) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER);
  const ident = b.id || 'urn:uuid:' + crypto.randomUUID();
  const manifest = b.files
    .map((f) => {
      const id = f.id || f.path.replace(/[^a-z0-9]/gi, '_');
      return `<item id="${id}" href="${f.path}" media-type="${f.mediaType || 'application/xhtml+xml'}"${f.props ? ` properties="${f.props}"` : ''}/>`;
    })
    .join('\n    ');
  const spine =
    b.spineXml ??
    b.spine.map((p) => `<itemref idref="${(b.files.find((f) => f.path === p).id) || p.replace(/[^a-z0-9]/gi, '_')}"/>`).join('\n    ');
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${ident}</dc:identifier>
    <dc:title>${b.title}</dc:title>
    <dc:creator>Wolfreader Test Suite</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">2026-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    ${manifest}
  </manifest>
  <spine>
    ${spine}
  </spine>
</package>`;
  zip.file('OEBPS/content.opf', opf);
  for (const f of b.files) zip.file('OEBPS/' + f.path, f.data);
  for (const e of b.extra || []) zip.file(e.path, e.data);
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', mimeType: 'application/epub+zip' });
  fs.writeFileSync(path.join(OUT, name), buf);
  return { name, ident, bytes: buf.length };
}

function nav(entries, { pathPrefix = '' } = {}) {
  const render = (list) =>
    '<ol>' +
    list
      .map((e) => `<li><a href="${pathPrefix}${e.href}">${e.label}</a>${e.children ? render(e.children) : ''}</li>`)
      .join('') +
    '</ol>';
  return xhtml('Contents', `<nav epub:type="toc" id="toc"><h1>Contents</h1>${render(entries)}</nav>`);
}

/* ---------------- fixtures ---------------- */

async function singleFlowWarAndPeace() {
  const src = path.join(SAMPLES, 'war-and-peace-pg2600-images-3.epub');
  if (!fs.existsSync(src)) {
    console.warn('skip single-flow fixture: run scripts/fetch-samples.sh first');
    return null;
  }
  const zip = await JSZip.loadAsync(fs.readFileSync(src));
  const opf = await zip.file('OEBPS/content.opf').async('string');
  const manifest = new Map();
  for (const m of opf.matchAll(/<item\b[^>]*>/g)) {
    const id = /id="([^"]+)"/.exec(m[0])[1];
    const href = /href="([^"]+)"/.exec(m[0])[1];
    manifest.set(id, href);
  }
  const spineHrefs = [...opf.matchAll(/<itemref\b[^>]*idref="([^"]+)"/g)].map((m) => manifest.get(m[1]));
  const bodies = [];
  for (const href of spineHrefs) {
    if (!/\.x?html?$/i.test(href) || /wrap0000/.test(href)) continue;
    const text = await zip.file('OEBPS/' + href).async('string');
    const m = /<body[^>]*>([\s\S]*)<\/body>/i.exec(text);
    if (m) bodies.push(m[1]);
  }
  // Build a two-level TOC (BOOK/EPILOGUE parts containing chapters) from the original nav.
  const navText = await zip.file('OEBPS/toc.xhtml').async('string');
  const flat = [...navText.matchAll(/<a href="[^"#]+#([^"]+)"[^>]*>([^<]+)<\/a>/g)].map((m) => ({
    href: 'text/book.xhtml#' + m[1],
    label: m[2].trim(),
  }));
  const tree = [];
  let part = null;
  for (const e of flat) {
    if (/^(BOOK|FIRST EPILOGUE|SECOND EPILOGUE)/i.test(e.label)) {
      part = { ...e, children: [] };
      tree.push(part);
    } else if (part && /^CHAPTER/i.test(e.label)) part.children.push(e);
    else {
      part = null;
      tree.push(e);
    }
  }
  const css = [];
  for (const name of ['pgepub.css', '0.css']) {
    const f = zip.file('OEBPS/' + name);
    if (f) css.push({ path: 'text/' + name, data: await f.async('string'), mediaType: 'text/css' });
  }
  const head = css.map((c) => `<link rel="stylesheet" type="text/css" href="${path.basename(c.path)}"/>`).join('');
  const book = xhtml('War and Peace', bodies.join('\n'), { head });
  const result = await writeEpub('single-flow-war-and-peace.epub', {
    title: 'War and Peace (single-file edition)',
    files: [
      { path: 'nav.xhtml', data: nav(tree), props: 'nav', id: 'nav' },
      { path: 'text/book.xhtml', data: book, id: 'book' },
      ...css,
    ],
    spine: ['text/book.xhtml'],
  });
  result.tocEntries = flat.length;
  result.xhtmlBytes = Buffer.byteLength(book);
  return result;
}

async function noToc() {
  const files = [1, 2, 3].map((n) => ({
    path: `ch${n}.xhtml`,
    data: xhtml(`Part ${n}`, `<h1>Untitled part ${n}</h1>${para(12 + n * 4, n)}`),
  }));
  return writeEpub('no-toc.epub', { title: 'A Book Without Contents', files, spine: files.map((f) => f.path) });
}

async function brokenToc() {
  const files = [
    { path: 'nav.xhtml', data: nav([
      { href: 'ch1.xhtml', label: 'One (fine)' },
      { href: 'missing-file.xhtml', label: 'Two (points to a missing file)' },
      { href: 'ch2.xhtml#no-such-anchor', label: 'Three (missing anchor)' },
      { href: 'ch3.xhtml#late', label: 'Four (anchor deep inside a chapter)' },
    ]), props: 'nav', id: 'nav' },
    { path: 'ch1.xhtml', data: xhtml('One', `<h1>One</h1><script>document.title='pwned'</script><p onclick="alert(1)">Click me</p>${para(10, 1)}<img src="images/does-not-exist.png" alt="missing picture"/>`) },
    // Deliberately not well-formed XML: unclosed <p> and <br>, & unescaped.
    { path: 'ch2.xhtml', data: `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>Two</title></head><body><h1>Two & a half</h1><p>Unclosed paragraph<br>${para(8, 2)}</body></html>` },
    { path: 'ch3.xhtml', data: xhtml('Three', `<h1>Three</h1>${para(30, 3)}<h2 id="late">Late heading</h2>${para(6, 4)}`) },
  ];
  return writeEpub('broken-toc.epub', { title: 'Broken Contents & Bad Markup', files, spine: ['ch1.xhtml', 'ch2.xhtml', 'ch3.xhtml'] });
}

async function embeddedFont() {
  const fontPath = ['/usr/share/fonts/truetype/dejavu/DejaVuSerif-Bold.ttf', '/usr/share/fonts/truetype/dejavu/DejaVuSerif.ttf'].find(
    (p) => fs.existsSync(p),
  );
  if (!fontPath) {
    console.warn('skip embedded-font fixture: no DejaVu font on this system');
    return null;
  }
  const font = fs.readFileSync(fontPath);
  const ident = 'urn:uuid:7c1e9a52-3f5b-4f0e-9a51-0d2c5b7e8a11';
  // IDPF obfuscation: XOR the first 1040 bytes with SHA-1(identifier).
  const key = crypto.createHash('sha1').update(ident.replace(/[ \u0009\u000d\u000a]/g, '')).digest();
  const obf = Buffer.from(font);
  for (let i = 0; i < 1040; i++) obf[i] ^= key[i % key.length];
  const css = `@font-face { font-family: "Wolf Serif"; src: url(../fonts/wolf.ttf); }
  body { font-family: "Wolf Serif", serif; }
  h1 { color: #7a3b12; }`;
  const head = '<link rel="stylesheet" href="../styles/book.css"/>';
  const files = [
    // nav lives in a sub-folder: its hrefs are relative to it, not to the OPF
    { path: 'nav/toc.xhtml', data: nav([
      { href: 'text/ch1.xhtml', label: 'First Light' },
      { href: 'text/ch2.xhtml', label: 'Second Wind' },
    ], { pathPrefix: '../' }), props: 'nav', id: 'nav' },
    { path: 'text/ch1.xhtml', data: xhtml('First Light', `<h1>First Light</h1>${para(14, 5)}`, { head }), id: 'c1' },
    { path: 'text/ch2.xhtml', data: xhtml('Second Wind', `<h1>Second Wind</h1>${para(14, 6)}`, { head }), id: 'c2' },
    { path: 'styles/book.css', data: css, mediaType: 'text/css', id: 'css' },
    { path: 'fonts/wolf.ttf', data: obf, mediaType: 'font/ttf', id: 'font' },
  ];
  const encryption = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/fonts/wolf.ttf"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>`;
  const r = await writeEpub('embedded-font.epub', {
    id: ident,
    title: 'Embedded Obfuscated Font',
    files,
    spine: ['text/ch1.xhtml', 'text/ch2.xhtml'],
    extra: [{ path: 'META-INF/encryption.xml', data: encryption }],
  });
  r.fontSha256 = crypto.createHash('sha256').update(font).digest('hex');
  return r;
}

async function drmEncrypted() {
  const files = [{ path: 'ch1.xhtml', data: 'ENCRYPTED-BYTES-' + crypto.randomBytes(256).toString('base64') }];
  const encryption = `<?xml version="1.0"?>
<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData>
    <enc:EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
    <enc:CipherData><enc:CipherReference URI="OEBPS/ch1.xhtml"/></enc:CipherData>
  </enc:EncryptedData>
</encryption>`;
  return writeEpub('drm-encrypted.epub', {
    title: 'Encrypted',
    files,
    spine: ['ch1.xhtml'],
    extra: [{ path: 'META-INF/encryption.xml', data: encryption }],
  });
}

async function drmAdobe() {
  const files = [{ path: 'ch1.xhtml', data: xhtml('x', '<p>x</p>') }];
  return writeEpub('drm-adobe.epub', {
    title: 'Adobe DRM',
    files,
    spine: ['ch1.xhtml'],
    extra: [{ path: 'META-INF/rights.xml', data: '<adept:rights xmlns:adept="http://ns.adobe.com/adept"/>' }],
  });
}

async function emptySpine() {
  const files = [{ path: 'ch1.xhtml', data: xhtml('x', '<p>x</p>') }];
  return writeEpub('empty-spine.epub', { title: 'Nothing Here', files, spine: [], spineXml: '' });
}

async function damagedOpf() {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER);
  // Truncated mid-element: not repairable, must fail fast with a clear message.
  zip.file('OEBPS/content.opf', '<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata><dc:title>Half a book</dc:title><spine><itemref idref="c1"/></spine><manifest><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"');
  zip.file('OEBPS/c1.xhtml', xhtml('x', '<p>x</p>'));
  const buf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  fs.writeFileSync(path.join(OUT, 'damaged-opf.epub'), buf);
  return { name: 'damaged-opf.epub', bytes: buf.length };
}

function rawFixtures() {
  const alice = path.join(SAMPLES, 'alice-pg11-images-3.epub');
  const out = [];
  if (fs.existsSync(alice)) {
    const buf = fs.readFileSync(alice);
    fs.writeFileSync(path.join(OUT, 'truncated-download.epub'), buf.subarray(0, Math.floor(buf.length * 0.4)));
    out.push('truncated-download.epub');
  }
  fs.writeFileSync(path.join(OUT, 'not-a-zip.epub'), 'This is a plain text file that someone renamed to .epub\n'.repeat(20));
  fs.writeFileSync(path.join(OUT, 'zero-bytes.epub'), '');
  out.push('not-a-zip.epub', 'zero-bytes.epub');
  return out;
}

(async () => {
  const results = [];
  for (const make of [singleFlowWarAndPeace, noToc, brokenToc, embeddedFont, drmEncrypted, drmAdobe, emptySpine, damagedOpf]) {
    const r = await make();
    if (r) results.push(r);
  }
  const raw = rawFixtures();
  fs.writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify({ results, raw }, null, 2));
  for (const r of results) console.log(`fixture: ${r.name} (${r.bytes} bytes)`);
  for (const r of raw) console.log(`fixture: ${r}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
