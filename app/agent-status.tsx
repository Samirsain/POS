"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { isAndroid } from "./rawbt";

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

/**
 * What the device in front of you can print with.
 *
 * On a phone that prints over Bluetooth itself, a connector in another room
 * being asleep was two red dots about something that was never going to stop
 * it printing. So the connector only appears when it is actually your route —
 * which on any desktop it is — or when jobs are sitting in its queue.
 */
export default function AgentStatus() {
  const { status } = useStatus();
  // Rendered on the server with no user agent, corrected on hydration.
  const onAndroid = useSyncExternalStore(
    () => () => {},
    () => isAndroid(),
    () => false,
  );
  const local = onAndroid;
  const showOffice = status && (!local || status.pendingJobs > 0);

  return (
    <div className="flex items-center gap-4 text-sm">
      {/* No dot: whether RawBT is installed and paired is not something this
          page can check, and a green light it cannot verify would be a lie. */}
      {onAndroid && <span className="text-neutral-600">Prints on this phone</span>}

      {!local && !status && <span className="text-neutral-500">Checking printer…</span>}

      {showOffice && (
        <span className="flex items-center gap-1.5">
          <Dot ok={status.printerConnected} />
          Printer PC:{" "}
          {status.printerConnected
            ? `Connected${status.port ? ` (${status.port})` : ""}`
            : status.agentOnline
              ? "Not answering"
              : "Offline"}
        </span>
      )}

      {status && status.pendingJobs > 0 && (
        <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-900">
          {status.pendingJobs} waiting
        </span>
      )}
    </div>
  );
}
