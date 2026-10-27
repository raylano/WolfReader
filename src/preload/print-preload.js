'use strict';
// Bridge for the hidden print layout window (src/renderer/print-layout.js).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wolfPrint', {
  onBuild: (cb) => ipcRenderer.on('layout:build', (_e, job) => cb(job)),
  onPaper: (cb) => ipcRenderer.on('layout:paper', (_e, paper) => cb(paper)),
  progress: (done, total, phase) => ipcRenderer.send('layout:progress', { done, total, phase }),
  ready: (info) => ipcRenderer.send('layout:ready', info),
  fail: (message) => ipcRenderer.send('layout:error', message),
});
