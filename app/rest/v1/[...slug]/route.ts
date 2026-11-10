import { NextResponse } from "next/server";
import { localDb } from "@/lib/local-db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const path = slug.join("/");

  // 1. Heartbeat from connector
  if (path === "agent_status") {
    try {
      const body = await request.json();
      localDb.updateAgentStatus({
        last_seen: body.last_seen ?? new Date().toISOString(),
        printer_connected: Boolean(body.printer_connected),
        port: body.port ?? null,
        note: body.note ?? null,
      });
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 400 });
    }
  }

  // 2. Claim job RPC
  if (path === "rpc/claim_print_job") {
    const job = localDb.claimPrintJob();
    if (!job) {
      // Supabase RPC returns null or empty when no jobs are pending
      return NextResponse.json(null);
    }
    return NextResponse.json({
      id: job.id,
      receipt_id: job.receipt_id,
      payload: job.payload,
      attempts: job.attempts,
      target: job.target,
    });
  }

  return NextResponse.json({ error: `Not found: /rest/v1/${path}` }, { status: 404 });
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ slug: string[] }> }
) {
  const { slug } = await params;
  const path = slug.join("/");
  const url = new URL(request.url);

  // 3. Finish job (SUCCESS or FAILED)
  if (path === "print_jobs") {
    // URL query format: ?id=eq.<id>
    const idParam = url.searchParams.get("id");
    const match = idParam?.match(/^eq\.(.+)$/);
    const id = match ? match[1] : idParam;

    if (!id) {
      return NextResponse.json({ error: "Missing job ID" }, { status: 400 });
    }

    try {
      const body = await request.json();
      const status = body.status ?? "SUCCESS";
      const error = body.error ?? null;
      localDb.finishPrintJob(id, status, error);
      return NextResponse.json({ success: true });
    } catch (e) {
      return NextResponse.json({ error: String(e) }, { status: 400 });
    }
  }

  return NextResponse.json({ error: `Not found: /rest/v1/${path}` }, { status: 404 });
}

