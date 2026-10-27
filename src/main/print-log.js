'use strict';
// Tiny append-only log of print attempts, so a failing printer can be diagnosed:
// %APPDATA%\\Wolfreader\\print.log
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

function logPath(name = 'print.log') {
  return path.join(app.getPath('userData'), name);
}

function log(message, name = 'print.log') {
  console.error(`[${name}]`, message);
  try {
    const file = logPath(name);
    let size = 0;
    try {
      size = fs.statSync(file).size;
    } catch {
      /* not created yet */
    }
    if (size > 200 * 1024) fs.rmSync(file, { force: true });
    fs.appendFileSync(file, `${new Date().toISOString()}  [pid ${process.pid}]  ${message}\n`);
  } catch {
    /* logging must never break printing */
  }
}

/** Start/quit/second-instance events, to diagnose an app that won't start again: app.log */
const appLog = (message) => log(message, 'app.log');

module.exports = { log, logPath, appLog };
