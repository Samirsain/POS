import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/supabase";
import { blankLayout } from "@/lib/receipt";
import { encode, UnprintableCharacterError } from "@/lib/escpos";

export const runtime = "nodejs";

const bodySchema = z.object({
  text: z.string().max(5000, "Too much text for one print").refine((t) => t.trim(), "Type something to print"),
  /** Same meaning as /api/print: agent = the connector, device = the phone via RawBT. */
  target: z.enum(["agent", "device"]).default("agent"),
  idempotencyKey: z.string().uuid(),
});

/** Free text from /blank. No receipt row, no number: just a print job. */
export async function POST(request: Request) {
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join(", ") }, { status: 400 });
  }
  const input = parsed.data;
  const supabase = db();

  // Rule 6, as in /api/print: a second press with the same key is the same job.
  const { data: existing } = await supabase
    .from("print_jobs")
    .select("id, payload, target")
    .eq("idempotency_key", input.idempotencyKey)
    .maybeSingle();
  if (existing) {
    return NextResponse.json({
      jobId: existing.id,
      duplicate: true,
      payload: existing.target === "device" ? existing.payload : undefined,
    });
  }

  let payload: Buffer;
  try {
    payload = encode(blankLayout(input.text, "print"));
  } catch (e) {
    const message = e instanceof UnprintableCharacterError ? e.message : `Could not build the print: ${String(e)}`;
    return NextResponse.json({ error: message }, { status: 422 });
  }

  const { data: job, error } = await supabase
    .from("print_jobs")
    .insert({
      idempotency_key: input.idempotencyKey,
      payload: payload.toString("base64"),
      target: input.target,
      status: input.target === "device" ? "SUCCESS" : "PENDING",
    })
    .select("id")
    .single();
  if (error || !job) {
    return NextResponse.json({ error: error?.message ?? "Could not queue the print job" }, { status: 500 });
  }

  return NextResponse.json({
    jobId: job.id,
    payload: input.target === "device" ? payload.toString("base64") : undefined,
  });
}
