import { NextResponse } from "next/server";
import { db } from "@/lib/supabase";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An agent quieter than this is treated as offline. It heartbeats every 5s. */
const OFFLINE_AFTER_MS = 20_000;

/**
 * Agent and printer status, plus the receipt number the next print will get.
 *
 * Every value here originates from the agent's own heartbeat (rule 4). If the
 * agent has not written recently we report offline — we never infer that the
 * printer is fine because the website is.
 */
export async function GET() {
  const supabase = db();

  const [{ data: status }, { data: lastReceipt }, { count: pending }] = await Promise.all([
    supabase.from("agent_status").select("last_seen, printer_connected, port, note").maybeSingle(),
    supabase.from("receipts").select("receipt_no").order("created_at", { ascending: false }).limit(1).maybeSingle(),
    supabase.from("print_jobs").select("id", { count: "exact", head: true }).eq("status", "PENDING"),
  ]);

  const lastSeen = status?.last_seen ? new Date(status.last_seen) : null;
  const agentOnline = lastSeen !== null && Date.now() - lastSeen.getTime() < OFFLINE_AFTER_MS;

  // A stale heartbeat tells us nothing about the printer, so it is not connected
  // as far as anyone here knows.
  const printerConnected = agentOnline && (status?.printer_connected ?? false);

  const lastNo = Number(lastReceipt?.receipt_no ?? 0);
  return NextResponse.json({
    agentOnline,
    printerConnected,
    port: agentOnline ? (status?.port ?? null) : null,
    note: agentOnline ? (status?.note ?? null) : (status?.note ?? null),
    lastSeen: status?.last_seen ?? null,
    pendingJobs: pending ?? 0,
    // Preview-only. The real number is allocated by the DB sequence at insert.
    nextReceiptNo: String(Number.isFinite(lastNo) ? lastNo + 1 : 1).padStart(6, "0"),
  });
}
