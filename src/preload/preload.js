'use strict';
// The only bridge between the UI and the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

function listen(channel, cb) {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('wolf', {
  appInfo: () => ipcRenderer.invoke('app:info'),
  takePendingFile: () => ipcRenderer.invoke('app:take-pending-file'),
  openExternal: (url) => ipcRenderer.invoke('app:open-external', url),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),

  pickBook: () => ipcRenderer.invoke('book:pick'),
  openBook: (filePath) => ipcRenderer.invoke('book:open', filePath),
  closeBook: (bookId) => ipcRenderer.invoke('book:close', bookId),
  pathForFile: (file) => webUtils.getPathForFile(file),

  prepareLayout: (req) => ipcRenderer.invoke('layout:prepare', req),
  setPaper: (bookId, paper) => ipcRenderer.invoke('layout:paper', { bookId, paper }),
  cancelLayout: (bookId) => ipcRenderer.invoke('layout:cancel', bookId),

  listPrinters: () => ipcRenderer.invoke('print:printers'),
  savePdf: (req) => ipcRenderer.invoke('print:save-pdf', req),
  print: (req) => ipcRenderer.invoke('print:print', req),

  onMenu: (cb) => listen('menu', cb),
  onOpenFile: (cb) => listen('app:open-file', cb),
  onLayoutProgress: (cb) => listen('layout:progress', cb),
});
