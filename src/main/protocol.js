'use strict';
/*
 * wolfreader://app/...            the app's own UI files (src/renderer)
 * wolfreader://app/book/<id>/...  files inside an opened EPUB
 *
 * Serving both from one origin keeps epub.js and the print layout window
 * simple (no CORS, no blob/data URL juggling) and lets large books stream
 * entry-by-entry straight out of the zip.
 */
const { protocol } = require('electron');
const fs = require('fs');
const path = require('path');

const SCHEME = 'wolfreader';
const ORIGIN = `${SCHEME}://app`;
const RENDERER_DIR = path.join(__dirname, '..', 'renderer');
const SHARED_DIR = path.join(__dirname, '..', 'shared');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.xhtml': 'application/xhtml+xml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.opf': 'application/oebps-package+xml; charset=utf-8',
  '.ncx': 'application/x-dtbncx+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
};

// App pages: only our own scripts may run. Book content (styles, images, fonts)
// is same-origin. Nothing is ever fetched from the network.
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self'",
  "frame-src 'self' about: blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

// Book files can never execute script, even if loaded as a document.
const BOOK_CSP = "script-src 'none'; object-src 'none'; form-action 'none'";

function registerPrivileges() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
    },
  ]);
}

const XML_LIKE = /\.(opf|ncx|xhtml|xml|html?)$/i;

/**
 * A bare "&" (e.g. "Pride & Prejudice" in a title) makes a whole XML file
 * unparseable, and is a common real-world EPUB defect. Escape any "&" that
 * doesn't start an entity reference.
 */
function repairBareAmpersands(buf) {
  if (!buf.includes(0x26)) return buf;
  const text = buf.toString('utf8');
  const fixed = text.replace(/&(?!(?:#\d+|#x[0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);)/g, '&amp;');
  return fixed === text ? buf : Buffer.from(fixed, 'utf8');
}

function mimeFor(p) {
  return MIME[path.extname(p).toLowerCase()] || 'application/octet-stream';
}

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

/** Maps a request path onto a file inside `baseDir`, refusing traversal. */
function safeJoin(baseDir, relative) {
  const full = path.normalize(path.join(baseDir, relative));
  return full === baseDir || full.startsWith(baseDir + path.sep) ? full : null;
}

/**
 * @param {(id: string) => import('./epub-archive').EpubArchive | undefined} getArchive
 */
function handleProtocol(getArchive) {
  protocol.handle(SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return notFound();
    }
    if (url.host !== 'app') return notFound();
    const segments = url.pathname.split('/').filter(Boolean).map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });

    if (segments[0] === 'book') {
      const archive = getArchive(segments[1]);
      if (!archive) return notFound();
      const entryPath = segments.slice(2).join('/');
      if (!archive.has(entryPath)) return notFound();
      try {
        let data = await archive.read(entryPath);
        if (XML_LIKE.test(entryPath)) data = repairBareAmpersands(data);
        return new Response(data, {
          headers: {
            'content-type': mimeFor(entryPath),
            'content-security-policy': BOOK_CSP,
            'cache-control': 'no-store',
          },
        });
      } catch {
        return new Response('Unreadable entry', { status: 500 });
      }
    }

    const rel = segments.join('/') || 'index.html';
    const base = segments[0] === 'shared' ? SHARED_DIR : RENDERER_DIR;
    const file = safeJoin(base, segments[0] === 'shared' ? segments.slice(1).join('/') : rel);
    if (!file) return notFound();
    try {
      const data = await fs.promises.readFile(file);
      const headers = { 'content-type': mimeFor(file) };
      if (/\.html?$/i.test(file)) headers['content-security-policy'] = APP_CSP;
      return new Response(data, { headers });
    } catch {
      return notFound();
    }
  });
}

module.exports = { SCHEME, ORIGIN, registerPrivileges, handleProtocol, repairBareAmpersands };
