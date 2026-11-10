import { createClient } from "@supabase/supabase-js";
import { localDb } from "./local-db";

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

function createLocalClient() {
  return {
    from(table: string) {
      if (table === "agent_status") {
        return {
          select(_fields?: string) {
            return {
              async maybeSingle() {
                const status = localDb.getAgentStatus();
                return { data: status, error: null };
              },
            };
          },
        };
      }

      if (table === "receipts") {
        return {
          select(_fields?: string) {
            return {
              order(_column: string, _opts?: { ascending: boolean }) {
                return {
                  limit(_count: number) {
                    return {
                      async maybeSingle() {
                        const receipt = localDb.getLatestReceipt();
                        return { data: receipt ? { receipt_no: receipt.receipt_no } : null, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
          insert(values: { receipt_no?: string; data: Record<string, unknown>; amount_paise: number }) {
            return {
              select(_fields?: string) {
                return {
                  async single() {
                    try {
                      const receipt = localDb.insertReceipt(values);
                      return { data: { id: receipt.id, receipt_no: receipt.receipt_no }, error: null };
                    } catch (e) {
                      return { data: null, error: { message: String(e) } };
                    }
                  },
                };
              },
            };
          },
          delete() {
            return {
              eq(column: string, val: string) {
                if (column === "id") {
                  localDb.deleteReceipt(val);
                }
                return Promise.resolve({ error: null });
              },
            };
          },
        };
      }

      if (table === "print_jobs") {
        return {
          select(fields?: string, opts?: { count?: string; head?: boolean }) {
            if (opts?.count === "exact" && opts?.head) {
              return {
                eq(column: string, val: string) {
                  const count = column === "status" && val === "PENDING" ? localDb.getPendingCount() : 0;
                  return Promise.resolve({ count, data: null, error: null });
                },
              };
            }
            return {
              eq(column: string, val: string) {
                return {
                  async maybeSingle() {
                    if (column === "idempotency_key") {
                      const job = localDb.getJobByIdempotencyKey(val);
                      return { data: job, error: null };
                    }
                    if (column === "id") {
                      const job = localDb.getJobById(val);
                      return { data: job ? { status: job.status, error: job.error } : null, error: null };
                    }
                    return { data: null, error: null };
                  },
                };
              },
            };
          },
          insert(values: {
            receipt_id: string;
            idempotency_key: string;
            payload: string;
            target: string;
            status: "PENDING" | "SUCCESS";
          }) {
            return {
              select(_fields?: string) {
                return {
                  async single() {
                    const job = localDb.insertPrintJob(values);
                    return { data: { id: job.id }, error: null };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`Unsupported table: ${table}`);
    },
  };
}

export function db(): any {
  const isLocal =
    process.env.USE_LOCAL_DB === "true" ||
    !process.env.SUPABASE_URL ||
    process.env.SUPABASE_URL.includes("localhost") ||
    process.env.SUPABASE_URL.includes("127.0.0.1");

  if (isLocal) {
    return createLocalClient();
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return createLocalClient();
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
