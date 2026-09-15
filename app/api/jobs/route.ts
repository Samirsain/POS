import { NextResponse } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { db } from "@/lib/supabase";
import {
  DEFAULT_HEADER_SIZE,
  DEFAULT_TEMPLATE_ID,
  TEMPLATES,
  formatDate,
  layout,
  resolveTemplate,
  type HeaderSize,
} from "@/lib/receipt";
import { encode } from "@/lib/escpos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent jobs with their receipts — the Print Queue polls this. */
export async function GET() {
  const { data, error } = await db()
    .from("print_jobs")
    .select("id, receipt_id, status, attempts, is_reprint, error, created_at, updated_at, receipts(receipt_no, data, amount_paise)")
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ jobs: data });
}

const actionSchema = z.object({
  jobId: z.string().uuid(),
  action: z.enum(["retry", "cancel"]),
});

/**
 * retry  — re-queues a FAILED job under its existing payload and a NEW
 *          idempotency key. Allowed only from FAILED, so retrying a SUCCESS
 *          can never produce a second physical receipt (rule 6).
 * cancel — drops a job that has not been claimed yet.
 */
export async function POST(request: Request) {
  const parsed = actionSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const { jobId, action } = parsed.data;
  const supabase = db();

  const { data: job, error } = await supabase
    .from("print_jobs")
    .select("id, status, receipt_id, payload")
    .eq("id", jobId)
    .single();
  if (error || !job) return NextResponse.json({ error: "Job not found" }, { status: 404 });

  if (action === "cancel") {
    if (job.status !== "PENDING") {
      return NextResponse.json(
        { error: `Only a PENDING job can be cancelled — this one is ${job.status}` },
        { status: 409 },
      );
    }
    await supabase.from("print_jobs").update({ status: "CANCELLED", updated_at: new Date().toISOString() }).eq("id", jobId);
    return NextResponse.json({ ok: true });
  }

  if (job.status !== "FAILED") {
    return NextResponse.json(
      {
        error:
          job.status === "SUCCESS"
            ? "That receipt already printed. Use Reprint if you need another copy."
            : `Only a FAILED job can be retried — this one is ${job.status}`,
      },
      { status: 409 },
    );
  }

  const { data: retry, error: retryError } = await supabase
    .from("print_jobs")
    .insert({
      receipt_id: job.receipt_id,
      idempotency_key: randomUUID(),
      payload: job.payload,
      is_reprint: false,
    })
    .select("id")
    .single();

  if (retryError) return NextResponse.json({ error: retryError.message }, { status: 500 });
  return NextResponse.json({ jobId: retry.id });
}

const reprintSchema = z.object({ receiptId: z.string().uuid() });

/**
 * Reprint an existing receipt. A new job with a new key, flagged so the queue
 * shows it as a reprint rather than a mystery duplicate. The payload is rebuilt
 * from stored data, so a template fix reaches reprints too.
 */
export async function PUT(request: Request) {
  const parsed = reprintSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Bad request" }, { status: 400 });
  const supabase = db();

  const { data: receipt, error } = await supabase
    .from("receipts")
    .select("id, receipt_no, data")
    .eq("id", parsed.data.receiptId)
    .single();
  if (error || !receipt) return NextResponse.json({ error: "Receipt not found" }, { status: 404 });

  const data = receipt.data as Record<string, string | number>;
  // Reprint the heading the receipt was originally issued with. Receipts saved
  // before templates existed fall back to the default.
  const template = TEMPLATES[String(data.templateId)] ?? TEMPLATES[DEFAULT_TEMPLATE_ID];
  const size = (data.headerSize as HeaderSize) ?? DEFAULT_HEADER_SIZE;
  const payload = encode(
    layout(
      resolveTemplate(template, size),
      { ...data, receiptNo: receipt.receipt_no, date: formatDate(String(data.date)) },
      "print",
    ),
  );

  const { data: job, error: jobError } = await supabase
    .from("print_jobs")
    .insert({
      receipt_id: receipt.id,
      idempotency_key: randomUUID(),
      payload: payload.toString("base64"),
      is_reprint: true,
    })
    .select("id")
    .single();

  if (jobError) return NextResponse.json({ error: jobError.message }, { status: 500 });
  return NextResponse.json({ jobId: job.id, receiptNo: receipt.receipt_no });
}
