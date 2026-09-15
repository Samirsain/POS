/**
 * Printing straight from an Android phone over Bluetooth.
 *
 * This printer is Bluetooth Classic (SPP), and a browser cannot reach that —
 * Web Bluetooth only speaks BLE, and this device exposes no GATT services at
 * all. So the page hands the finished ESC/POS bytes to RawBT, a free Android
 * ESC/POS driver, which owns the Bluetooth connection.
 *
 * The phone pairs with the printer once in Android's own Bluetooth settings.
 * After that: open the site, press Print, paper comes out. No laptop, no
 * connector, no office PC switched on.
 *
 * Format per RawBT's documented intent scheme:
 *   intent:base64,<data>#Intent;scheme=rawbt;package=ru.a402d.rawbtprinter;end;
 *
 * If RawBT is not installed, Chrome opens its Play Store page instead of
 * failing — which is the install prompt, for free.
 */
export const RAWBT_PACKAGE = "ru.a402d.rawbtprinter";

export function rawbtIntentUrl(payloadBase64: string): string {
  return `intent:base64,${payloadBase64}#Intent;scheme=rawbt;package=${RAWBT_PACKAGE};end;`;
}

/**
 * Android only. iOS has no equivalent app-scheme route to a Classic Bluetooth
 * printer, and on a desktop the office connector is the right path anyway, so
 * offering the button there would only mislead.
 */
export function isAndroid(): boolean {
  if (typeof navigator === "undefined") return false;
  return /android/i.test(navigator.userAgent);
}

/** Hand the bytes to RawBT. Navigation is the delivery mechanism, not a page load. */
export function sendToRawbt(payloadBase64: string): void {
  window.location.href = rawbtIntentUrl(payloadBase64);
}
