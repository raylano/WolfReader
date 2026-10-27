'use strict';
/*
 * Second way to print on Windows, independent of Chromium's print pipeline.
 *
 * Some printer drivers (seen with an Epson ET-2870) abort the silent jobs Chromium sends: the job
 * appears in the print queue and is removed again. This path renders the selected pages to PNG
 * images in the app (pdf.js) and prints them with the plain Windows GDI route — the one Word and
 * Notepad use — through a small PowerShell script and System.Drawing.Printing.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { log } = require('./print-log');

const jobs = new Map(); // jobId -> directory with page-0001.png, ...

// Page images are drawn full-bleed on the paper; the book layout already contains the margins.
const SCRIPT = `
param(
  [string]$Printer = '',
  [string]$Dir,
  [int]$Copies = 1,
  [string]$Duplex = 'simplex',
  [int]$Color = 1,
  [string]$Paper = 'A4'
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$script:files = @(Get-ChildItem -LiteralPath $Dir -Filter 'page-*.png' | Sort-Object Name)
if ($script:files.Count -eq 0) { throw 'There are no pages to print.' }
$doc = New-Object System.Drawing.Printing.PrintDocument
if ($Printer -ne '') { $doc.PrinterSettings.PrinterName = $Printer }
if (-not $doc.PrinterSettings.IsValid) { throw "Printer '$Printer' was not found." }
$doc.DocumentName = 'Wolfreader'
$doc.PrinterSettings.Copies = [int16]$Copies
$doc.PrinterSettings.Collate = $true
$doc.OriginAtMargins = $false
$doc.DefaultPageSettings.Margins = New-Object System.Drawing.Printing.Margins(0, 0, 0, 0)
try { $doc.DefaultPageSettings.Color = ($Color -ne 0) } catch { }
if ($Duplex -ne 'simplex' -and $doc.PrinterSettings.CanDuplex) {
  if ($Duplex -eq 'shortEdge') { $doc.PrinterSettings.Duplex = [System.Drawing.Printing.Duplex]::Horizontal }
  else { $doc.PrinterSettings.Duplex = [System.Drawing.Printing.Duplex]::Vertical }
}
$kind = if ($Paper -eq 'Letter') { [System.Drawing.Printing.PaperKind]::Letter } else { [System.Drawing.Printing.PaperKind]::A4 }
foreach ($size in $doc.PrinterSettings.PaperSizes) {
  if ($size.Kind -eq $kind) { $doc.DefaultPageSettings.PaperSize = $size; break }
}
$script:index = 0
$doc.add_PrintPage({
  param($sender, $e)
  $image = [System.Drawing.Image]::FromFile($script:files[$script:index].FullName)
  try {
    $g = $e.Graphics
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.TranslateTransform(-1 * $e.PageSettings.HardMarginX, -1 * $e.PageSettings.HardMarginY)
    $g.DrawImage($image, 0, 0, $e.PageBounds.Width, $e.PageBounds.Height)
  } finally { $image.Dispose() }
  $script:index++
  $e.HasMorePages = ($script:index -lt $script:files.Count)
})
$doc.Print()
`;

function begin() {
  const id = crypto.randomBytes(8).toString('hex');
  const dir = path.join(os.tmpdir(), 'Wolfreader', 'print-' + id);
  fs.mkdirSync(dir, { recursive: true });
  jobs.set(id, dir);
  return id;
}

function dirFor(id) {
  const dir = jobs.get(id);
  if (!dir) throw new Error('This print job is no longer available.');
  return dir;
}

function addPage(id, index, bytes) {
  const name = `page-${String(index).padStart(5, '0')}.png`;
  fs.writeFileSync(path.join(dirFor(id), name), Buffer.from(bytes));
}

function end(id) {
  const dir = jobs.get(id);
  jobs.delete(id);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

function run(id, { deviceName, copies, duplex, color, paper }) {
  const dir = dirFor(id);
  const script = path.join(dir, 'print.ps1');
  // BOM so Windows PowerShell reads non-ASCII printer names correctly
  fs.writeFileSync(script, '﻿' + SCRIPT, 'utf8');
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    ...(deviceName ? ['-Printer', deviceName] : []),
    '-Dir',
    dir,
    '-Copies',
    String(Math.max(1, Math.min(99, Number(copies) || 1))),
    '-Duplex',
    ['simplex', 'longEdge', 'shortEdge'].includes(duplex) ? duplex : 'simplex',
    '-Color',
    color ? '1' : '0',
    '-Paper',
    paper === 'Letter' ? 'Letter' : 'A4',
  ];
  return new Promise((resolve) => {
    execFile('powershell.exe', args, { windowsHide: true, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      const detail = String(stderr || stdout || (err && err.message) || '').trim().split(/\r?\n/)[0];
      if (err) {
        log(`GDI print failed for "${deviceName || 'default'}": ${detail}`);
        resolve({ success: false, reason: detail || 'unknown error' });
      } else {
        log(`GDI print ok for "${deviceName || 'default'}"`);
        resolve({ success: true });
      }
    });
  });
}

module.exports = { begin, addPage, end, run };
