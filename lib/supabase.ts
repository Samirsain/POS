import { createClient } from "@supabase/supabase-js";

/**
 * Server-only Supabase client. The service-role key bypasses RLS, so it must
 * never reach the browser (rule 5) — nothing under app/ imports this from a
 * "use client" file, and there is deliberately no browser client in this repo.
 */
export function db() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set. See .env.example.",
    );
  }
  return createClient(url, key, { auth: { persistSession: false } });
}

export type PrintJob = {
  id: string;
  receipt_id: string;
  status: "PENDING" | "PRINTING" | "SUCCESS" | "FAILED" | "CANCELLED";
  idempotency_key: string;
  attempts: number;
  is_reprint: boolean;
  error: string | null;
  created_at: string;
  updated_at: string;
};

export type Receipt = {
  id: string;
  receipt_no: string;
  data: Record<string, string | number>;
  amount_paise: number;
  created_at: string;
};
