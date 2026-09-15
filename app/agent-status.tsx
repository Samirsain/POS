"use client";

import { useEffect, useState } from "react";

export type Status = {
  agentOnline: boolean;
  printerConnected: boolean;
  port: string | null;
  note: string | null;
  pendingJobs: number;
  nextReceiptNo: string;
};

/**
 * Polls /api/status. Everything shown here came from the agent's heartbeat —
 * the browser never decides that the printer is fine (rule 4).
 */
export function useStatus(intervalMs = 5000) {
  const [status, setStatus] = useState<Status | null>(null);
  const [reachable, setReachable] = useState(true);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const res = await fetch("/api/status", { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as Status;
        if (live) {
          setStatus(data);
          setReachable(true);
        }
      } catch {
        if (live) setReachable(false);
      }
    };
    void tick();
    const id = setInterval(tick, intervalMs);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [intervalMs]);

  return { status, reachable };
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-2 w-2 rounded-full ${ok ? "bg-green-600" : "bg-red-600"}`}
    />
  );
}

export default function AgentStatus() {
  const { status, reachable } = useStatus();

  if (!reachable || !status) {
    return <p className="text-sm text-neutral-500">Checking printer…</p>;
  }

  return (
    <div className="flex items-center gap-4 text-sm">
      <span className="flex items-center gap-1.5">
        <Dot ok={status.agentOnline} />
        Agent: {status.agentOnline ? "Online" : "Offline"}
      </span>
      <span className="flex items-center gap-1.5">
        <Dot ok={status.printerConnected} />
        Printer: {status.printerConnected ? `Connected${status.port ? ` (${status.port})` : ""}` : "Disconnected"}
      </span>
      {status.pendingJobs > 0 && (
        <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900">
          {status.pendingJobs} waiting
        </span>
      )}
    </div>
  );
}
