"use client";

import { useCallback, useEffect, useState } from "react";

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

export async function printOverUsb(device: USBDevice, payloadBase64: string): Promise<void> {
  const bytes = Uint8Array.from(atob(payloadBase64), (c) => c.charCodeAt(0));

  await device.open();
  try {
    // configuration is null until the device is open, so the endpoint can only
    // be found in here.
    if (!device.configuration) await device.selectConfiguration(1);
    const { interfaceNumber, endpointNumber } = bulkOut(device);
    try {
      await device.claimInterface(interfaceNumber);
    } catch {
      // Far and away the most common failure, and the message Chrome gives
      // ("Unable to claim interface") tells the counter staff nothing.
      throw new Error(
        "Windows is holding this printer with its own driver, so the browser cannot use it. " +
          "See the USB section of the README, or print on the office printer instead.",
      );
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
 */
export function useUsbPrinter() {
  const [device, setDevice] = useState<USBDevice | null>(null);

  useEffect(() => {
    if (!hasWebUsb()) return;
    void navigator.usb.getDevices().then(([remembered]) => {
      if (remembered) setDevice(remembered);
    });

    // Someone pulls the cable mid-shift, or plugs it back in. Both change the
    // answer without anybody touching the page.
    const onConnect = (e: USBConnectionEvent) => setDevice(e.device);
    const onDisconnect = (e: USBConnectionEvent) =>
      setDevice((current) => (current === e.device ? null : current));
    navigator.usb.addEventListener("connect", onConnect);
    navigator.usb.addEventListener("disconnect", onDisconnect);
    return () => {
      navigator.usb.removeEventListener("connect", onConnect);
      navigator.usb.removeEventListener("disconnect", onDisconnect);
    };
  }, []);

  /** Opens the chooser. Must be called straight from a click. */
  const connect = useCallback(async () => {
    const picked = await pickPrinter();
    setDevice(picked);
    return picked;
  }, []);

  return { device, connect };
}
