"use client";

import { useCallback, useEffect, useState } from "react";
import { formatCurrency } from "@/lib/receipt";

type Job = {
  id: string;
  receipt_id: string;
  status: "PENDING" | "PRINTING" | "SUCCESS" | "FAILED" | "CANCELLED";
  attempts: number;
  is_reprint: boolean;
  error: string | null;
  created_at: string;
  receipts: { receipt_no: string; data: Record<string, string>; amount_paise: number } | null;
};

const BADGE: Record<Job["status"], string> = {
  PENDING: "bg-neutral-200 text-neutral-700",
  PRINTING: "bg-blue-100 text-blue-900",
  SUCCESS: "bg-green-100 text-green-900",
  FAILED: "bg-red-100 text-red-900",
  CANCELLED: "bg-neutral-200 text-neutral-500",
};

export default function Queue() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/jobs", { cache: "no-store" });
    if (res.ok) return (await res.json()).jobs as Job[];
    return null;
  }, []);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      const next = await load().catch(() => null);
      if (live && next) setJobs(next);
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [load]);

  const refresh = useCallback(async () => {
    const next = await load().catch(() => null);
    if (next) setJobs(next);
  }, [load]);

  async function act(job: Job, action: "retry" | "cancel" | "reprint") {
    setBusyId(job.id);
    setMessage(null);
    const res =
      action === "reprint"
        ? await fetch("/api/jobs", {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ receiptId: job.receipt_id }),
          })
        : await fetch("/api/jobs", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jobId: job.id, action }),
          });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) setMessage(body.error ?? "That did not work");
    setBusyId(null);
    void refresh();
  }

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-4 text-lg font-semibold">Print Queue</h1>
      {message && <p className="mb-3 rounded bg-red-50 px-3 py-2 text-sm text-red-900">{message}</p>}

      {jobs === null && <p className="text-sm text-neutral-500">Loading…</p>}
      {jobs?.length === 0 && <p className="text-sm text-neutral-500">Nothing printed yet.</p>}

      <ul className="grid gap-2">
        {jobs?.map((job) => (
          <li key={job.id} className="rounded border border-neutral-300 bg-white p-3">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`rounded px-2 py-0.5 text-xs font-semibold ${BADGE[job.status]}`}>
                {job.status}
              </span>
              <span className="font-mono text-sm">{job.receipts?.receipt_no ?? "—"}</span>
              <span className="text-sm text-neutral-700">
                {job.receipts?.data.customerName ?? ""}
                {job.receipts ? ` · ${formatCurrency(job.receipts.amount_paise, "preview")}` : ""}
              </span>
              {job.is_reprint && (
                <span className="rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-900">reprint</span>
              )}
              <span className="ml-auto text-xs text-neutral-500">
                {new Date(job.created_at).toLocaleString()}
                {job.attempts > 1 && ` · ${job.attempts} attempts`}
              </span>
            </div>

            {job.error && <p className="mt-2 text-sm text-red-800">{job.error}</p>}

            <div className="mt-2 flex gap-2">
              {job.status === "FAILED" && (
                <button
                  className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50"
                  disabled={busyId === job.id}
                  onClick={() => act(job, "retry")}
                >
                  Retry
                </button>
              )}
              {job.status === "PENDING" && (
                <button
                  className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50"
                  disabled={busyId === job.id}
                  onClick={() => act(job, "cancel")}
                >
                  Cancel
                </button>
              )}
              {job.status === "SUCCESS" && (
                // A second physical copy, on purpose and logged as one. Distinct
                // from Retry, which only ever resurrects a job that failed.
                <button
                  className="rounded border border-neutral-300 px-3 py-1 text-sm hover:bg-neutral-100 disabled:opacity-50"
                  disabled={busyId === job.id}
                  onClick={() => act(job, "reprint")}
                >
                  Reprint
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
