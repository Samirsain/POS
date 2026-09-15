import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/supabase";
import {
  DEFAULT_HEADER_SIZE,
  DEFAULT_TEMPLATE_ID,
  HEADER_SIZES,
  TEMPLATES,
  formatDate,
  layout,
  resolveTemplate,
} from "@/lib/receipt";
import { encode, UnprintableCharacterError } from "@/lib/escpos";

export const runtime = "nodejs"; // Buffer + ESC/POS encoding

const bodySchema = z.object({
  projectCode: z.string().trim().min(1, "Project is required"),
  plotNo: z.string().trim().min(1, "Plot No. is required"),
  customerName: z.string().trim().min(1, "Name is required"),
  /** Rupees as typed by the operator. Converted to paise here and never again. */
  amount: z.coerce.number().positive("Amount must be more than zero"),
  /** Optional manual override; the DB sequence allocates when this is absent. */
  receiptNo: z.string().trim().regex(/^\d{1,8}$/).optional(),
  templateId: z.enum(Object.keys(TEMPLATES) as [string, ...string[]]).default(DEFAULT_TEMPLATE_ID),
  headerSize: z.enum(HEADER_SIZES).default(DEFAULT_HEADER_SIZE),
  /** Client-generated, one per Print press. Rule 6. */
  idempotencyKey: z.string().uuid(),
});

export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues.map((i) => i.message).join(", ") },
      { status: 400 },
    );
  }
  const input = parsed.data;
  const supabase = db();

  // Same key pressed twice (double-click, flaky network, browser retry) returns
  // the job that already exists. It must never create a second receipt.
  const { data: existing } = await supabase
    .from("print_jobs")
    .select("id, receipt_id, receipts(receipt_no)")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existing) {
    const receipt = existing.receipts as unknown as { receipt_no: string } | null;
    return NextResponse.json({
      jobId: existing.id,
      receiptNo: receipt?.receipt_no ?? null,
      duplicate: true,
    });
  }

  // Money is integer paise from here down (rule 7). Round once, at the boundary.
  const amountPaise = Math.round(input.amount * 100);
  // Stored with the receipt so a reprint reproduces the same paper, heading and
  // heading size included.
  const data = {
    projectCode: input.projectCode,
    plotNo: input.plotNo,
    customerName: input.customerName,
    amount: amountPaise,
    date: new Date().toISOString(),
    templateId: input.templateId,
    headerSize: input.headerSize,
  };

  const { data: receipt, error: receiptError } = await supabase
    .from("receipts")
    .insert({
      ...(input.receiptNo ? { receipt_no: input.receiptNo.padStart(4, "0") } : {}),
      data,
      amount_paise: amountPaise,
    })
    .select("id, receipt_no")
    .single();

  if (receiptError || !receipt) {
    const duplicateNo = receiptError?.code === "23505";
    return NextResponse.json(
      {
        error: duplicateNo
          ? `Receipt no. ${input.receiptNo} already exists. Leave it blank to get the next number automatically.`
          : (receiptError?.message ?? "Could not save the receipt"),
      },
      { status: duplicateNo ? 409 : 500 },
    );
  }

  let payload: Buffer;
  try {
    payload = encode(
      layout(
        resolveTemplate(TEMPLATES[input.templateId], input.headerSize),
        { ...data, receiptNo: receipt.receipt_no, date: formatDate(data.date) },
        "print",
      ),
    );
  } catch (e) {
    // The receipt row exists but nothing was queued, so no paper is at risk.
    // Reject loudly rather than printing a receipt with characters missing.
    await supabase.from("receipts").delete().eq("id", receipt.id);
    const message =
      e instanceof UnprintableCharacterError ? e.message : `Could not build the receipt: ${String(e)}`;
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const { data: job, error: jobError } = await supabase
    .from("print_jobs")
    .insert({
      receipt_id: receipt.id,
      idempotency_key: input.idempotencyKey,
      payload: payload.toString("base64"),
    })
    .select("id")
    .single();

  if (jobError || !job) {
    return NextResponse.json(
      { error: jobError?.message ?? "Could not queue the print job" },
      { status: 500 },
    );
  }

  return NextResponse.json({
    jobId: job.id,
    receiptNo: receipt.receipt_no,
    bytes: payload.length,
  });
}
