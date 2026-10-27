'use strict';
/*
 * Updates from GitHub Releases (electron-updater). The release workflow publishes the installer
 * plus latest.yml; the app reads latest.yml from the newest release to see if there is a newer
 * version. Nothing is downloaded without the user's OK: the UI shows a banner with
 * "Download and install", then "Restart to update". A downloaded update that wasn't installed
 * yet is installed when Wolfreader closes.
 *
 * Only active in the installed Windows app (not in development, not in tests).
 */
const { app } = require('electron');

const CHECK_DELAY_MS = 8 * 1000;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

let updater = null;
let send = () => {};
let log = () => {};
let status = { state: 'idle' };
let downloaded = false;
let manualCheck = false;

function setStatus(next) {
  status = next;
  send('update:status', status);
}

const enabled = () =>
  app.isPackaged && process.platform === 'win32' && !process.env.WOLFREADER_USER_DATA && !process.env.WOLFREADER_NO_UPDATES;

function setup(options) {
  send = options.send;
  log = options.log;
  if (!enabled()) return;
  try {
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (err) {
    log(`updater unavailable: ${err.message}`);
    return;
  }
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = true;
  updater.allowPrerelease = false;
  updater.logger = {
    info: (m) => log(`updater: ${m}`),
    warn: (m) => log(`updater warning: ${m}`),
    error: (m) => log(`updater error: ${m}`),
    debug: () => {},
  };
  updater.on('checking-for-update', () => setStatus({ state: 'checking', manual: manualCheck }));
  updater.on('update-available', (info) =>
    setStatus({ state: 'available', version: info.version, current: app.getVersion() }),
  );
  updater.on('update-not-available', () => setStatus({ state: 'latest', manual: manualCheck, current: app.getVersion() }));
  updater.on('download-progress', (p) => setStatus({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  updater.on('update-downloaded', (info) => {
    downloaded = true;
    setStatus({ state: 'downloaded', version: info.version });
  });
  updater.on('error', (err) =>
    setStatus({ state: 'error', manual: manualCheck, message: friendly(err) }),
  );

  setTimeout(() => check(false), CHECK_DELAY_MS).unref();
  setInterval(() => check(false), CHECK_INTERVAL_MS).unref();
}

function friendly(err) {
  const msg = String((err && err.message) || err || '');
  if (/net::|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|ECONNRESET|getaddrinfo/i.test(msg)) {
    return 'Couldn’t reach GitHub. Check your internet connection.';
  }
  if (/404|latest\.yml/i.test(msg)) return 'No update information was found on GitHub.';
  return 'Checking for updates didn’t work.';
}

async function check(manual) {
  if (!updater) {
    return { state: 'unsupported', current: app.getVersion() };
  }
  if (['downloading', 'downloaded'].includes(status.state)) return status;
  manualCheck = manual;
  try {
    await updater.checkForUpdates();
  } catch {
    /* reported through the 'error' event */
  }
  return status;
}

async function download() {
  if (!updater || status.state !== 'available') return status;
  setStatus({ state: 'downloading', percent: 0 });
  try {
    await updater.downloadUpdate();
  } catch {
    /* reported through the 'error' event */
  }
  return status;
}

/** Restarts into the new version (silent install, then Wolfreader starts again). */
function install() {
  if (!updater || !downloaded) return false;
  log('updater: restart to install');
  updater.quitAndInstall(true, true);
  return true;
}

/**
 * Called when the app is about to exit for good. Wolfreader exits with app.exit(), which skips
 * the 'quit' event electron-updater normally uses to install a downloaded update on quit.
 */
function installOnExit() {
  if (!updater || !downloaded || updater.quitAndInstallCalled) return;
  try {
    log('updater: installing downloaded update on exit');
    updater.install(true, false);
  } catch (err) {
    log(`updater: install on exit failed: ${err.message}`);
  }
}

module.exports = { setup, check, download, install, installOnExit, getStatus: () => status };
