const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const JSZip = require('jszip');
const { EpubArchive, deobfuscateFont, IDPF_FONT_ALGO, ADOBE_FONT_ALGO } = require('../../src/main/epub-archive');
const { repairBareAmpersands } = require('../../src/main/protocol');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wolfreader-unit-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const CONTAINER = `<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles>
  <rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const OPF = (spine = '<itemref idref="c1"/>') => `<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="uid" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">urn:uuid:12345678-1234-1234-1234-123456789abc</dc:identifier><dc:title>T</dc:title></metadata>
  <manifest><item id="c1" href="Text/C1.xhtml" media-type="application/xhtml+xml"/></manifest><spine>${spine}</spine></package>`;

async function makeEpub(name, files) {
  const zip = new JSZip();
  zip.file('mimetype', 'application/epub+zip');
  for (const [p, data] of Object.entries(files)) zip.file(p, data);
  const file = path.join(tmp, name);
  fs.writeFileSync(file, await zip.generateAsync({ type: 'nodebuffer' }));
  return file;
}

const encryption = (algo, uri) => `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container" xmlns:enc="http://www.w3.org/2001/04/xmlenc#">
  <enc:EncryptedData><enc:EncryptionMethod Algorithm="${algo}"/><enc:CipherData><enc:CipherReference URI="${uri}"/></enc:CipherData></enc:EncryptedData></encryption>`;

test('opens a valid book, finds the OPF and reads entries case-insensitively', async () => {
  const file = await makeEpub('ok.epub', {
    'META-INF/container.xml': CONTAINER,
    'OPS/book.opf': OPF(),
    'OPS/Text/C1.xhtml': '<html><body>hi</body></html>',
  });
  const a = await EpubArchive.open(file);
  assert.equal(a.opfPath, 'OPS/book.opf');
  assert.equal(a.uniqueIdentifier, 'urn:uuid:12345678-1234-1234-1234-123456789abc');
  assert.match(await a.readText('ops/text/c1.xhtml'), /hi/);
  a.close();
});

test('rejects non-zip, empty, DRM and empty-spine files with codes', async () => {
  const notZip = path.join(tmp, 'nz.epub');
  fs.writeFileSync(notZip, 'hello');
  await assert.rejects(EpubArchive.open(notZip), { code: 'corrupt' });

  const empty = path.join(tmp, 'empty.epub');
  fs.writeFileSync(empty, '');
  await assert.rejects(EpubArchive.open(empty), { code: 'empty-file' });

  await assert.rejects(EpubArchive.open(path.join(tmp, 'missing.epub')), { code: 'not-found' });

  const adept = await makeEpub('adept.epub', { 'META-INF/container.xml': CONTAINER, 'OPS/book.opf': OPF(), 'META-INF/rights.xml': '<r/>' });
  await assert.rejects(EpubArchive.open(adept), { code: 'drm', message: /Adobe DRM/ });

  const aes = await makeEpub('aes.epub', {
    'META-INF/container.xml': CONTAINER,
    'OPS/book.opf': OPF(),
    'META-INF/encryption.xml': encryption('http://www.w3.org/2001/04/xmlenc#aes128-cbc', 'OPS/Text/C1.xhtml'),
  });
  await assert.rejects(EpubArchive.open(aes), { code: 'drm' });

  const noSpine = await makeEpub('nospine.epub', { 'META-INF/container.xml': CONTAINER, 'OPS/book.opf': OPF('') });
  await assert.rejects(EpubArchive.open(noSpine), { code: 'empty-book' });

  const noOpf = await makeEpub('noopf.epub', { 'readme.txt': 'x' });
  await assert.rejects(EpubArchive.open(noOpf), { code: 'not-epub' });
});

test('font obfuscation is not mistaken for DRM and is undone on read', async () => {
  const font = crypto.randomBytes(3000);
  const id = 'urn:uuid:12345678-1234-1234-1234-123456789abc';
  const obfuscated = deobfuscateFont(font, IDPF_FONT_ALGO, id); // XOR is its own inverse
  const file = await makeEpub('font.epub', {
    'META-INF/container.xml': CONTAINER,
    'OPS/book.opf': OPF(),
    'OPS/Fonts/f.otf': obfuscated,
    'META-INF/encryption.xml': encryption(IDPF_FONT_ALGO, 'OPS/Fonts/f.otf'),
  });
  const a = await EpubArchive.open(file);
  assert.ok((await a.read('OPS/Fonts/f.otf')).equals(font));
  a.close();

  const adobe = deobfuscateFont(deobfuscateFont(font, ADOBE_FONT_ALGO, id), ADOBE_FONT_ALGO, id);
  assert.ok(adobe.equals(font));
  assert.ok(!deobfuscateFont(font, ADOBE_FONT_ALGO, id).subarray(0, 1024).equals(font.subarray(0, 1024)));
});

test('bare ampersands are escaped, entities are left alone', () => {
  const out = repairBareAmpersands(Buffer.from('<t>Pride & Prejudice &amp; &#38; &#x26; &nbsp;</t>')).toString();
  assert.equal(out, '<t>Pride &amp; Prejudice &amp; &#38; &#x26; &nbsp;</t>');
  const clean = Buffer.from('<t>no amps</t>');
  assert.equal(repairBareAmpersands(clean), clean);
});
