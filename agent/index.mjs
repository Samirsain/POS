/**
 * Print agent. Runs on the office PC that the thermal printer is paired to.
 *
 * It pulls work rather than listening for it: no inbound connection, no port
 * forwarding, no firewall change, and staff can print from anywhere including
 * a phone. Deliberately dumb — the server builds the ESC/POS bytes, this only
 * claims a job, writes the bytes to the port, and reports what happened. That
 * is why it almost never needs updating on a machine you cannot redeploy to.
 *
 *   node agent/index.mjs            (reads agent/.env)
 *   node agent/index.mjs --port COM4
 *   node agent/index.mjs --list     (show serial ports and exit)
 */
import { createClient } from "@supabase/supabase-js";
import { SerialPort } from "serialport";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// --- config ---------------------------------------------------------------
const envPath = fileURLToPath(new URL(".env", import.meta.url));
try {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch {
  // No .env file is fine if the variables are already in the environment.
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};

const SUPABASE_URL = process.env.SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const BAUD = Number(arg("baud", process.env.PRINTER_BAUD ?? 9600));
const POLL_MS = Number(process.env.POLL_MS ?? 1500);
const HEARTBEAT_MS = 5000;

/**
 * Windows renumbers Bluetooth COM ports after a re-pair, a dock change or
 * sometimes just a reboot, and the machine has other SPP devices whose ports
 * must never be written to. So the printer is found by its MAC, which does not
 * change, and PRINTER_PORT is only an override.
 */
const PRINTER_MAC = (process.env.PRINTER_MAC ?? "DC:0D:30:59:51:A9").replace(/[^0-9a-f]/gi, "").toUpperCase();
const PORT_OVERRIDE = (arg("port", process.env.PRINTER_PORT) ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

async function findPrinterPorts() {
  if (PORT_OVERRIDE.length) return PORT_OVERRIDE;
  const ports = await SerialPort.list().catch(() => []);
  return ports
    .filter((p) => (p.pnpId ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase().includes(PRINTER_MAC))
    .map((p) => p.path);
}

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

if (process.argv.includes("--list")) {
  const ports = await SerialPort.list();
  const mac = "DC0D305951A9";
  for (const p of ports) {
    const isPrinter = (p.pnpId ?? "").replace(/[^0-9a-f]/gi, "").toUpperCase().includes(mac);
    log(p.path, isPrinter ? "<== THE PRINTER" : "-", p.friendlyName ?? p.manufacturer ?? "");
  }
  process.exit(0);
}

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (agent/.env).");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

// --- printer --------------------------------------------------------------
/**
 * Open, write, close, per job. Holding a Bluetooth SPP port open for hours
 * survives neither a printer power-cycle nor a laptop sleep; reopening costs
 * about a second and always reflects the true current state.
 */
async function writeToPrinter(bytes) {
  const candidates = await findPrinterPorts();
  if (!candidates.length) {
    throw new Error(
      `printer ${PRINTER_MAC} is not paired or is out of range — no matching COM port`,
    );
  }
  let lastError;
  for (const path of candidates) {
    let port;
    try {
      port = await new Promise((resolve, reject) => {
        const p = new SerialPort({ path, baudRate: BAUD }, (err) => (err ? reject(err) : resolve(p)));
      });
    } catch (e) {
      lastError = e;
      continue;
    }
    try {
      await new Promise((res, rej) => port.write(bytes, (e) => (e ? rej(e) : res())));
      await new Promise((res, rej) => port.drain((e) => (e ? rej(e) : res())));
      return path;
    } finally {
      await new Promise((res) => port.close(() => res()));
    }
  }
  throw new Error(
    `could not open ${candidates.join(", ")} — ${lastError?.message ?? "no port available"}`,
  );
}

// --- heartbeat ------------------------------------------------------------
let lastPortUsed = null;
let lastNote = null;

async function heartbeat() {
  const ports = await findPrinterPorts();
  await supabase.from("agent_status").upsert({
    id: "only",
    last_seen: new Date().toISOString(),
    printer_connected: ports.length > 0,
    port: lastPortUsed ?? ports[0] ?? null,
    note: lastNote,
  });
}

// --- work loop ------------------------------------------------------------
async function runOnce() {
  const { data: job, error } = await supabase.rpc("claim_print_job");
  if (error) {
    log("claim failed:", error.message);
    return false;
  }
  // The RPC returns a null-filled row rather than nothing when the queue is empty.
  if (!job || !job.id) return false;

  log(`job ${job.id.slice(0, 8)} claimed (attempt ${job.attempts})`);
  const bytes = Buffer.from(job.payload, "base64");

  try {
    const started = Date.now();
    lastPortUsed = await writeToPrinter(bytes);
    lastNote = null;
    await supabase
      .from("print_jobs")
      .update({ status: "SUCCESS", error: null, updated_at: new Date().toISOString() })
      .eq("id", job.id);
    log(`job ${job.id.slice(0, 8)} printed — ${bytes.length} bytes via ${lastPortUsed} in ${Date.now() - started}ms`);
  } catch (e) {
    const message = String(e.message ?? e);
    lastNote = message;
    // Stays FAILED, never silently retried: a receipt that may have half
    // printed must be a human decision, not an automatic second attempt.
    await supabase
      .from("print_jobs")
      .update({ status: "FAILED", error: message, updated_at: new Date().toISOString() })
      .eq("id", job.id);
    log(`job ${job.id.slice(0, 8)} FAILED — ${message}`);
  }
  return true;
}

log(`agent starting — printer ${PRINTER_MAC} @ ${BAUD}, polling every ${POLL_MS}ms`);
log(`printer port: ${(await findPrinterPorts()).join(", ") || "NOT FOUND — pair the printer or set PRINTER_PORT"}`);
await heartbeat();
setInterval(() => heartbeat().catch((e) => log("heartbeat failed:", e.message)), HEARTBEAT_MS);

// Sequential by construction: one job at a time, next poll only after this one
// finishes. Two receipts can never interleave on the same port.
for (;;) {
  const didWork = await runOnce().catch((e) => {
    log("loop error:", e.message);
    return false;
  });
  if (!didWork) await new Promise((r) => setTimeout(r, POLL_MS));
}
