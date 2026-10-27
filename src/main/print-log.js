'use strict';
// Tiny append-only log of print attempts, so a failing printer can be diagnosed:
// %APPDATA%\\Wolfreader\\print.log
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function logPath() {
  return path.join(app.getPath('userData'), 'print.log');
}

function log(message) {
  console.error('[print]', message);
  try {
    const file = logPath();
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* not created yet */
    }
    if (size > 200 * 1024) fs.rmSync(file, { force: true });
    fs.appendFileSync(file, `${new Date().toISOString()}  ${message}\n`);
  } catch {
    /* logging must never break printing */
  }
}

module.exports = { log, logPath };
