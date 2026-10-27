'use strict';
// Tiny JSON settings store in the user data folder (last paper size, printer…).
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = { paper: null, printer: '', duplex: 'simplex', color: true };
const ALLOWED = Object.keys(DEFAULTS);

function file() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function load() {
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(file(), 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}

function save(patch) {
  const next = load();
  for (const key of ALLOWED) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(next, null, 2));
  } catch {
    /* settings are a convenience; never fail because of them */
  }
  return next;
}

module.exports = { load, save };
