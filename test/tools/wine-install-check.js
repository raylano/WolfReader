#!/usr/bin/env node
/*
 * Runs the NSIS installer silently under Wine in a throwaway prefix and checks
 * what it installed (program files, uninstaller, Start Menu/Desktop shortcuts,
 * uninstall + .epub association registry entries). This exercises the real
 * installer logic; it is NOT a substitute for installing on real Windows.
 * Usage: node test/tools/wine-install-check.js [prefixDir]
 */
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const version = require(path.join(ROOT, 'package.json')).version;
const installer = path.join(ROOT, 'release', `Wolfreader-Setup-${version}.exe`);
const prefix = path.resolve(process.argv[2] || path.join(ROOT, '.scratch', 'wineprefix'));
fs.rmSync(prefix, { recursive: true, force: true });
fs.mkdirSync(prefix, { recursive: true });
// The installer is x64-only, so it needs a 64-bit prefix (and a Wine build that supports one).
const env = { ...process.env, WINEPREFIX: prefix, WINEARCH: 'win64', WINEDEBUG: '-all', WINEDLLOVERRIDES: 'mscoree,mshtml=' };

function wine(args, timeout = 600000) {
  const r = spawnSync('wine', args, { env, encoding: 'utf8', timeout });
  return { code: r.status, out: (r.stdout || '') + (r.stderr || '') };
}

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
}

spawnSync('wineboot', ['--init'], { env, timeout: 300000 });
const arch = (/#arch=(\w+)/.exec(fs.readFileSync(path.join(prefix, 'system.reg'), 'latin1')) || [])[1];
if (arch !== 'win64') {
  console.log(`SKIP  This Wine build created a ${arch} prefix; the x64 installer needs win64 Wine (install wine64).`);
  process.exit(3);
}
const t0 = Date.now();
const run = wine([installer, '/S']);
spawnSync('wineserver', ['-w'], { env, timeout: 300000 });
check('Silent install exits cleanly', run.code === 0, `exit ${run.code} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

const user = fs.readdirSync(path.join(prefix, 'drive_c', 'users')).find((u) => u !== 'Public');
const home = path.join(prefix, 'drive_c', 'users', user);
const installDir = path.join(home, 'AppData', 'Local', 'Programs', 'Wolfreader');
const exe = path.join(installDir, 'Wolfreader.exe');
check('Wolfreader.exe installed per-user', fs.existsSync(exe), path.relative(prefix, exe));
check('app.asar installed', fs.existsSync(path.join(installDir, 'resources', 'app.asar')));
if (!fs.existsSync(installDir)) {
  console.log(`\nInstall did not produce ${installDir}:\n${run.out.slice(-2000)}`);
  process.exit(1);
}
check('Uninstaller written', fs.readdirSync(installDir).some((f) => /^Uninstall Wolfreader\.exe$/i.test(f)));

function findFile(dir, re, depth = 6) {
  if (depth < 0 || !fs.existsSync(dir)) return null;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isFile() && re.test(e.name)) return p;
    if (e.isDirectory()) {
      const hit = findFile(p, re, depth - 1);
      if (hit) return hit;
    }
  }
  return null;
}
const startMenu = findFile(path.join(home, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu'), /^Wolfreader\.lnk$/i);
check('Start Menu shortcut "Wolfreader"', Boolean(startMenu), startMenu && path.relative(prefix, startMenu));
const desktop = findFile(path.join(home), /^Wolfreader\.lnk$/i, 2) || findFile(path.join(home, 'Desktop'), /^Wolfreader\.lnk$/i, 1);
check('Desktop shortcut "Wolfreader"', Boolean(desktop), desktop && path.relative(prefix, desktop));

const userReg = fs.readFileSync(path.join(prefix, 'user.reg'), 'latin1');
const uninstallKey = /Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\[^\]]+\][^[]*"DisplayName"="Wolfreader/i.test(userReg);
check('Registered in Apps & features as "Wolfreader"', uninstallKey);
check('.epub file association registered', /\\\\\.epub\]/i.test(userReg) && /Wolfreader\.exe\\" \\"%1\\"/i.test(userReg));

// Uninstall again to prove the uninstaller works.
const un = wine([path.join(installDir, 'Uninstall Wolfreader.exe'), '/S']);
spawnSync('wineserver', ['-w'], { env, timeout: 300000 });
for (let i = 0; i < 60 && fs.existsSync(exe); i++) spawnSync('sleep', ['1']);
check('Silent uninstall removes the app', un.code === 0 && !fs.existsSync(exe), `exit ${un.code}`);

console.log(failures ? `\n${failures} check(s) failed` : '\nInstaller checks passed under Wine');
process.exit(failures ? 1 : 0);
