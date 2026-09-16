"use client";

import { useCallback, useSyncExternalStore } from "react";

/**
 * Printing straight from a laptop over USB.
 *
 * Chrome's WebUSB lets the page claim the printer's bulk OUT endpoint and push
 * exactly the bytes the connector would have written to a COM port. Plug the
 * printer in, press Print, pick it once in the browser's device chooser —
 * Chrome remembers it after that and the chooser never comes back.
 *
 * No connector, no office PC, no queue. Same bargain as RawBT on Android: the
 * person pressing the button is standing in front of the printer, so nothing
 * needs to report back.
 */

/** Chrome and Edge only. Firefox and Safari ship no WebUSB at all. */
export function hasWebUsb(): boolean {
  return typeof navigator !== "undefined" && "usb" in navigator;
}

/**
 * Call this from the click itself. The chooser needs the user gesture, and
 * awaiting the POST first spends it — so the printer is picked before the
 * receipt is created, not after.
 */
export async function pickPrinter(): Promise<USBDevice> {
  const [remembered] = await navigator.usb.getDevices();
  if (remembered) return remembered;
  // Class 7 is USB Printer, which is what these ESC/POS boxes enumerate as.
  // Filtering keeps every keyboard, webcam and phone out of the chooser.
  return navigator.usb.requestDevice({ filters: [{ classCode: 7 }] });
}

/**
 * What Chrome says when Windows owns the device, in words the counter can act
 * on. "Access denied" out of `open()` and "Unable to claim interface" out of
 * `claimInterface()` are the same problem wearing two hats: a driver is already
 * bound to the printer, so the browser is refused the handle.
 */
export function usbFailureMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/access denied|unable to claim|no device selected|device unavailable/i.test(raw)) {
    return (
      "Windows is holding this printer with its own driver, so the browser cannot reach it. " +
      "Swap it to WinUSB — see the USB section of the README."
    );
  }
  return raw;
}

/**
 * Whether the browser can actually have this printer, which is not the same
 * question as whether the operator allowed it. Windows decides, and the only
 * way to ask Windows is to try. Cheap: open and close, no bytes.
 */
async function openable(device: USBDevice): Promise<void> {
  await device.open();
  await device.close();
}

export async function printOverUsb(device: USBDevice, payloadBase64: string): Promise<void> {
  const bytes = Uint8Array.from(atob(payloadBase64), (c) => c.charCodeAt(0));

  try {
    await device.open();
  } catch (e) {
    throw new Error(usbFailureMessage(e));
  }
  try {
    // configuration is null until the device is open, so the endpoint can only
    // be found in here.
    if (!device.configuration) await device.selectConfiguration(1);
    const { interfaceNumber, endpointNumber } = bulkOut(device);
    try {
      await device.claimInterface(interfaceNumber);
    } catch (e) {
      throw new Error(usbFailureMessage(e));
    }
    const result = await device.transferOut(endpointNumber, bytes);
    if (result.status !== "ok") throw new Error(`The printer rejected the data (${result.status}).`);
  } finally {
    // One handle per receipt. Holding it open survives nothing useful — a
    // cable pull or a sleep leaves a claimed interface that only a reload frees.
    await device.close().catch(() => {});
  }
}

/** The endpoint that takes raw bytes. Every printer-class device has exactly one. */
function bulkOut(device: USBDevice) {
  for (const iface of device.configuration?.interfaces ?? []) {
    const endpoint = iface.alternate.endpoints.find(
      (e) => e.direction === "out" && e.type === "bulk",
    );
    if (endpoint) {
      return { interfaceNumber: iface.interfaceNumber, endpointNumber: endpoint.endpointNumber };
    }
  }
  throw new Error("That device has no bulk OUT endpoint — is it the printer?");
}

/**
 * Which printer this laptop is plugged into, live.
 *
 * Chrome hands back a device the operator has already allowed without asking
 * again, and only while it is actually plugged in — so this doubles as the
 * cable's own connected light. Connect once, then Print is just Print.
 *
 * Module state rather than per-component state: the form's Connect button and
 * the header's light have to be the same answer, and granting permission fires
 * no event that the other one could hear.
 */
type UsbState = { device: USBDevice | null; error: string | null };

const NOTHING: UsbState = { device: null, error: null };
let state: UsbState = NOTHING;
const listeners = new Set<() => void>();
let watching = false;

function publish(next: UsbState) {
  state = next;
  for (const listener of listeners) listener();
}

/** Green only once Windows has actually handed the device over. */
async function adopt(candidate: USBDevice) {
  try {
    await openable(candidate);
    publish({ device: candidate, error: null });
  } catch (e) {
    publish({ device: null, error: usbFailureMessage(e) });
  }
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  // Once per page, on the first component to ask. These outlive every
  // component, which is the point — the cable does too.
  if (!watching && hasWebUsb()) {
    watching = true;
    void navigator.usb.getDevices().then(([remembered]) => {
      if (remembered) void adopt(remembered);
    });
    // Someone pulls the cable mid-shift, or plugs it back in. Both change the
    // answer without anybody touching the page.
    navigator.usb.addEventListener("connect", (e) => void adopt(e.device));
    navigator.usb.addEventListener("disconnect", (e) => {
      if (state.device === e.device) publish(NOTHING);
    });
  }
  return () => {
    listeners.delete(listener);
  };
}

export function useUsbPrinter() {
  const { device, error } = useSyncExternalStore(
    subscribe,
    () => state,
    () => NOTHING, // The server has no cable.
  );

  /**
   * Opens the chooser and proves the device is usable, so a driver Windows will
   * not let go of is found here — at the cost of a click — rather than after a
   * receipt number has been spent on it.
   */
  const connect = useCallback(async () => {
    const picked = await pickPrinter();
    await openable(picked).catch((e: unknown) => {
      publish({ device: null, error: usbFailureMessage(e) });
      throw new Error(usbFailureMessage(e));
    });
    publish({ device: picked, error: null });
    return picked;
  }, []);

  return { device, error, connect };
}
