// Phase 0 - hardware verification. Standalone: no framework, no app code.
// Prints the receipt layout as raw ESC/POS and runs the Font B character test
// (spec 1.3). Nothing in Phase 1+ gets built until this comes out of the printer.
//
//   node phase0/print-test.mjs [--port COM9] [--dry]

import { readFileSync, openSync, writeSync, fsyncSync, closeSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const DRY = process.argv.includes('--dry');
const COLS = 32;                       // Font A. Verified from self-test, not a datasheet.
const here = (f) => fileURLToPath(new URL(f, import.meta.url));

// --- bytes ----------------------------------------------------------------
const ESC = 0x1b;
const cmd = (...b) => Buffer.from(b);

// Spec 7.2 rejects, never drops. Phase 0 only emits ASCII, so anything above
// 0x7f here is a bug in this file - the CP437 high range lands in Phase 2.
const text = (s) => {
  for (const ch of s) {
    if (ch.codePointAt(0) > 0x7f) {
      throw new Error(`non-ASCII ${JSON.stringify(ch)} in ${JSON.stringify(s)} - printer cannot represent it`);
    }
  }
  return Buffer.from(s, 'ascii');
};
const line = (s = '') => Buffer.concat([text(s), cmd(0x0a)]);

const PREAMBLE = Buffer.concat([          // spec 7.1, sent every job
  cmd(ESC, 0x40),                         // ESC @   initialise
  cmd(ESC, 0x74, 0x00),                   // ESC t 0 code page PC437
  cmd(ESC, 0x52, 0x00),                   // ESC R 0 intl charset = USA
  cmd(ESC, 0x4d, 0x00),                   // ESC M 0 Font A
  cmd(ESC, 0x61, 0x00),                   // ESC a 0 left
]);
const align = (n) => cmd(ESC, 0x61, n);
const font = (n) => cmd(ESC, 0x4d, n);
const bold = (on) => cmd(ESC, 0x45, on ? 1 : 0);
const feed = (n) => cmd(ESC, 0x64, n);

// --- the receipt ----------------------------------------------------------
// Both headings at the default size. Phase 0 prints both so the weight and
// the fit can be judged on paper before any of it reaches the app.
const asset = (name) => readFileSync(here('assets/' + name + '.bin'));
const om = asset('om-logo-m');
const ganesh = asset('ganesh-m');
const divider = '-'.repeat(COLS);

const splitRow = (left, right) => {
  const gap = COLS - left.length - right.length;
  if (gap < 1) throw new Error(`splitRow overflows ${COLS} cols: "${left}" / "${right}"`);
  return left + ' '.repeat(gap) + right;
};

// Indian grouping: last 3, then 2s. Spec 6 - paise in, Rs. out on paper.
const formatPaise = (paise) => {
  const r = String(Math.round(paise / 100));
  const head = r.slice(0, -3), tail = r.slice(-3);
  return 'Rs. ' + (head ? head.replace(/\B(?=(\d{2})+(?!\d))/g, ',') + ',' + tail : tail);
};

const fmtDate = (d) => `${String(d.getDate()).padStart(2, '0')}-` +
  ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()] +
  `-${d.getFullYear()}`;

const receipt = Buffer.concat([
  PREAMBLE,
  align(1), om, align(0),
  line(divider),
  line(splitRow('0012', fmtDate(new Date()))),
  line(divider),
  line('GREENFIELD'),
  line('A-14'),
  line('Rahul Sharma'),
  bold(true), line('Amount  ' + formatPaise(2500000)), bold(false),
  line(),
  line('Sign ___________________'),
  line(divider),
  feed(4),                                 // spec 7.3 - no GS V, clear the tear bar
]);

// Same receipt, Hindi heading, so both can be compared side by side on paper.
const ganeshReceipt = Buffer.concat([
  PREAMBLE,
  align(1), ganesh, align(0),
  line(divider),
  line(splitRow('0013', fmtDate(new Date()))),
  line(divider),
  line('GREENFIELD'),
  line('A-14'),
  line('Rahul Sharma'),
  bold(true), line('Amount  ' + formatPaise(2500000)), bold(false),
  line(),
  line('Sign ___________________'),
  line(divider),
  feed(4),
]);

// --- spec 1.3 Font B test -------------------------------------------------
// The self-test showed 0x24 as '$' in Font A but '¥' in Font B. ESC R 0 is set
// above; if B still substitutes, amounts stay in Font A and 5.2 falls back.
const fontTest = Buffer.concat([
  PREAMBLE,
  line('-- FONT TEST (ESC R 0) --'),
  font(0), line('A: $100  Rs. 100'),
  font(0), line('A: 0123456789 #@%&*'),
  font(1), line('B: $100  Rs. 100'),
  font(1), line('B: 0123456789 #@%&*'),
  font(0),
  line('A cols: ' + '.'.repeat(COLS - 8)),   // must end exactly at the edge
  font(1),
  line('B cols: ' + '.'.repeat(42 - 8)),     // 42 if Font B is really 42
  font(0),
  feed(4),
]);

// The detailed template: no bitmap at all, and a box-drawing divider. U+2500 is
// 0xC4 in CP437 — this is the one place to find out whether the printer draws it
// as a line or as something else entirely.
const boxDivider = Buffer.concat([Buffer.from(Array(COLS).fill(0xc4)), cmd(0x0a)]);

const detailed = Buffer.concat([
  PREAMBLE,
  align(1), bold(true), line('|| SHRI GANESHAY NAMAH ||'), bold(false), align(0),
  boxDivider,
  line('Receipt No. : RC-000128'),
  line('Date        : ' + fmtDate(new Date())),
  boxDivider,
  line(),
  align(1),
  line('ABC RESIDENCY'),
  line('A-102'),
  line(),
  line('RAHUL SHARMA'),
  line(),
  bold(true), line(formatPaise(2500000)), bold(false),
  line(),
  line('Twenty Five Thousand Rupees Only'),
  align(0),
  line(), line(),
  line('Signature'),
  line(),
  boxDivider,
  feed(4),
]);

const payload = Buffer.concat([receipt, ganeshReceipt, detailed, fontTest]);

// --- transport ------------------------------------------------------------
// No serialport: on Windows a Bluetooth SPP port is just a file, and staying
// dependency-free is what lets the connector ship without a Node install.

// Find the printer by its MAC, not by a COM number. This laptop has other
// Bluetooth SPP devices paired, and writing ESC/POS to one of those is worse
// than printing nothing.
const PRINTER_MAC = 'DC0D305951A9';
const findByMac = () => {
  const ps =
    'Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue | ' +
    `Where-Object { ($_.InstanceId -replace '[^0-9A-Fa-f]','').ToUpper() -like '*${PRINTER_MAC}*' } | ` +
    "ForEach-Object { if ($_.FriendlyName -match '\\((COM\\d+)\\)') { $Matches[1] } }";
  try {
    const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8', timeout: 20000, windowsHide: true,
    });
    return out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
};

const writeToPort = (port, bytes) => {
  const fd = openSync(port, 'w');
  try {
    let sent = 0;
    while (sent < bytes.length) sent += writeSync(fd, bytes, sent, bytes.length - sent);
    fsyncSync(fd);          // or a close can drop bytes the printer never saw
    return sent;
  } finally {
    closeSync(fd);
  }
};

// --- one runnable check for the only non-trivial logic here ---------------
if (process.argv.includes('--check')) {
  const { strictEqual: eq, throws } = await import('node:assert');
  eq(formatPaise(10000), 'Rs. 100');
  eq(formatPaise(2500000), 'Rs. 25,000');
  eq(formatPaise(12500000), 'Rs. 1,25,000');       // Indian grouping, not 125,000
  eq(formatPaise(100000000), 'Rs. 10,00,000');
  eq(splitRow('0012', '15-Sep-2026').length, COLS);
  throws(() => splitRow('x'.repeat(25), '15-Sep-2026'), /overflows/);
  throws(() => text('Rs ₹'), /cannot represent/);   // rupee sign must be refused
  throws(() => text('ॐ'), /cannot represent/);      // om must be a bitmap
  console.log('checks pass');
  process.exit(0);
}

const main = async () => {
  console.log(`payload ${payload.length} bytes — om ${om.length}, ganesh ${ganesh.length} = ${Math.round((om.length + ganesh.length) / payload.length * 100)}% bitmaps`);
  if (DRY) {
    console.log(payload.toString('ascii').replace(/[^\x20-\x7e\n]/g, '.'));
    return;
  }

  const candidates = arg('port') ? [arg('port')] : findByMac();
  if (!candidates.length) {
    throw new Error(
      `printer ${PRINTER_MAC} not found. Pair it over Bluetooth (PIN 1234), or pass --port COMn.`,
    );
  }

  let used, lastError;
  const t0 = Date.now();
  for (const path of candidates) {
    try { writeToPort(path, payload); used = path; break; }
    catch (e) { lastError = e; console.log(`${path}: ${e.message}`); }
  }
  if (!used) throw new Error(`could not write to ${candidates.join(', ')} - ${lastError?.message}`);
  const ms = Date.now() - t0;

  console.log(`sent ${payload.length} bytes to ${used} in ${ms}ms`);
  console.log('NOTE: that is "handed to the Bluetooth stack", not "printed".');
  console.log('Measure the paper with a ruler - each receipt should be 80mm -');
  console.log('and record what you see in docs/printer-verification.md');
};

main().catch((e) => { console.error(String(e.message ?? e)); process.exit(1); });
