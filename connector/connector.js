/**
 * POS Printer Connector.
 *
 * Runs on the office PC the thermal printer is paired to. It pulls work from
 * Supabase rather than listening, so nothing has to reach into the office
 * network: no port forwarding, no firewall change, and staff can print from a
 * phone anywhere.
 *
 * Deliberately dumb. The server builds the finished ESC/POS bytes; this only
 * claims a job, writes the bytes to the port, and reports what happened. That
 * is why it almost never needs updating on a machine nobody can redeploy to.
 *
 * Talking to Supabase is three HTTP calls, so there is no SDK here. Talking to
 * the printer needs `serialport`, and that is not negotiable:
 *
 *   fs.openSync("COM9", "w") does NOT open the serial device. It creates a
 *   FILE named COM9 in the working directory and reports success, so a receipt
 *   lands on disk while the connector says it printed. That was a real bug in
 *   an earlier version of this file; assertRealPort() below is what makes sure
 *   it can never happen quietly again.
 *
 *   node connector.js
 *   node connector.js --ports     list serial ports and exit
 *   node connector.js --test      print a test slip and exit
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { SerialPort } = require("serialport");

// --- where the exe keeps its things ---------------------------------------
// process.execPath is the exe itself once packaged, and node.exe when run from
// source; dirname of the script is the sane place in the second case.
const IS_PACKAGED = path.basename(process.execPath).toLowerCase() !== "node.exe";
const BASE = IS_PACKAGED ? path.dirname(process.execPath) : __dirname;
const ENV_FILE = path.join(BASE, "connector.env");
const LOG_FILE = path.join(BASE, "connector.log");

const CONFIG_TEMPLATE = [
  "# POS Printer Connector settings. Same Supabase project as the website.",
  "SUPABASE_URL=https://<project-ref>.supabase.co",
  "SUPABASE_SERVICE_ROLE_KEY=<service_role key from Supabase, Settings - API>",
  "",
  "# USB first: if the printer is plugged in and Windows has a driver for it,",
  "# the bytes go through that. Set PRINTER_NAME to force one queue by name",
  "# (exactly as it appears in Printers & scanners) if the guess is wrong.",
  "PRINTER_NAME=",
  "",
  "# Bluetooth, used when the cable is not in. The printer is found by its MAC,",
  "# which survives Windows renumbering the COM port. Set PRINTER_PORT only to",
  "# force a specific port.",
  "PRINTER_MAC=DC:0D:30:59:51:A9",
  "PRINTER_PORT=",
  "",
  "POLL_MS=1500",
  "",
].join("\r\n");

function loadConfig() {
  let text;
  try {
    text = fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    fs.writeFileSync(ENV_FILE, CONFIG_TEMPLATE);
    console.error(`No settings found, so a template was written to:\n  ${ENV_FILE}\n`);
    console.error("Open it, paste the two Supabase values, then start this again.");
    process.exit(1);
  }
  const cfg = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) cfg[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return cfg;
}

// --- logging ---------------------------------------------------------------
// A background process with no console needs somewhere to say what went wrong.
function log(...parts) {
  const line = `${new Date().toISOString().slice(0, 19).replace("T", " ")}  ${parts.join(" ")}`;
  console.log(line);
  try {
    fs.appendFileSync(LOG_FILE, line + "\r\n");
  } catch {
    // A missing log must never stop printing.
  }
}

// --- finding the printer ---------------------------------------------------
/**
 * Windows renumbers Bluetooth COM ports after a re-pair, a dock change or
 * sometimes just a reboot, and this machine has other SPP devices whose ports
 * must never be written to. So the port is found by MAC, which does not change.
 *
 * PowerShell rather than a native module: it is on every Windows machine, and
 * this runs once at startup and again only after a failure, not per job.
 */
function discoverPort(mac) {
  const script =
    "Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue | " +
    `Where-Object { ($_.InstanceId -replace '[^0-9A-Fa-f]','').ToUpper() -like '*${mac}*' } | ` +
    "ForEach-Object { if ($_.FriendlyName -match '\\((COM\\d+)\\)') { $Matches[1] } }";
  try {
    const out = execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { encoding: "utf8", timeout: 20000, windowsHide: true },
    );
    return out.trim().split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  } catch (e) {
    log("port lookup failed:", e.message);
    return [];
  }
}

function listAllPorts() {
  const script =
    "Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue | " +
    "ForEach-Object { \"$($_.FriendlyName)`t$($_.InstanceId)\" }";
  try {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    }).trim();
  } catch (e) {
    return `could not list ports: ${e.message}`;
  }
}


// --- finding the printer on USB --------------------------------------------
/**
 * The cable, through Windows rather than around it.
 *
 * A browser cannot have a USB thermal printer on Windows: usbprint.sys binds
 * to any printer-class device and will not release it, so WebUSB gets an
 * Access denied and the only way round is Zadig, an admin, and a per-laptop
 * driver swap. But usbprint.sys holding the device is exactly what gives
 * Windows a print queue for it - and a program on the machine is allowed to
 * push RAW bytes into that queue, which reach the port untouched by the
 * driver. So the easy USB path is here, not in the page.
 *
 * Two things must both be true before this is used, because a queue will
 * happily accept a receipt for a printer that is not plugged in and hold it
 * there forever while we report SUCCESS:
 *
 *   1. a device driven by usbprint is physically present, and
 *   2. a queue exists on a USB port that looks like this printer.
 */
function discoverUsbPrinter(forcedName) {
  const script = [
    // Win32_PnPEntity lists present devices only, so this is the cable itself.
    "$present = @(Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue |",
    "  Where-Object { $_.Service -eq 'usbprint' });",
    // No queue is reported unless the cable is in: the lines below are the
    // only output, so an empty result means "print over Bluetooth instead".
    "if ($present.Count -gt 0) {",
    "  Get-CimInstance Win32_Printer -ErrorAction SilentlyContinue |",
    "    Where-Object { $_.PortName -like 'USB*' -or $_.PortName -like 'Printer PORT*' } |",
    "    ForEach-Object { \"$($_.Name)`t$($_.PortName)`t$($_.WorkOffline)\" }",
    "}",
    // Joined with spaces, so every statement boundary carries its own
    // semicolon - PowerShell gets one line and no newlines to rely on.
  ].join(" ");

  let queues;
  try {
    queues = execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 20000,
      windowsHide: true,
    })
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split("\t"))
      .filter((parts) => parts.length === 3 && parts[0])
      .map(([name, port, offline]) => ({ name, port, offline: /true/i.test(offline) }));
  } catch (e) {
    log("usb printer lookup failed:", e.message);
    return null;
  }

  if (forcedName) {
    const forced = queues.find((q) => q.name.toLowerCase() === forcedName.toLowerCase());
    if (!forced) log(`PRINTER_NAME "${forcedName}" is not a USB printer on this PC`);
    return forced ? forced.name : null;
  }

  // A queue Windows has already given up on is not the one we want, and a
  // printer whose name says nothing about receipts is somebody's laser.
  const candidates = queues.filter((q) => !q.offline);
  const thermal = candidates.filter((q) => /pos|58|thermal|receipt/i.test(q.name));
  if (thermal.length === 1) return thermal[0].name;
  if (thermal.length === 0 && candidates.length === 1) return candidates[0].name;
  if (candidates.length > 1) {
    log(`no obvious receipt printer among ${candidates.map((q) => q.name).join(", ")} - set PRINTER_NAME`);
  }
  return null;
}

/**
 * RAW to the spooler: StartDocPrinter with datatype "RAW" hands the bytes to
 * the port without the driver rendering anything, which is what ESC/POS needs.
 * Node has no binding for winspool, so PowerShell carries the P/Invoke - the
 * same reason it already carries the COM port lookup.
 *
 * The bytes travel as a file rather than on the command line: a receipt with a
 * heading raster is several KB, and arguments are not.
 */
function writeToWindowsPrinter(name, bytes) {
  const stem = path.join(os.tmpdir(), `pos-receipt-${process.pid}-${Date.now()}`);
  const dataFile = `${stem}.bin`;
  const scriptFile = `${stem}.ps1`;
  fs.writeFileSync(dataFile, bytes);
  fs.writeFileSync(scriptFile, RAW_PRINT_SCRIPT);
  try {
    execFileSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptFile, name, dataFile],
      { encoding: "utf8", timeout: 30000, windowsHide: true },
    );
    return bytes.length;
  } catch (e) {
    // PowerShell puts the exception on stderr; the exit code alone says nothing.
    const detail = String(e.stderr || e.stdout || "").trim().split(/\r?\n/)[0];
    throw new Error(detail || e.message);
  } finally {
    fs.rmSync(dataFile, { force: true });
    fs.rmSync(scriptFile, { force: true });
  }
}

const RAW_PRINT_SCRIPT = [
  "param([Parameter(Mandatory=$true)][string]$PrinterName,",
  "      [Parameter(Mandatory=$true)][string]$DataFile)",
  "$ErrorActionPreference = 'Stop'",
  "Add-Type @\"",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class RawPrinter {",
  "  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]",
  "  public class DOCINFO {",
  "    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;",
  "    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;",
  "    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;",
  "  }",
  "  [DllImport(\"winspool.drv\", CharSet=CharSet.Unicode, SetLastError=true)]",
  "  static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);",
  "  [DllImport(\"winspool.drv\", SetLastError=true)] static extern bool ClosePrinter(IntPtr h);",
  "  [DllImport(\"winspool.drv\", CharSet=CharSet.Unicode, SetLastError=true)]",
  "  static extern bool StartDocPrinter(IntPtr h, int level, [In, MarshalAs(UnmanagedType.LPStruct)] DOCINFO di);",
  "  [DllImport(\"winspool.drv\", SetLastError=true)] static extern bool EndDocPrinter(IntPtr h);",
  "  [DllImport(\"winspool.drv\", SetLastError=true)] static extern bool StartPagePrinter(IntPtr h);",
  "  [DllImport(\"winspool.drv\", SetLastError=true)] static extern bool EndPagePrinter(IntPtr h);",
  "  [DllImport(\"winspool.drv\", SetLastError=true)]",
  "  static extern bool WritePrinter(IntPtr h, IntPtr bytes, int count, out int written);",
  "  static void Check(bool ok, string what) {",
  "    if (!ok) throw new Exception(what + \" failed: Win32 error \" + Marshal.GetLastWin32Error());",
  "  }",
  "  public static void Send(string printer, byte[] bytes) {",
  "    IntPtr h;",
  "    Check(OpenPrinter(printer, out h, IntPtr.Zero), \"OpenPrinter\");",
  "    try {",
  "      DOCINFO di = new DOCINFO();",
  "      di.pDocName = \"Receipt\";",
  "      di.pDataType = \"RAW\";",
  "      Check(StartDocPrinter(h, 1, di), \"StartDocPrinter\");",
  "      try {",
  "        Check(StartPagePrinter(h), \"StartPagePrinter\");",
  "        IntPtr buffer = Marshal.AllocCoTaskMem(bytes.Length);",
  "        try {",
  "          Marshal.Copy(bytes, 0, buffer, bytes.Length);",
  "          int written;",
  "          Check(WritePrinter(h, buffer, bytes.Length, out written), \"WritePrinter\");",
  "          if (written != bytes.Length)",
  "            throw new Exception(\"short write: \" + written + \" of \" + bytes.Length + \" bytes\");",
  "        } finally { Marshal.FreeCoTaskMem(buffer); }",
  "        EndPagePrinter(h);",
  "      } finally { EndDocPrinter(h); }",
  "    } finally { ClosePrinter(h); }",
  "  }",
  "}",
  "\"@",
  "[RawPrinter]::Send($PrinterName, [System.IO.File]::ReadAllBytes($DataFile))",
  "",
].join("\r\n");

/**
 * USB if the cable is in, Bluetooth otherwise. Both end as the same bytes on
 * the same printer; the cable is just faster and needs nothing paired.
 */
function writeToTarget(target, bytes) {
  return target.kind === "usb"
    ? writeToWindowsPrinter(target.name, bytes)
    : writeToPort(target.port, bytes);
}

function describeTarget(target) {
  if (!target) return null;
  return target.kind === "usb" ? `${target.name} (USB)` : target.port;
}

/**
 * A receipt written to a file instead of the printer, reported as printed, is
 * the worst outcome this program has. So before every job: the name must look
 * like a COM device, and there must be no file of that name in the way.
 */
function assertRealPort(port) {
  if (!/^COM\d+$/i.test(port)) {
    throw new Error(`"${port}" is not a COM port name`);
  }
  const stray = path.join(process.cwd(), port);
  if (fs.existsSync(stray) && fs.statSync(stray).isFile()) {
    throw new Error(
      `a file named ${port} exists in ${process.cwd()} and would shadow the printer - delete it`,
    );
  }
}

/**
 * Open, write, close, per job. Holding a Bluetooth SPP handle open for hours
 * survives neither a printer power-cycle nor a laptop sleep; reopening costs
 * about a second and always reflects the true current state.
 */
function writeToPort(port, bytes) {
  assertRealPort(port);
  return new Promise((resolve, reject) => {
    const sp = new SerialPort({ path: port, baudRate: 9600 }, (openError) => {
      if (openError) return reject(openError);
      sp.write(bytes, (writeError) => {
        if (writeError) return sp.close(() => reject(writeError));
        // drain, not write, is what waits for the bytes to leave the buffer.
        sp.drain((drainError) => {
          sp.close(() => (drainError ? reject(drainError) : resolve(bytes.length)));
        });
      });
    });
  });
}

// --- Supabase over plain HTTP ---------------------------------------------
function makeApi(url, key) {
  const base = url.replace(/\/+$/, "");
  const headers = {
    apikey: key,
    authorization: `Bearer ${key}`,
    "content-type": "application/json",
  };

  async function call(method, pathAndQuery, body, extraHeaders) {
    const res = await fetch(`${base}/rest/v1${pathAndQuery}`, {
      method,
      headers: { ...headers, ...extraHeaders },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`${method} ${pathAndQuery} -> ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    /** Atomic: two connectors can never claim the same job. */
    claimJob: () => call("POST", "/rpc/claim_print_job", {}),
    finishJob: (id, status, error) =>
      call("PATCH", `/print_jobs?id=eq.${id}`, {
        status,
        error: error ?? null,
        updated_at: new Date().toISOString(),
      }),
    heartbeat: (row) =>
      call("POST", "/agent_status", row, { prefer: "resolution=merge-duplicates" }),
  };
}

// --- main ------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--ports")) {
    console.log(listAllPorts());
    console.log("\nUSB printer Windows would use:", discoverUsbPrinter(null) || "none found");
    return;
  }

  const cfg = loadConfig();
  const MAC = (cfg.PRINTER_MAC || "DC:0D:30:59:51:A9").replace(/[^0-9a-f]/gi, "").toUpperCase();
  const FORCED = (cfg.PRINTER_PORT || "").split(",").map((s) => s.trim()).filter(Boolean);
  const FORCED_NAME = (cfg.PRINTER_NAME || "").trim();
  const POLL_MS = Number(cfg.POLL_MS || 1500);
  const HEARTBEAT_MS = 5000;

  // Cached so the PowerShell lookups do not run on every heartbeat. Cleared
  // whenever a write fails, which is exactly when the printer may have moved
  // from one transport to the other - somebody pulling the cable is the
  // ordinary case, not an exception.
  let cachedTarget = FORCED[0] ? { kind: "serial", port: FORCED[0] } : null;
  const findTarget = () => {
    if (cachedTarget) return cachedTarget;
    // USB first: it is faster, it needs nothing paired, and if the cable is in
    // then somebody plugged it in on purpose.
    const usb = discoverUsbPrinter(FORCED_NAME || null);
    if (usb) {
      cachedTarget = { kind: "usb", name: usb };
      return cachedTarget;
    }
    const port = discoverPort(MAC)[0] || null;
    cachedTarget = port ? { kind: "serial", port } : null;
    return cachedTarget;
  };
  const forgetTarget = () => {
    cachedTarget = FORCED[0] ? { kind: "serial", port: FORCED[0] } : null;
  };

  if (args.includes("--test")) {
    const target = findTarget();
    if (!target) {
      console.error(
        `No printer found. Plug it in over USB, or pair it over Bluetooth (${MAC}), or set PRINTER_NAME / PRINTER_PORT.`,
      );
      process.exit(1);
    }
    const ESC = 0x1b;
    await writeToTarget(
      target,
      Buffer.concat([
        Buffer.from([ESC, 0x40]),
        Buffer.from([ESC, 0x61, 0x01]),
        Buffer.from("POS Printer Connector\ntest print OK\n", "ascii"),
        Buffer.from([ESC, 0x61, 0x00]),
        Buffer.from([ESC, 0x64, 0x04]),
      ]),
    );
    console.log(`Test slip sent to ${describeTarget(target)}.`);
    return;
  }

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in:\n  ${ENV_FILE}`);
    process.exit(1);
  }
  const api = makeApi(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY);

  let lastError = null;

  async function heartbeat() {
    const target = findTarget();
    await api.heartbeat({
      id: "only",
      last_seen: new Date().toISOString(),
      printer_connected: Boolean(target),
      port: describeTarget(target),
      note: lastError,
    });
  }

  async function runOnce() {
    const claimed = await api.claimJob();
    // The function returns a null-filled row rather than nothing when idle.
    const job = Array.isArray(claimed) ? claimed[0] : claimed;
    if (!job || !job.id) return false;

    const short = String(job.id).slice(0, 8);
    const bytes = Buffer.from(job.payload, "base64");
    log(`job ${short} claimed, attempt ${job.attempts}, ${bytes.length} bytes`);

    try {
      const target = findTarget();
      if (!target) {
        throw new Error(`printer is neither plugged in over USB nor paired over Bluetooth (${MAC})`);
      }
      const started = Date.now();
      await writeToTarget(target, bytes);
      lastError = null;
      await api.finishJob(job.id, "SUCCESS", null);
      log(`job ${short} printed via ${describeTarget(target)} in ${Date.now() - started}ms`);
    } catch (e) {
      const message = String(e && e.message ? e.message : e);
      lastError = message;
      forgetTarget(); // the cable may have come out; look again next time
      // Stays FAILED, never silently retried: a receipt that may have half
      // printed is a human decision, not an automatic second attempt.
      await api.finishJob(job.id, "FAILED", message).catch(() => {});
      log(`job ${short} FAILED - ${message}`);
    }
    return true;
  }

  log(`connector starting, printer ${MAC}, polling every ${POLL_MS}ms`);
  log(`printer: ${describeTarget(findTarget()) || "NOT FOUND - plug in the USB cable or pair over Bluetooth"}`);
  log(`log file: ${LOG_FILE}`);

  await heartbeat().catch((e) => log("heartbeat failed:", e.message));
  setInterval(() => {
    heartbeat().catch((e) => log("heartbeat failed:", e.message));
  }, HEARTBEAT_MS);

  // Sequential by construction: one job at a time, next poll only after this
  // one finishes. Two receipts can never interleave on the same port.
  for (;;) {
    const didWork = await runOnce().catch((e) => {
      log("loop error:", e.message);
      return false;
    });
    if (!didWork) await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((e) => {
  log("fatal:", String(e && e.stack ? e.stack : e));
  process.exit(1);
});
