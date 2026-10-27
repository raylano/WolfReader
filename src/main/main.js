'use strict';
const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EpubArchive, EpubError } = require('./epub-archive');
const { PrintEngine } = require('./print-engine');
const { log: printLog, logPath: printLogPath } = require('./print-log');
const { ORIGIN, registerPrivileges, handleProtocol } = require('./protocol');
const settings = require('./settings');

const APP_NAME = 'Wolfreader';
app.setName(APP_NAME);
// Lets automated tests run with a throwaway profile (settings, single-instance lock).
if (process.env.WOLFREADER_USER_DATA) app.setPath('userData', process.env.WOLFREADER_USER_DATA);
if (process.platform === 'win32') app.setAppUserModelId('app.wolfreader.desktop');

registerPrivileges();

/** @type {Map<string, {archive: EpubArchive, engine: PrintEngine|null, filePath: string}>} */
const books = new Map();
let mainWindow = null;
let pendingFile = findEpubArg(process.argv);

function findEpubArg(argv) {
  return argv.slice(1).find((a) => /\.epub$/i.test(a) && !a.startsWith('-') && fs.existsSync(a)) || null;
}

function sendToUi(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/* ---------------- single instance + file association ---------------- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const file = findEpubArg(argv);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      if (file) sendToUi('app:open-file', file);
    }
  });
  app.on('open-file', (event, file) => {
    event.preventDefault();
    if (mainWindow) sendToUi('app:open-file', file);
    else pendingFile = file;
  });
  app.whenReady().then(start);
}

/* ---------------- windows ---------------- */

function createMainWindow() {
  mainWindow = new BrowserWindow({
    title: APP_NAME,
    width: 1280,
    height: 860,
    minWidth: 860,
    minHeight: 580,
    show: false,
    backgroundColor: '#24160f',
    autoHideMenuBar: true,
    icon: process.platform === 'win32' ? undefined : path.join(__dirname, '..', 'renderer', 'img', 'logo-badge.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
    // The hidden print-layout windows would otherwise keep the process alive after the last
    // visible window is gone (window-all-closed never fires), blocking the uninstaller.
    closeAllBooks();
    app.quit();
  });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    if (details.reason === 'clean-exit') return;
    dialog.showMessageBox({
      type: 'error',
      title: APP_NAME,
      message: 'Wolfreader ran into a problem and had to reload.',
      detail: 'If this keeps happening with one particular book, the file may be damaged.',
    });
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
  });
  mainWindow.loadURL(`${ORIGIN}/index.html`);
}

function buildMenu() {
  const send = (cmd) => () => sendToUi('menu', cmd);
  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'Open EPUB…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: send('print') },
        { type: 'separator' },
        { label: 'Close Book', accelerator: 'CmdOrCtrl+W', click: send('close') },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&View',
      submenu: [
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'resetZoom' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }]),
      ],
    },
    {
      label: '&Help',
      submenu: [{ label: 'About Wolfreader', click: send('about') }],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function hardenWebContents() {
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  app.on('web-contents-created', (_e, contents) => {
    contents.setWindowOpenHandler(({ url }) => {
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('will-navigate', (event, url) => {
      if (url !== contents.getURL()) event.preventDefault();
    });
    contents.on('will-frame-navigate', (event) => {
      if (/^https?:\/\//i.test(event.url)) {
        event.preventDefault();
        shell.openExternal(event.url);
      }
    });
    contents.on('will-attach-webview', (event) => event.preventDefault());
  });
}

/* ---------------- books ---------------- */

function closeBook(bookId) {
  const book = books.get(bookId);
  if (!book) return;
  if (book.engine) book.engine.destroy();
  book.archive.close();
  books.delete(bookId);
}

function closeAllBooks() {
  for (const id of [...books.keys()]) closeBook(id);
}

function getEngine(bookId) {
  const book = books.get(bookId);
  if (!book || !book.engine) throw new Error('This book is no longer open.');
  return book.engine;
}

function errorResult(err) {
  if (err && err.cancelled) return { ok: false, cancelled: true };
  return { ok: false, message: (err && err.message) || String(err) };
}

function registerIpc() {
  ipcMain.handle('app:info', () => ({
    name: APP_NAME,
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
  }));

  ipcMain.handle('app:take-pending-file', () => {
    const file = pendingFile;
    pendingFile = null;
    return file;
  });

  ipcMain.handle('app:open-external', (_e, url) => {
    if (typeof url === 'string' && /^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('settings:get', () => settings.load());
  ipcMain.handle('settings:set', (_e, patch) => settings.save(patch));

  ipcMain.handle('book:pick', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: 'Open an EPUB book',
      properties: ['openFile'],
      filters: [
        { name: 'EPUB books', extensions: ['epub'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    return result.canceled || !result.filePaths.length ? null : result.filePaths[0];
  });

  ipcMain.handle('book:open', async (_e, filePath) => {
    try {
      if (typeof filePath !== 'string' || !filePath) throw new EpubError('not-found', 'No file was chosen.');
      const archive = await EpubArchive.open(filePath);
      closeAllBooks(); // only once the new book is known to be good
      const bookId = crypto.randomBytes(8).toString('hex');
      books.set(bookId, { archive, engine: null, filePath });
      const baseUrl = `${ORIGIN}/book/${bookId}/`;
      return {
        ok: true,
        bookId,
        baseUrl,
        opfUrl: baseUrl + archive.opfPath.split('/').map(encodeURIComponent).join('/'),
        fileName: path.basename(filePath),
      };
    } catch (err) {
      return {
        ok: false,
        code: err.code || 'unknown',
        message:
          err instanceof EpubError
            ? err.message
            : 'This file could not be opened as an EPUB book. It may be damaged or in an unsupported format.',
      };
    }
  });

  ipcMain.handle('book:close', (_e, bookId) => closeBook(bookId));

  ipcMain.handle('layout:prepare', async (event, req) => {
    const book = books.get(req && req.bookId);
    if (!book) return { ok: false, message: 'This book is no longer open.' };
    if (book.engine) book.engine.destroy();
    book.engine = new PrintEngine({
      title: req.title,
      author: req.author,
      onProgress: (p) => {
        if (!event.sender.isDestroyed()) event.sender.send('layout:progress', { bookId: req.bookId, ...p });
      },
    });
    try {
      const pagination = await book.engine.prepare({
        sections: req.sections,
        chapters: req.chapters,
        paper: req.paper,
        language: req.language,
      });
      return { ok: true, pagination };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('layout:paper', async (_e, { bookId, paper }) => {
    try {
      return { ok: true, pagination: await getEngine(bookId).setPaper(paper) };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('layout:cancel', (_e, bookId) => {
    const book = books.get(bookId);
    if (book && book.engine) book.engine.cancel();
  });

  ipcMain.handle('layout:pdf', (_e, bookId) => {
    const engine = getEngine(bookId);
    return engine.pdfBytes ? new Uint8Array(engine.pdfBytes) : null;
  });

  ipcMain.handle('print:printers', async () => {
    try {
      const printers = await mainWindow.webContents.getPrintersAsync();
      return printers.map((p) => ({ name: p.name, displayName: p.displayName || p.name }));
    } catch {
      return [];
    }
  });

  ipcMain.handle('print:save-pdf', async (_e, { bookId, pages, fileName }) => {
    try {
      const engine = getEngine(bookId);
      const pdf = await engine.buildPdf(pages);
      const result = await dialog.showSaveDialog(mainWindow, {
        title: 'Save as PDF',
        defaultPath: path.join(app.getPath('documents'), sanitizeFileName(fileName || 'book') + '.pdf'),
        filters: [{ name: 'PDF document', extensions: ['pdf'] }],
      });
      if (result.canceled || !result.filePath) return { ok: false, cancelled: true };
      await fs.promises.writeFile(result.filePath, pdf);
      return { ok: true, path: result.filePath, bytes: pdf.length };
    } catch (err) {
      if (err && err.code === 'EACCES') return { ok: false, message: 'Wolfreader isn’t allowed to save in that folder. Choose another location.' };
      if (err && err.code === 'EBUSY') return { ok: false, message: 'That PDF is open in another program. Close it or choose another name.' };
      return errorResult(err);
    }
  });

  // Fallback for printers that refuse silent jobs: write the selection to a PDF and open it in
  // the user's PDF viewer, whose own print window talks to the printer.
  ipcMain.handle('print:open-pdf', async (_e, { bookId, pages, fileName }) => {
    try {
      const pdf = await getEngine(bookId).buildPdf(pages);
      const dir = path.join(app.getPath('temp'), 'Wolfreader');
      await fs.promises.mkdir(dir, { recursive: true });
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const f of await fs.promises.readdir(dir)) {
        const full = path.join(dir, f);
        const st = await fs.promises.stat(full).catch(() => null);
        if (st && st.mtimeMs < cutoff) await fs.promises.rm(full, { force: true });
      }
      const file = path.join(dir, `${sanitizeFileName(fileName || 'book')} ${Date.now()}.pdf`);
      await fs.promises.writeFile(file, pdf);
      const error = await shell.openPath(file);
      if (error) return { ok: false, message: `No PDF viewer could open the file (${error}). Use “Save as PDF” instead.` };
      return { ok: true, path: file };
    } catch (err) {
      return errorResult(err);
    }
  });

  ipcMain.handle('print:print', async (_e, { bookId, pages, deviceName, copies, duplex, color }) => {
    try {
      const result = await getEngine(bookId).print({ pages, deviceName, copies, duplex, color });
      if (result.success) return { ok: true };
      const reason = String(result.reason || '');
      printLog(`print failed for printer "${deviceName || 'default'}": ${reason || '(no reason given)'}`);
      // Printing is silent, so the user never gets a chance to cancel: a "cancelled" job was
      // aborted by the printer, its driver or the spooler (e.g. a virtual printer that wants a
      // save dialog, or a paper size the printer refuses).
      return {
        ok: false,
        message:
          /invalid/i.test(reason)
            ? 'The printer rejected the print settings, or is no longer available. Check that it is switched on and connected, or choose another printer.'
            : /cancel/i.test(reason)
              ? 'The printer or Windows cancelled the job after it was sent (it showed up in the print queue and was removed). Try another printer, or use “Print via PDF viewer” to print with your PDF viewer’s own print window. Details: ' + printLogPath()
              : `Printing failed${reason ? ` (${reason})` : ''}. Check the printer, or use “Print via PDF viewer” or “Save as PDF”.`,
      };
    } catch (err) {
      return errorResult(err);
    }
  });
}

function sanitizeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) || 'book';
}

/* ---------------- lifecycle ---------------- */

function start() {
  handleProtocol((id) => {
    const book = books.get(id);
    return book && book.archive;
  });
  hardenWebContents();
  registerIpc();
  buildMenu();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}

app.on('before-quit', () => closeAllBooks());

app.on('window-all-closed', () => {
  closeAllBooks();
  app.quit();
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err);
});
