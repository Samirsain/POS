/**
 * LayoutLine[] -> ESC/POS bytes for the DNT-585-LU5325.
 *
 * Runs on the server, not in the agent: the agent receives finished bytes and
 * writes them to the port. That keeps the machine in the office dumb and stable.
 */
import { ASSET_BITMAP } from "./asset-bitmaps";
import type { AssetId } from "./asset-sizes";
import type { Align, Font, LayoutLine, TextSize } from "./receipt";
import { FONT_COLS, LINE_DOTS, colsAt, lineDots } from "./receipt";

const ESC = 0x1b;
const GS = 0x1d;
const b = (...bytes: number[]) => Buffer.from(bytes);

/**
 * Code page 437, positions 0x80-0xFF, in order. Selected by `ESC t 0` in the
 * preamble. Anything not in this table and not ASCII is rejected, never
 * silently dropped (rule 10).
 */
const CP437_HIGH =
  "ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const CP437 = new Map<string, number>();
for (let i = 0; i < CP437_HIGH.length; i++) CP437.set(CP437_HIGH[i], 0x80 + i);

export class UnprintableCharacterError extends Error {
  constructor(readonly char: string, context: string) {
    super(
      `The printer cannot represent ${JSON.stringify(char)} (U+${char
        .codePointAt(0)!
        .toString(16)
        .toUpperCase()
        .padStart(4, "0")}) in ${JSON.stringify(context)}. ` +
        `It has no Unicode and no Devanagari — use plain English text.`,
    );
    this.name = "UnprintableCharacterError";
  }
}

/** Encode one line as CP437. Throws on anything the printer has no glyph for. */
export function encodeText(s: string): Buffer {
  const out = Buffer.alloc(s.length);
  let n = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code <= 0x7e) {
      out[n++] = code;
      continue;
    }
    const mapped = CP437.get(ch);
    // The two that matter in this app: U+20B9 (rupee) and U+0950 (om). Both are
    // caught here rather than at the call site, so no future caller can leak
    // them into the byte stream (spec rules 1 and 10).
    if (mapped === undefined) throw new UnprintableCharacterError(ch, s);
    out[n++] = mapped;
  }
  return out.subarray(0, n);
}

/** Spec §7.1. Sent at the start of every job — printer defaults are user-modifiable. */
export const PREAMBLE = Buffer.concat([
  b(ESC, 0x40), // ESC @   initialise
  b(ESC, 0x74, 0x00), // ESC t 0 code page PC437
  b(ESC, 0x52, 0x00), // ESC R 0 international charset = USA
  b(ESC, 0x4d, 0x00), // ESC M 0 Font A
  b(ESC, 0x61, 0x00), // ESC a 0 left align
  b(ESC, 0x33, LINE_DOTS), // ESC 3 n line spacing in dots - never the default
]);

const ALIGN: Record<Align, number> = { left: 0, center: 1, right: 2 };
const FONT: Record<Font, number> = { A: 0, B: 1 };

/**
 * GS ! n — high nibble is the width multiplier, low nibble the height, each
 * (multiplier - 1). The printer only does whole multiples: there is no 1.2x.
 */
const GS_SIZE: Record<TextSize, number> = { normal: 0x00, large: 0x11, xlarge: 0x22 };

/** Blank lines fed after the receipt so the last line clears the tear bar. */
export const TEAR_FEED_LINES = 4;

const ASSETS = ASSET_BITMAP;

export type EncodeOptions = {
  /** Spec §7.3: GS V is not listed in the self-test. Off until proven. */
  autoCut?: boolean;
};

export function encode(lines: LayoutLine[], opts: EncodeOptions = {}): Buffer {
  const parts: Buffer[] = [PREAMBLE];

  // Track printer state so we only emit a command when something actually
  // changes — on Bluetooth SPP every wasted byte is measurable latency (§8.2).
  let font: Font = "A";
  let align: Align = "left";
  let bold = false;
  let size: TextSize = "normal";

  const setAlign = (next: Align) => {
    if (next === align) return;
    parts.push(b(ESC, 0x61, ALIGN[next]));
    align = next;
  };

  for (const line of lines) {
    if (line.kind === "image") {
      const asset = ASSETS[line.assetId as AssetId];
      if (!asset) throw new Error(`unknown image asset ${JSON.stringify(line.assetId)}`);
      setAlign(line.align);
      parts.push(asset);
      continue;
    }

    if (line.kind === "feed") {
      parts.push(b(ESC, 0x64, line.lines)); // ESC d n
      continue;
    }

    if (line.kind === "gap") {
      // ESC J n feeds n dots exactly, which is how the closing divider lands on
      // the millimetre instead of on the nearest whole line. n maxes out at 255.
      for (let left = line.dots; left > 0; left -= 255) {
        parts.push(b(ESC, 0x4a, Math.min(255, left)));
      }
      continue;
    }

    setAlign(line.align);
    if (line.font !== font) {
      parts.push(b(ESC, 0x4d, FONT[line.font]));
      font = line.font;
    }
    if (line.bold !== bold) {
      parts.push(b(ESC, 0x45, line.bold ? 1 : 0));
      bold = line.bold;
    }
    if (line.size !== size) {
      parts.push(b(GS, 0x21, GS_SIZE[line.size]));
      // A 2x or 3x glyph is 48 or 72 dots tall; at the default 32-dot spacing the
      // next line would print through it. Spacing tracks the size.
      parts.push(b(ESC, 0x33, lineDots(line.size)));
      size = line.size;
    }

    const width = colsAt(FONT_COLS[line.font], line.size);
    if (line.text.length > width) {
      // layout() is responsible for wrapping. Reaching here means the two
      // disagree about width, which would silently print a wrong receipt.
      throw new Error(
        `line exceeds Font ${line.font} ${line.size} width ${width}: ${JSON.stringify(line.text)}`,
      );
    }
    parts.push(encodeText(line.text), b(0x0a));
  }

  // Leave the printer in a known state for whatever prints next.
  if (bold) parts.push(b(ESC, 0x45, 0));
  if (size !== "normal") {
    parts.push(b(GS, 0x21, 0x00), b(ESC, 0x33, LINE_DOTS));
  }
  if (align !== "left") parts.push(b(ESC, 0x61, 0));
  if (font !== "A") parts.push(b(ESC, 0x4d, 0));
  // §7.3: the tear bar sits below the print head, so without this the last line
  // is still inside the printer. This is paper past the receipt, not part of its
  // fixed height, which is why the templates do not carry it.
  parts.push(b(ESC, 0x64, TEAR_FEED_LINES));
  if (opts.autoCut) parts.push(b(GS, 0x56, 0x00)); // unverified — default off (§7.3)

  return Buffer.concat(parts);
}
