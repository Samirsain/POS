"use client";

import { useMemo, useState, useSyncExternalStore } from "react";
import { isAndroid, sendToRawbt } from "./rawbt";
import { hasWebUsb, printOverUsb, useUsbPrinter } from "./usb";
import {
  DEFAULT_HEADER_SIZE,
  FIELD_META,
  TEMPLATE,
  formatDate,
  layout,
  resolveTemplate,
  templateFields,
  type ReceiptData,
} from "@/lib/receipt";
import Preview from "./preview";
import { useStatus } from "./agent-status";

type Result =
  | { kind: "idle" }
  | { kind: "printing"; receiptNo: string }
  | { kind: "queued"; receiptNo: string }
  | { kind: "done"; receiptNo: string }
  | { kind: "failed"; receiptNo: string | null; message: string };

/** Fields the operator types. The rest of the template fills itself. */
const entryFields = templateFields(TEMPLATE).filter((f) => FIELD_META[f]?.input !== "auto");

export default function NewReceipt() {
  const { status } = useStatus();
  const [values, setValues] = useState<Record<string, string>>(
    Object.fromEntries(entryFields.map((f) => [f, ""])),
  );
  const [result, setResult] = useState<Result>({ kind: "idle" });
  const [busy, setBusy] = useState(false);
  // The server has no user agent to read, so it renders the desktop buttons and
  // the client corrects them on hydration. useSyncExternalStore rather than an
  // effect: this never changes after load, so there is nothing to subscribe to.
  const onAndroid = useSyncExternalStore(
    () => () => {},
    () => isAndroid(),
    () => false,
  );
  // A laptop with Chrome can drive the printer over USB itself, the same way
  // the phone drives it over Bluetooth. Not on Android: there the cable would
  // need OTG and RawBT is already the better route.
  const onUsb = useSyncExternalStore(
    () => () => {},
    () => hasWebUsb() && !isAndroid(),
    () => false,
  );
  // Picked once per browser profile; Chrome remembers the grant across reloads,
  // and reports the cable coming and going after that.
  const { device: usbPrinter, error: usbError, connect: connectUsb } = useUsbPrinter();

  const today = useMemo(() => new Date(), []);
  // The database allocates the real number; this is what it will be next, so
  // the preview shows the number that is about to be printed.
  const nextNo = status?.nextReceiptNo ?? "----";

  // One layout, not chosen at print time. The alternative headings still exist
  // in lib/receipt.ts and the API still accepts them; they are just not a
  // decision the operator has to make at the counter any more.
  const previewLines = useMemo(() => {
    const data: ReceiptData = {
      ...values,
      receiptNo: nextNo,
      date: formatDate(today),
      // Rupees typed in, paise into the layout engine — the same conversion the
      // server does, so the preview cannot drift from the paper.
      amount: Math.round((Number(values.amount) || 0) * 100),
    };
    return layout(resolveTemplate(TEMPLATE, DEFAULT_HEADER_SIZE), data, "preview");
  }, [values, nextNo, today]);

  // The button this device can print with on its own, if it has one. It also
  // decides whether the printer PC is the headline or the fallback.
  const localRoute = onAndroid ? "Print on this phone" : onUsb ? "Print on the USB printer" : null;

  const missing = entryFields.filter((f) => !values[f]?.trim());
  const canPrint = missing.length === 0 && Number(values.amount) > 0 && !busy;

  /**
   *   agent — queued for whichever PC is running the connector
   *   rawbt — this Android phone prints it over Bluetooth
   *   usb   — this laptop prints it over the cable
   * The last two are the same bargain to the server: it hands back the bytes
   * and never queues a job, so nothing can print a second copy.
   */
  async function print(route: "agent" | "rawbt" | "usb") {
    setBusy(true);
    setResult({ kind: "idle" });
    const target = route === "agent" ? "agent" : "device";
    // One key per press. A double-click reuses it and the server returns the
    // same job instead of printing twice (rule 6).
    const idempotencyKey = crypto.randomUUID();
    try {
      // Before the POST, not after: the device chooser needs the click's user
      // gesture, and awaiting a fetch spends it. It also means a cancelled
      // chooser costs no receipt number. Normally the printer is already
      // connected and this line does nothing.
      const device = route === "usb" ? (usbPrinter ?? (await connectUsb())) : null;

      const res = await fetch("/api/print", {
        method: "POST",
        headers: { "content-type": "application/json" },
        // No receiptNo: the database sequence allocates it, which is the only
        // way two people printing at once cannot collide (§9).
        body: JSON.stringify({ ...values, target, idempotencyKey }),
      });
      const body = await res.json();
      if (!res.ok) {
        setResult({ kind: "failed", receiptNo: null, message: body.error ?? "Could not queue the receipt" });
        return;
      }

      if (route === "usb") {
        // The write either lands or throws, so unlike RawBT this one knows.
        try {
          await printOverUsb(device!, body.payload);
        } catch (e) {
          // The receipt exists and the job says SUCCESS, so Retry is refused —
          // Reprint is the honest route to paper.
          setResult({
            kind: "failed",
            receiptNo: body.receiptNo,
            message: `${e instanceof Error ? e.message : String(e)} Press Reprint in the Queue once it is fixed.`,
          });
          return;
        }
        setResult({ kind: "done", receiptNo: body.receiptNo });
        setValues(Object.fromEntries(entryFields.map((f) => [f, ""])));
        return;
      }

      if (route === "rawbt") {
        // The bytes go to RawBT, which owns the Bluetooth connection. Nothing
        // reports back afterwards — the person pressing the button is standing
        // in front of the printer, so they can see it for themselves.
        setResult({ kind: "done", receiptNo: body.receiptNo });
        setValues(Object.fromEntries(entryFields.map((f) => [f, ""])));
        sendToRawbt(body.payload);
        return;
      }

      // No connector is running anywhere, so no one is going to claim this
      // job. The receipt is saved and will print when the connector is back —
      // say that now instead of spinning for 45 seconds first.
      if (status && !status.agentOnline) {
        setResult({ kind: "queued", receiptNo: body.receiptNo });
        setValues(Object.fromEntries(entryFields.map((f) => [f, ""])));
        return;
      }

      setResult({ kind: "printing", receiptNo: body.receiptNo });
      const outcome = await waitForJob(body.jobId);
      if (outcome.status === "SUCCESS") {
        setResult({ kind: "done", receiptNo: body.receiptNo });
        setValues(Object.fromEntries(entryFields.map((f) => [f, ""])));
      } else {
        setResult({
          kind: "failed",
          receiptNo: body.receiptNo,
          message: outcome.error ?? "The printer did not confirm. Check the Queue.",
        });
      }
    } catch (e) {
      // A cancelled device chooser is a change of mind, not a failure.
      if (e instanceof DOMException && e.name === "NotFoundError") return;
      // No receipt exists on this path — connecting happens before the POST —
      // so this is the printer's problem, not a lost number.
      setResult({ kind: "failed", receiptNo: null, message: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto grid max-w-5xl gap-8 md:grid-cols-[minmax(0,1fr)_auto]">
      <section>
        <h1 className="mb-4 text-lg font-semibold">New Receipt</h1>

        <div className="grid gap-4">
          {entryFields.map((field) => {
            const meta = FIELD_META[field];
            return (
              <label key={field} className="grid gap-1">
                <span className="text-sm font-medium text-neutral-700">{meta.label}</span>
                <input
                  className="rounded border border-neutral-300 bg-white px-3 py-2 text-base outline-none focus:border-neutral-900"
                  value={values[field] ?? ""}
                  placeholder={meta.placeholder}
                  inputMode={meta.input === "money" ? "decimal" : undefined}
                  autoComplete="off"
                  onChange={(e) =>
                    setValues((v) => ({
                      ...v,
                      [field]: meta.uppercase ? e.target.value.toUpperCase() : e.target.value,
                    }))
                  }
                />
              </label>
            );
          })}


          {/* Whatever the device in front of you can drive itself is the primary
              button: the phone over Bluetooth, the laptop over the cable. The
              printer PC is the fallback, and the only route on iPhone. */}
          {onAndroid && (
            <button
              className="mt-2 rounded bg-neutral-900 px-4 py-3 text-base font-semibold text-white disabled:bg-neutral-300"
              disabled={!canPrint}
              onClick={() => print("rawbt")}
            >
              {busy ? "Printing…" : "Print on this phone"}
            </button>
          )}

          {onUsb && (
            <button
              className="mt-2 rounded bg-neutral-900 px-4 py-3 text-base font-semibold text-white disabled:bg-neutral-300"
              disabled={!canPrint}
              onClick={() => print("usb")}
            >
              {busy ? "Printing…" : "Print on the USB printer"}
            </button>
          )}

          <button
            className={`rounded px-4 py-3 text-base font-semibold disabled:opacity-40 ${
              localRoute
                ? "border border-neutral-400 bg-white text-neutral-900"
                : "mt-2 bg-neutral-900 text-white disabled:bg-neutral-300"
            }`}
            disabled={!canPrint}
            onClick={() => print("agent")}
          >
            {busy ? "Printing…" : localRoute ? "Send to the printer PC" : "Print"}
          </button>

          {onAndroid && (
            <p className="text-xs text-neutral-500">
              Pair the printer once in Android Bluetooth settings. Printing needs the free RawBT
              app — the first print opens its Play Store page.
            </p>
          )}

          {/* Connect once, then Print is just Print. Pressing Print without
              connecting still opens the chooser, so this is a shortcut and a
              connected light, never a step you can be stuck behind. */}
          {onUsb &&
            (usbPrinter ? (
              <p className="flex items-center gap-1.5 text-xs text-neutral-500">
                <span aria-hidden className="inline-block h-2 w-2 rounded-full bg-green-600" />
                USB printer connected{usbPrinter.productName ? ` — ${usbPrinter.productName}` : ""}.
              </p>
            ) : (
              <>
                <button
                  className="self-start text-sm font-medium text-neutral-900 underline underline-offset-4"
                  onClick={() => void connectUsb().catch(() => {})}
                >
                  Connect the USB printer
                </button>
                {usbError ? (
                  <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">{usbError}</p>
                ) : (
                  <p className="text-xs text-neutral-500">
                    Plug the printer into this computer with the cable, then pick it once. Chrome
                    remembers it after that.
                  </p>
                )}
              </>
            ))}

          {/* Only when the printer PC is your route, or when jobs are
              sitting in its queue. On a device that prints for itself, a
              machine in another room being asleep is not news — and pressing
              that button anyway says so at the moment it matters. Nobody
              home and printer-not-answering are different promises: only the
              first one prints by itself later. */}
          {status && !status.printerConnected && (!localRoute || status.pendingJobs > 0) && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {!status.agentOnline ? (
                <>
                  The printer PC is not answering — it is asleep, or the connector is not running
                  on it.{" "}
                  {localRoute
                    ? `${localRoute} still works. Anything sent to the printer PC waits until it is back.`
                    : "You can still press Print: the receipt is saved and prints as soon as the connector is back."}
                </>
              ) : (
                <>
                  The connector is running but the printer is not answering
                  {status.note ? ` — ${status.note}` : ""}. Check it is switched on, has paper, and
                  is plugged in.{" "}
                  {localRoute
                    ? `${localRoute} still works.`
                    : "Printing now will save the receipt and fail into the Queue, where you can retry it."}
                </>
              )}
            </p>
          )}

          {result.kind === "done" && (
            <p className="rounded bg-green-50 px-3 py-2 text-sm text-green-900">
              Printed. Receipt no. {result.receiptNo}.
            </p>
          )}
          {result.kind === "queued" && (
            <p className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
              Receipt no. {result.receiptNo} saved and waiting. It prints as soon as the printer
              PC is back — see Queue.
            </p>
          )}
          {result.kind === "printing" && (
            <p className="rounded bg-neutral-200 px-3 py-2 text-sm">
              Receipt no. {result.receiptNo} queued, waiting for the printer…
            </p>
          )}
          {result.kind === "failed" && (
            <p className="rounded bg-red-50 px-3 py-2 text-sm text-red-900">
              {result.receiptNo ? `Receipt no. ${result.receiptNo} saved but not printed. ` : ""}
              {result.message}
            </p>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-4 text-sm font-medium text-neutral-600">Preview — 58mm</h2>
        <Preview lines={previewLines} />
      </section>
    </div>
  );
}

/** Poll until the agent reports back, or give up and send them to the Queue. */
async function waitForJob(jobId: string, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1200));
    const res = await fetch("/api/jobs", { cache: "no-store" });
    if (!res.ok) continue;
    const { jobs } = (await res.json()) as {
      jobs: { id: string; status: string; error: string | null }[];
    };
    const job = jobs.find((j) => j.id === jobId);
    if (job && job.status !== "PENDING" && job.status !== "PRINTING") return job;
  }
  return { status: "TIMEOUT", error: "No response from the printer yet. Check the Queue." };
}
