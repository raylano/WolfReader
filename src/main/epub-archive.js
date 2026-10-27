'use strict';
/*
 * Read-only access to an EPUB (zip) file on disk.
 *
 * Builds an index of zip entries once, then streams individual entries on
 * demand, so large books never have to be held in memory as a whole. Also
 * performs the up-front sanity checks that give users a clear message instead
 * of a stack trace: not-a-zip, missing package document, DRM, empty spine.
 */
const fs = require('fs');
const crypto = require('crypto');
const yauzl = require('yauzl');

const MAX_ENTRY_BYTES = 512 * 1024 * 1024; // refuse to inflate absurd entries (zip bombs)

class EpubError extends Error {
  /** @param {'not-found'|'empty-file'|'corrupt'|'not-epub'|'drm'|'empty-book'|'read-failed'} code */
  constructor(code, message, detail) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

// Font obfuscation is not DRM: readers are expected to undo it.
const IDPF_FONT_ALGO = 'http://www.idpf.org/2008/embedding';
const ADOBE_FONT_ALGO = 'http://ns.adobe.com/pdf/enc#RC';

function openZip(filePath) {
  return new Promise((resolve, reject) => {
    yauzl.open(
      filePath,
      { lazyEntries: true, autoClose: false, decodeStrings: true, validateEntrySizes: true, strictFileNames: false },
      (err, zip) => (err ? reject(err) : resolve(zip)),
    );
  });
}

function readIndex(zip) {
  return new Promise((resolve, reject) => {
    const entries = new Map();
    zip.on('entry', (entry) => {
      if (!/\/$/.test(entry.fileName)) entries.set(entry.fileName.replace(/^\/+/, ''), entry);
      zip.readEntry();
    });
    zip.once('end', () => resolve(entries));
    zip.once('error', reject);
    zip.readEntry();
  });
}

function decodeXmlText(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i').exec(tag);
  return m ? decodeXmlText(m[2] !== undefined ? m[2] : m[3]) : null;
}

function posixDirname(p) {
  const i = p.lastIndexOf('/');
  return i === -1 ? '' : p.slice(0, i + 1);
}

/** Resolves `href` (relative to `baseDir`, both zip paths) into a normalized zip path. */
function resolveZipPath(baseDir, href) {
  const parts = (baseDir + href).split('/');
  const out = [];
  for (const part of parts) {
    if (part === '..') out.pop();
    else if (part !== '.' && part !== '') out.push(part);
  }
  return out.join('/');
}

class EpubArchive {
  constructor(filePath, zip, entries) {
    this.filePath = filePath;
    this.zip = zip;
    this.entries = entries;
    this.lowerCaseIndex = new Map();
    for (const name of entries.keys()) {
      if (!this.lowerCaseIndex.has(name.toLowerCase())) this.lowerCaseIndex.set(name.toLowerCase(), name);
    }
    this.opfPath = null;
    this.obfuscatedFonts = new Map(); // zip path -> algorithm
    this.uniqueIdentifier = '';
  }

  static async open(filePath) {
    let stat;
    try {
      stat = await fs.promises.stat(filePath);
    } catch {
      throw new EpubError('not-found', 'The file could not be found. It may have been moved or deleted.');
    }
    if (!stat.isFile()) throw new EpubError('not-found', 'That is not a file.');
    if (stat.size === 0) throw new EpubError('empty-file', 'This file is empty (0 bytes), so there is no book to open.');

    let zip;
    let entries;
    try {
      zip = await openZip(filePath);
      entries = await readIndex(zip);
    } catch (err) {
      if (zip) zip.close();
      throw new EpubError(
        'corrupt',
        'This file is not a valid EPUB. It may be damaged, incompletely downloaded, or a different kind of file renamed to .epub.',
        err.message,
      );
    }

    const archive = new EpubArchive(filePath, zip, entries);
    try {
      await archive.inspect();
    } catch (err) {
      archive.close();
      if (err instanceof EpubError) throw err;
      throw new EpubError('corrupt', 'This EPUB could not be read. The file appears to be damaged.', err.message);
    }
    return archive;
  }

  /** Finds the package document, detects DRM, collects obfuscated fonts. */
  async inspect() {
    // DRM schemes that leave tell-tale files behind.
    if (this.has('META-INF/rights.xml')) {
      throw new EpubError('drm', drmMessage('Adobe DRM (ADEPT)'));
    }
    if (this.has('META-INF/license.lcpl')) {
      throw new EpubError('drm', drmMessage('Readium LCP'));
    }
    if (this.has('META-INF/sinf.xml')) {
      throw new EpubError('drm', drmMessage('Apple FairPlay'));
    }

    // Package document (OPF) location.
    if (this.has('META-INF/container.xml')) {
      const container = await this.readText('META-INF/container.xml');
      const rootfiles = container.match(/<(?:\w+:)?rootfile\b[^>]*>/gi) || [];
      for (const tag of rootfiles) {
        const fullPath = attr(tag, 'full-path');
        const mediaType = attr(tag, 'media-type');
        if (fullPath && (!mediaType || /oebps-package/i.test(mediaType)) && this.resolveName(fullPath)) {
          this.opfPath = this.resolveName(fullPath);
          break;
        }
      }
    }
    if (!this.opfPath) {
      // Lenient fallback for books with a broken container.xml.
      this.opfPath = [...this.entries.keys()].find((n) => /\.opf$/i.test(n)) || null;
    }
    if (!this.opfPath) {
      throw new EpubError(
        'not-epub',
        'This file is a zip archive but not an EPUB book: it has no package document (content.opf).',
      );
    }

    const opf = await this.readText(this.opfPath);
    if (!/<(?:\w+:)?itemref\b/i.test(opf)) {
      throw new EpubError('empty-book', 'This EPUB contains no readable content (its reading order is empty).');
    }

    // Unique identifier, needed to undo font obfuscation.
    const pkgTag = (/<(?:\w+:)?package\b[^>]*>/i.exec(opf) || [''])[0];
    const uidRef = attr(pkgTag, 'unique-identifier');
    const idTags = [...opf.matchAll(/<dc:identifier\b([^>]*)>([\s\S]*?)<\/dc:identifier>/gi)];
    const match = idTags.find((m) => uidRef && attr(`<x ${m[1]}>`, 'id') === uidRef) || idTags[0];
    this.uniqueIdentifier = match ? decodeXmlText(match[2]).trim() : '';

    if (this.has('META-INF/encryption.xml')) {
      const enc = await this.readText('META-INF/encryption.xml');
      const blocks = enc.match(/<(?:\w+:)?EncryptedData\b[\s\S]*?<\/(?:\w+:)?EncryptedData>/gi) || [];
      for (const block of blocks) {
        const algoTag = (/<(?:\w+:)?EncryptionMethod\b[^>]*>/i.exec(block) || [''])[0];
        const refTag = (/<(?:\w+:)?CipherReference\b[^>]*>/i.exec(block) || [''])[0];
        const algorithm = attr(algoTag, 'Algorithm') || '';
        const uri = attr(refTag, 'URI') || '';
        const target = this.resolveName(safeDecode(uri)) || this.resolveName(uri);
        if (algorithm === IDPF_FONT_ALGO || algorithm === ADOBE_FONT_ALGO) {
          if (target) this.obfuscatedFonts.set(target, algorithm);
        } else if (target || uri) {
          throw new EpubError('drm', drmMessage('encryption'));
        }
      }
    }
  }

  has(name) {
    return Boolean(this.resolveName(name));
  }

  /** Exact match first, then case-insensitive (many real books get case wrong). */
  resolveName(name) {
    if (!name) return null;
    const clean = String(name).replace(/^\/+/, '');
    if (this.entries.has(clean)) return clean;
    return this.lowerCaseIndex.get(clean.toLowerCase()) || null;
  }

  async readText(name) {
    return (await this.read(name)).toString('utf8').replace(/^﻿/, '');
  }

  /** @returns {Promise<Buffer>} entry contents, with font obfuscation removed */
  async read(name) {
    const resolved = this.resolveName(name);
    if (!resolved) throw new EpubError('read-failed', `Missing file in book: ${name}`);
    const entry = this.entries.get(resolved);
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) {
      throw new EpubError('read-failed', `File too large to read: ${name}`);
    }
    const data = await new Promise((resolve, reject) => {
      this.zip.openReadStream(entry, (err, stream) => {
        if (err) return reject(err);
        const chunks = [];
        stream.on('data', (c) => chunks.push(c));
        stream.on('error', reject);
        stream.on('end', () => resolve(Buffer.concat(chunks)));
      });
    });
    const algorithm = this.obfuscatedFonts.get(resolved);
    return algorithm ? deobfuscateFont(data, algorithm, this.uniqueIdentifier) : data;
  }

  close() {
    try {
      this.zip.close();
    } catch {
      /* already closed */
    }
  }
}

function drmMessage(kind) {
  return (
    `This book is protected by ${kind === 'encryption' ? 'DRM (its contents are encrypted)' : kind}. ` +
    'Wolfreader can only open DRM-free EPUB files. If you bought this book, open it in the ' +
    'reading app of the store you bought it from.'
  );
}

function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Undoes IDPF (EPUB 3) or Adobe font obfuscation. */
function deobfuscateFont(data, algorithm, uniqueIdentifier) {
  const out = Buffer.from(data);
  let key;
  let length;
  if (algorithm === IDPF_FONT_ALGO) {
    const id = uniqueIdentifier.replace(/[ \u0009\u000d\u000a]/g, '');
    key = crypto.createHash('sha1').update(id, 'utf8').digest();
    length = 1040;
  } else {
    const hex = uniqueIdentifier.replace(/^urn:uuid:/i, '').replace(/[^0-9a-f]/gi, '');
    if (hex.length < 32) return out;
    key = Buffer.from(hex.slice(0, 32), 'hex');
    length = 1024;
  }
  for (let i = 0; i < Math.min(length, out.length); i++) out[i] ^= key[i % key.length];
  return out;
}

module.exports = { EpubArchive, EpubError, deobfuscateFont, resolveZipPath, posixDirname, IDPF_FONT_ALGO, ADOBE_FONT_ALGO };
