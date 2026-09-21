"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { blankLayout } from "@/lib/receipt";
import { isAndroid, sendToRawbt } from "../rawbt";
import { waitForJob } from "../wait-for-job";
import Preview from "../preview";

type Result = { kind: "idle" | "printing" | "done" } | { kind: "failed"; message: string };

/** Print anything: no template, no receipt number. Each line goes out as typed. */
export default function BlankPage() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const onAndroid = useSyncExternalStore(
    () => () => {},
    () => isAndroid(),
    () => false,
  );
  const lines = useMemo(() => blankLayout(text, "preview"), [text]);

  async function print(route: "agent" | "rawbt") {
    setBusy(true);
    setResult({ kind: "idle" });
    try {
      const res = await fetch("/api/blank", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          text,
          target: route === "agent" ? "agent" : "device",
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = await res.json();
      if (!res.ok) return setResult({ kind: "failed", message: body.error ?? "Could not print" });
      if (route === "rawbt") {
        setResult({ kind: "done" });
        sendToRawbt(body.payload);
        return;
      }
      setResult({ kind: "printing" });
      const outcome = await waitForJob(body.jobId);
      setResult(
        outcome.status === "SUCCESS"
          ? { kind: "done" }
          : { kind: "failed", message: outcome.error ?? "The printer did not confirm." },
      );
    } catch (e) {
      setResult({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  const empty = !text.trim();

  return (
    <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-[minmax(0,1fr)_auto]">
      <section className="grid content-start gap-4">
        <h1 className="text-lg font-semibold">Blank Page</h1>
        <textarea
          className="min-h-64 rounded border border-neutral-300 bg-white px-3 py-2 font-mono text-base outline-none focus:border-neutral-900"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Type anything. Each line prints as it is."
          autoFocus
        />
        {onAndroid && (
          <button
            className="rounded bg-neutral-900 px-4 py-3 text-base font-semibold text-white disabled:bg-neutral-300"
            disabled={busy || empty}
            onClick={() => print("rawbt")}
          >
            {busy ? "Printing…" : "Print on this phone"}
          </button>
        )}
        <button
          className={`rounded px-4 py-3 text-base font-semibold disabled:opacity-40 ${
            onAndroid ? "border border-neutral-400 bg-white text-neutral-900" : "bg-neutral-900 text-white"
          }`}
          disabled={busy || empty}
          onClick={() => print("agent")}
        >
          {busy ? "Printing…" : onAndroid ? "Send to the printer PC" : "Print"}
        </button>
        {result.kind === "done" && <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-900">Printed.</p>}
        {result.kind === "printing" && (
          <p className="rounded bg-neutral-200 px-3 py-2 text-sm">Queued, waiting for the printer…</p>
        )}
        {result.kind === "failed" && (
          <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-900">{result.message}</p>
        )}
      </section>
      <section>
        <h2 className="mb-4 text-sm font-medium text-neutral-600">Preview — 58mm</h2>
        <Preview lines={lines} />
      </section>
    </div>
  );
}
