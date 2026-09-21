/**
 * The receipt model, the layout engine, and money formatting.
 *
 * Pure. No I/O, no React, no printer. Both the browser preview and the ESC/POS
 * encoder consume layout()'s output — spec rule 3: there is exactly one layout
 * implementation and this is it.
 */
import { z } from "zod";
import { ASSET_SIZE, type AssetId } from "./asset-sizes";

// --- fonts ----------------------------------------------------------------
export type Font = "A" | "B";
export type Align = "left" | "center" | "right";

/** Read from the printer's own self-test. Not from a datasheet. Spec §1. */
export const FONT_COLS: Record<Font, number> = { A: 32, B: 42 };

/**
 * Font B is UNVERIFIED — the self-test printed `¥` where `$` was expected
 * (spec §1.3). Until docs/printer-verification.md says otherwise, everything
 * renders in Font A at 32 columns. Flip this to "B" only with paper evidence.
 */
export const DEFAULT_FONT: Font = "A";

// --- template -------------------------------------------------------------
const alignSchema = z.enum(["left", "center", "right"]);
const fontSchema = z.enum(["A", "B"]);
/**
 * ESC/POS scales glyphs by whole multiples only (GS ! n) - there is no 1.2x.
 * Every size here scales width and height together, so characters keep their
 * natural proportions; a taller-but-not-wider setting exists in the hardware
 * but it is a stretch, and stretched text is not allowed on this receipt.
 *   normal  1x1  32 columns
 *   large   2x2  16 columns
 *   xlarge  3x3  10 columns
 */
const sizeSchema = z.enum(["normal", "large", "xlarge"]);

const sectionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("image"),
    /** Base asset name, e.g. "om-logo". resolveTemplate() appends the size. */
    assetId: z.string(),
    align: alignSchema,
    /**
     * Filled in by resolveTemplate() from the chosen size — a raster's width is
     * whatever it was rendered at, so authoring it here could only disagree
     * with the file. Multiple of 8 because a raster row is whole bytes.
     */
    widthDots: z
      .number()
      .int()
      .refine((n) => n % 8 === 0, "widthDots must be a multiple of 8")
      .optional(),
  }),
  z.object({
    type: z.literal("text"),
    content: z.string(),
    align: alignSchema.default("left"),
    font: fontSchema.optional(),
    bold: z.boolean().optional(),
    size: sizeSchema.optional(),
  }),
  z.object({
    type: z.literal("labelValue"),
    label: z.string(),
    field: z.string(),
    format: z.enum(["currency", "date", "text", "receiptNo", "words"]).optional(),
    align: alignSchema.default("left"),
    font: fontSchema.optional(),
    bold: z.boolean().optional(),
    size: sizeSchema.optional(),
    /**
     * Step the size down until the value fits on one line. For an amount that
     * matters: a money figure broken across two lines is harder to read than a
     * smaller one, and wrapping is the only other option (we never truncate).
     */
    shrinkToFit: z.boolean().optional(),
    /** Pad the label to this width so a column of colons lines up. */
    labelWidth: z.number().int().min(1).optional(),
    /**
     * Pad the finished line to this width before aligning it. Centring two rows
     * of different length would otherwise shift their colons apart, which is
     * exactly what labelWidth exists to prevent — padding to a common width
     * centres them as a block instead. Never truncates.
     */
    lineWidth: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal("splitRow"),
    leftField: z.string(),
    rightField: z.string(),
    font: fontSchema.optional(),
  }),
  // Not used by this template. Defined so a second template that needs repeating
  // rows extends the union instead of reshaping it. The renderer throws for it
  // on purpose. Spec §3.2.
  z.object({ type: z.literal("items"), field: z.string() }),
  z.object({
    type: z.literal("divider"),
    char: z.string().length(1).optional(),
    font: fontSchema.optional(),
  }),
  z.object({ type: z.literal("spacer"), lines: z.number().int().min(1) }),
  /**
   * A gap measured in millimetres rather than whole blank lines. A 4mm blank
   * line is a clumsy unit for separating sections on a 80mm receipt; this lets
   * the rhythm be tuned in 1mm steps.
   */
  z.object({ type: z.literal("gap"), mm: z.number().min(0.5) }),
  z.object({ type: z.literal("feed"), lines: z.number().int().min(1) }),
  /**
   * Absorbs whatever height is left over, so everything after it lands at the
   * bottom of the fixed-height receipt. Content that overruns the height simply
   * gets no fill — the receipt grows rather than losing a line (§5.2).
   */
  z.object({ type: z.literal("fill") }),
]);

export const templateSchema = z.object({
  id: z.string(),
  name: z.string(),
  paperWidth: z.literal(58),
  /** Fixed printed height in mm. A `fill` section pads the receipt out to it. */
  heightMm: z.number().int().min(10).default(80),
  sections: z.array(sectionSchema),
});

// --- vertical geometry ----------------------------------------------------
/** 203 dpi head. Used to turn millimetres into the printer's own units. */
export const DOTS_PER_MM = 8;

/**
 * Line spacing, set explicitly with `ESC 3 n` in the preamble rather than
 * trusting the printer's default, which the vendor utility can change (§7.1).
 * 32 dots = 4mm, and a Font A glyph is 24 dots, so there is real leading.
 */
export const LINE_DOTS = 32;

/**
 * Glyph scale per size, and the line spacing each one needs. A Font A glyph is
 * 24 dots tall, so 2x is 48 and 3x is 72; the spacing adds a little leading on
 * top so consecutive lines do not touch.
 */
export const SIZE_SCALE: Record<TextSize, number> = { normal: 1, large: 2, xlarge: 3 };
export const SIZE_DOTS: Record<TextSize, number> = { normal: 32, large: 56, xlarge: 80 };

export const lineDots = (size: TextSize | undefined): number => SIZE_DOTS[size ?? "normal"];

export type ReceiptTemplate = z.infer<typeof templateSchema>;
export type TemplateSection = z.infer<typeof sectionSchema>;
/** What a template is authored as: defaults like `align` are filled in by parse. */
export type TemplateSectionInput = z.input<typeof sectionSchema>;

/**
 * The receipt body, shared by every template. Only the header differs.
 *
 * Devanagari headers must be raster bitmaps: the printer has no Devanagari and
 * no Unicode, so those characters cannot be sent as text at all (§1.1). That
 * bitmap is the only one on the page — nothing else gets rasterised, because
 * bytes are what make a Bluetooth print slow (§8.2).
 */
const BODY: TemplateSectionInput[] = [
  { type: "divider" },
  { type: "splitRow", leftField: "receiptNo", rightField: "date" },
  { type: "divider" },
  { type: "gap", mm: 3 },
  // 2x and bold, with the amount a step above at 3x — the hierarchy in the
  // reference image. shrinkToFit drops any value too long for its size down a
  // step rather than wrapping it across two lines.
  { type: "labelValue", label: "", field: "projectCode", align: "center", bold: true, size: "large", shrinkToFit: true },
  { type: "labelValue", label: "", field: "plotNo", align: "center", bold: true, size: "large", shrinkToFit: true },
  { type: "labelValue", label: "", field: "customerName", align: "center", bold: true, size: "large", shrinkToFit: true },
  { type: "gap", mm: 2 },
  { type: "labelValue", label: "", field: "amount", format: "currency", align: "center", bold: true, size: "xlarge", shrinkToFit: true },
  { type: "gap", mm: 2 },
  { type: "labelValue", label: "", field: "amount", format: "words", align: "center" },
  // Pins the closing divider to the bottom of the fixed-height receipt.
  { type: "fill" },
  { type: "divider" },
  { type: "gap", mm: 2 },
];

/**
 * The detailed layout: aligned label column, amount in words, signature on the
 * right. Its heading is plain ASCII, so this template carries no bitmap at all
 * — roughly 250 bytes against 1,000-4,500 for the Devanagari ones, which on
 * Bluetooth is the difference between instant and a visible pause.
 */
const DETAILED_SECTIONS: TemplateSectionInput[] = [
  // Top margin, matched by a bottom margin below the closing divider.
  { type: "gap", mm: 2 },
  { type: "text", content: "|| SHRI GANESHAY NAMAH ||", align: "center", bold: true },
  { type: "divider", char: "─" },
  // Left, so the colons stand in one column down the page — that is the point
  // of labelWidth, and centring these two would pull them apart.
  { type: "labelValue", label: "Receipt No.", labelWidth: 12, field: "receiptNo", format: "receiptNo" },
  { type: "labelValue", label: "Date", labelWidth: 12, field: "date", format: "date" },
  { type: "divider", char: "─" },
  { type: "gap", mm: 3 },
  // 2x and bold, as in the reference image.
  { type: "labelValue", label: "", field: "projectCode", align: "center", bold: true, size: "large", shrinkToFit: true },
  { type: "labelValue", label: "", field: "plotNo", align: "center", bold: true, size: "large", shrinkToFit: true },
  { type: "labelValue", label: "", field: "customerName", align: "center", bold: true, size: "large", shrinkToFit: true },
  { type: "gap", mm: 3 },
  // The largest thing on the page at 3x. Only ten characters fit at 3x, so
  // anything from "Rs. 1,00,00,000" upwards steps down to 2x — at that point it
  // is the same size as the name above it, which is as close to the reference
  // as 32 columns allows. Wrapping a money figure would be worse.
  { type: "labelValue", label: "", field: "amount", format: "currency", align: "center", bold: true, size: "xlarge", shrinkToFit: true },
  { type: "gap", mm: 2 },
  { type: "labelValue", label: "", field: "amount", format: "words", align: "center" },
  // Pins the closing divider to the bottom of the page, whatever height the
  // words above took.
  { type: "fill" },
  { type: "divider", char: "─" },
  { type: "gap", mm: 2 },
];

const headed = (asset: string): TemplateSectionInput[] => [
  { type: "image", assetId: asset, align: "center" },
  ...BODY,
];

export const TEMPLATES: Record<string, ReceiptTemplate> = Object.fromEntries(
  (
    [
      ["om", "Om (ॐ)", headed("om-logo")],
      [
        "ganesh",
        "Shree Ganeshay Namah (श्री गणेशाय नमः)",
        headed("ganesh"),
      ],
      ["detailed", "Detailed (text heading, amount in words)", DETAILED_SECTIONS],
    ] as const
  ).map(([id, name, sections]) => [
    id,
    templateSchema.parse({ id, name, paperWidth: 58, sections }),
  ]),
);

// The layout that was actually designed. The Devanagari headings are variants.
export const DEFAULT_TEMPLATE_ID = "detailed";
export const TEMPLATE = TEMPLATES[DEFAULT_TEMPLATE_ID];

// --- header size ----------------------------------------------------------
export const HEADER_SIZES = ["s", "m", "l"] as const;
export type HeaderSize = (typeof HEADER_SIZES)[number];
export const DEFAULT_HEADER_SIZE: HeaderSize = "m";

export const HEADER_SIZE_LABEL: Record<HeaderSize, string> = {
  s: "Small",
  m: "Medium",
  l: "Large",
};

/**
 * Pick the rendered variant of each image for the chosen size.
 *
 * A raster cannot be scaled at print time — ESC/POS has no such command — so
 * every size is pre-rendered by `npm run bitmap` and this only chooses between
 * them. Size is also the latency knob: bytes grow with the square of the width,
 * so Large is roughly four times the wait of Small on Bluetooth.
 */
export function resolveTemplate(
  template: ReceiptTemplate,
  size: HeaderSize = DEFAULT_HEADER_SIZE,
): ReceiptTemplate {
  return {
    ...template,
    sections: template.sections.map((s) => {
      if (s.type !== "image") return s;
      const assetId = `${s.assetId}-${size}` as AssetId;
      const asset = ASSET_SIZE[assetId];
      if (!asset) throw new Error(`no ${size} variant of image asset "${s.assetId}"`);
      return { ...s, assetId, widthDots: asset.width };
    }),
  };
}

/** ESC/POS bytes the header will cost — shown in the UI so the choice is informed. */
export function headerBytes(template: ReceiptTemplate, size: HeaderSize): number {
  const image = resolveTemplate(template, size).sections.find((s) => s.type === "image");
  return image ? ASSET_SIZE[image.assetId as AssetId].bytes : 0;
}

// --- form metadata --------------------------------------------------------
/**
 * How each runtime field is presented in the entry form. The form's contents
 * still come from scanning the template for field keys (spec §3.1) — this only
 * says how to label and type the input. Adding a field to the template plus a
 * line here adds an input; the form itself is never hard-coded.
 */
export type FieldMeta = {
  label: string;
  input: "text" | "money" | "auto";
  placeholder?: string;
  uppercase?: boolean;
};

export const FIELD_META: Record<string, FieldMeta> = {
  receiptNo: { label: "Receipt No.", input: "auto", placeholder: "auto" },
  date: { label: "Date", input: "auto" },
  projectCode: { label: "Project", input: "text", placeholder: "GREENFIELD", uppercase: true },
  plotNo: { label: "Plot No.", input: "text", placeholder: "A-14", uppercase: true },
  customerName: { label: "Name", input: "text", placeholder: "RAHUL SHARMA", uppercase: true },
  amount: { label: "Amount", input: "money", placeholder: "25000" },
};

/** Every runtime field the template references, in template order. */
export function templateFields(template: ReceiptTemplate = TEMPLATE): string[] {
  const seen: string[] = [];
  const add = (f: string) => {
    if (!seen.includes(f)) seen.push(f);
  };
  for (const s of template.sections) {
    if (s.type === "labelValue" || s.type === "items") add(s.field);
    if (s.type === "splitRow") {
      add(s.leftField);
      add(s.rightField);
    }
  }
  return seen;
}

// --- money ----------------------------------------------------------------
export type Target = "preview" | "print";

/**
 * The only place preview and print are allowed to differ, and the reason is
 * physical: the printer has no glyph for the rupee sign (spec §1.1, §6).
 * Amounts are integer paise end to end; this is the single formatter.
 */
export function formatCurrency(paise: number, target: Target): string {
  if (!Number.isInteger(paise)) throw new Error(`amount must be integer paise, got ${paise}`);
  const neg = paise < 0;
  const rupees = String(Math.trunc(Math.abs(paise) / 100));
  const head = rupees.slice(0, -3);
  const tail = rupees.slice(-3);
  // Indian grouping: last three, then twos. 1,25,000 — never 125,000.
  const grouped = head ? `${head.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${tail}` : tail;
  const sign = neg ? "-" : "";
  return target === "preview" ? `${sign}₹${grouped}` : `${sign}Rs. ${grouped}`;
}

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
  "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen",
  "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

/** 0-99. Above that the Indian groups take over. */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const ones = ONES[n % 10];
  return ones ? `${tens} ${ones}` : tens;
}

/**
 * Amount in words, Indian system: crore, lakh, thousand, hundred.
 * A signed money receipt is read by people who check the figure against the
 * words, so this is not decoration.
 */
export function amountToWords(paise: number): string {
  if (!Number.isInteger(paise)) throw new Error(`amount must be integer paise, got ${paise}`);
  if (paise < 0) throw new Error("amount cannot be negative");

  const rupees = Math.trunc(paise / 100);
  const remainder = paise % 100;

  const groups: string[] = [];
  const push = (n: number, unit: string) => {
    if (n > 0) groups.push(`${twoDigits(n)} ${unit}`.trim());
  };
  push(Math.floor(rupees / 10_000_000), "Crore");
  push(Math.floor((rupees % 10_000_000) / 100_000), "Lakh");
  push(Math.floor((rupees % 100_000) / 1_000), "Thousand");
  push(Math.floor((rupees % 1_000) / 100), "Hundred");
  const last = rupees % 100;
  if (last > 0) groups.push(twoDigits(last));

  const rupeeWords = groups.length
    ? `${groups.join(" ")} ${rupees === 1 ? "Rupee" : "Rupees"}`
    : "Zero Rupees";
  const paiseWords =
    remainder > 0 ? ` and ${twoDigits(remainder)} ${remainder === 1 ? "Paisa" : "Paise"}` : "";
  return `${rupeeWords}${paiseWords} Only`;
}

/** Printed receipt-number format. The database still stores the plain number. */
export const RECEIPT_NO_DIGITS = 6;

export function formatReceiptNo(value: string): string {
  const digits = value.replace(/\D/g, "");
  return digits ? digits.padStart(RECEIPT_NO_DIGITS, "0") : value;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function formatDate(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${String(value)}`);
  return `${String(d.getDate()).padStart(2, "0")}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
}

// --- layout ---------------------------------------------------------------
export type LayoutLine =
  | { kind: "text"; text: string; font: Font; align: Align; bold: boolean; size: TextSize }
  | { kind: "image"; assetId: string; align: Align; widthDots: number }
  | { kind: "feed"; lines: number }
  /** A precise vertical gap in printer dots, so the page hits an exact height. */
  | { kind: "gap"; dots: number; fill?: boolean };

export type TextSize = z.infer<typeof sizeSchema>;

/**
 * How many characters fit on a line at this size. Only "large" doubles the
 * glyph width; "tall" stretches height alone, so the column grid is untouched
 * — which is why it is the safe way to emphasise a line.
 */
export function colsAt(cols: number, size: TextSize | undefined): number {
  return Math.floor(cols / SIZE_SCALE[size ?? "normal"]);
}
export type ReceiptData = Record<string, string | number | undefined>;

/** Wrap to cols, continuation lines indented. Never truncates (§5.2). */
function wrap(text: string, cols: number, indent = 0): string[] {
  if (text.length <= cols) return [text];
  const out: string[] = [];
  const pad = " ".repeat(indent);
  let line = "";
  let width = cols;
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : line + word;
    if (candidate.length <= width) {
      line = candidate;
      continue;
    }
    if (line) out.push(line);
    width = cols - indent;
    // A single word longer than the line is hard-split, never dropped.
    let rest = word;
    while (rest.length > width) {
      out.push(pad + rest.slice(0, width));
      rest = rest.slice(width);
    }
    line = pad + rest;
  }
  if (line) out.push(line);
  return out;
}

function valueOf(
  data: ReceiptData,
  field: string,
  format: string | undefined,
  target: Target,
): string {
  const raw = data[field];
  if (raw === undefined || raw === "") return "";
  if (format === "currency") return formatCurrency(Number(raw), target);
  if (format === "date") return formatDate(String(raw));
  if (format === "receiptNo") return formatReceiptNo(String(raw));
  if (format === "words") return amountToWords(Number(raw));
  return String(raw);
}

export function layout(
  template: ReceiptTemplate,
  data: ReceiptData,
  target: Target,
): LayoutLine[] {
  const out: LayoutLine[] = [];
  const push = (
    text: string,
    font: Font,
    opts: { align?: Align; bold?: boolean; size?: TextSize } = {},
  ) =>
    out.push({
      kind: "text",
      text,
      font,
      align: opts.align ?? "left",
      bold: opts.bold ?? false,
      size: opts.size ?? "normal",
    });

  for (const s of template.sections) {
    // Width always comes from the line's own font. Never a global constant (rule 2).
    const font: Font = "font" in s && s.font ? s.font : DEFAULT_FONT;
    const cols = FONT_COLS[font];

    switch (s.type) {
      case "image":
        if (s.widthDots === undefined) {
          throw new Error(
            `image "${s.assetId}" has no size — call resolveTemplate() before layout()`,
          );
        }
        out.push({ kind: "image", assetId: s.assetId, align: s.align, widthDots: s.widthDots });
        break;

      case "text":
        for (const l of wrap(s.content, colsAt(cols, s.size)))
          push(l, font, { align: s.align, bold: s.bold, size: s.size });
        break;

      case "labelValue": {
        const value = valueOf(data, s.field, s.format, target);
        // labelWidth means "aligned label column", which by convention ends in a
        // colon; without it the label is just a word in front of the value.
        const prefix = !s.label
          ? ""
          : s.labelWidth
            ? `${s.label.padEnd(s.labelWidth)}: `
            : `${s.label}  `;
        // Continuation lines only hang under the value when the line is
        // left-aligned; under centre or right the indent would look wrong.
        const indent = s.align === "left" ? prefix.length : 0;
        // Step down through the sizes until it fits on one line, rather than
        // wrapping a figure that is meant to be read at a glance.
        const size = s.shrinkToFit
          ? (["xlarge", "large", "normal"] as const).find(
              (candidate) =>
                (SIZE_SCALE[candidate] <= SIZE_SCALE[s.size ?? "normal"]) &&
                prefix.length + value.length <= colsAt(cols, candidate),
            ) ?? "normal"
          : s.size;
        const width = colsAt(cols, size);
        for (const l of wrap(prefix + value, width, indent))
          push(s.lineWidth ? l.padEnd(Math.min(s.lineWidth, width)) : l, font, {
            align: s.align,
            bold: s.bold,
            size,
          });
        break;
      }

      case "splitRow": {
        const left = valueOf(data, s.leftField, undefined, target);
        const right = valueOf(data, s.rightField, "date", target);
        const gap = cols - left.length - right.length;
        // Wrapping beats truncating when both halves are long (§5.2).
        if (gap < 1) {
          push(left, font);
          push(right.padStart(cols), font);
        } else {
          push(left + " ".repeat(gap) + right, font);
        }
        break;
      }

      case "divider":
        push((s.char ?? "-").repeat(cols), font);
        break;

      case "spacer":
        for (let i = 0; i < s.lines; i++) push("", font);
        break;

      case "feed":
        out.push({ kind: "feed", lines: s.lines });
        break;

      case "gap":
        out.push({ kind: "gap", dots: Math.round(s.mm * DOTS_PER_MM) });
        break;

      case "fill":
        // Placeholder; resized below once the rest of the page is measured.
        out.push({ kind: "gap", dots: 0, fill: true });
        break;

      case "items":
        throw new Error("ItemsSection is not implemented — see spec §3.2");
    }
  }

  return resolveFill(out, template.heightMm);
}

/** Printed height of one laid-out line, in printer dots. */
export function lineHeightDots(line: LayoutLine): number {
  if (line.kind === "image") return ASSET_SIZE[line.assetId as AssetId]?.height ?? 0;
  if (line.kind === "feed") return line.lines * LINE_DOTS;
  if (line.kind === "gap") return line.dots;
  return lineDots(line.size);
}

/** Total printed height, in dots. */
export function layoutHeightDots(lines: LayoutLine[]): number {
  return lines.reduce((n, l) => n + lineHeightDots(l), 0);
}

/**
 * Grow the fill line so the page ends up exactly heightMm tall.
 *
 * If the content already overruns - a long project name that wrapped, say - the
 * fill goes to zero and the receipt is simply taller. Losing a line to hit a
 * height target would be worse than a receipt that does not tear where expected.
 */
function resolveFill(lines: LayoutLine[], heightMm: number): LayoutLine[] {
  const fillIndex = lines.findIndex((l) => l.kind === "gap" && l.fill);
  if (fillIndex === -1) return lines;
  // In dots, not whole lines, so the closing divider lands exactly on the mark.
  const spare = Math.max(0, heightMm * DOTS_PER_MM - layoutHeightDots(lines));
  return lines.map((l, i) => (i === fillIndex ? { ...l, dots: spare } : l));
}

/**
 * Free text for /blank: each line printed as typed, left-aligned, Font A. No
 * template around it and no fixed height; long lines wrap like everything else.
 */
export function blankLayout(text: string, target: Target): LayoutLine[] {
  const sections = text.replace(/\r/g, "").split("\n").map((content) => ({ type: "text", content }));
  return layout(templateSchema.parse({ id: "blank", name: "Blank", paperWidth: 58, sections }), {}, target);
}
