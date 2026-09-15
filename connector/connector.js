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
  "# The printer is found by its Bluetooth MAC, which survives Windows",
  "# renumbering the COM port. Set PRINTER_PORT only to force a specific port.",
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
    return;
  }

  const cfg = loadConfig();
  const MAC = (cfg.PRINTER_MAC || "DC:0D:30:59:51:A9").replace(/[^0-9a-f]/gi, "").toUpperCase();
  const FORCED = (cfg.PRINTER_PORT || "").split(",").map((s) => s.trim()).filter(Boolean);
  const POLL_MS = Number(cfg.POLL_MS || 1500);
  const HEARTBEAT_MS = 5000;

  // Cached so the PowerShell lookup does not run on every heartbeat. Cleared
  // whenever a write fails, which is exactly when the port may have moved.
  let cachedPort = FORCED[0] || null;
  const findPort = () => {
    if (cachedPort) return cachedPort;
    cachedPort = discoverPort(MAC)[0] || null;
    return cachedPort;
  };

  if (args.includes("--test")) {
    const port = findPort();
    if (!port) {
      console.error(`Printer ${MAC} not found. Pair it over Bluetooth, or set PRINTER_PORT.`);
      process.exit(1);
    }
    const ESC = 0x1b;
    await writeToPort(
      port,
      Buffer.concat([
        Buffer.from([ESC, 0x40]),
        Buffer.from([ESC, 0x61, 0x01]),
        Buffer.from("POS Printer Connector\ntest print OK\n", "ascii"),
        Buffer.from([ESC, 0x61, 0x00]),
        Buffer.from([ESC, 0x64, 0x04]),
      ]),
    );
    console.log(`Test slip sent to ${port}.`);
    return;
  }

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) {
    console.error(`SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in:\n  ${ENV_FILE}`);
    process.exit(1);
  }
  const api = makeApi(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY);

  let lastError = null;

  async function heartbeat() {
    const port = findPort();
    await api.heartbeat({
      id: "only",
      last_seen: new Date().toISOString(),
      printer_connected: Boolean(port),
      port,
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
      const port = findPort();
      if (!port) throw new Error(`printer ${MAC} is not paired or is out of range`);
      const started = Date.now();
      await writeToPort(port, bytes);
      lastError = null;
      await api.finishJob(job.id, "SUCCESS", null);
      log(`job ${short} printed via ${port} in ${Date.now() - started}ms`);
    } catch (e) {
      const message = String(e && e.message ? e.message : e);
      lastError = message;
      cachedPort = FORCED[0] || null; // the port may have moved; look again
      // Stays FAILED, never silently retried: a receipt that may have half
      // printed is a human decision, not an automatic second attempt.
      await api.finishJob(job.id, "FAILED", message).catch(() => {});
      log(`job ${short} FAILED - ${message}`);
    }
    return true;
  }

  log(`connector starting, printer ${MAC}, polling every ${POLL_MS}ms`);
  log(`printer port: ${findPort() || "NOT FOUND - pair the printer or set PRINTER_PORT"}`);
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
