/**
 * The checks that fail if the layout or the byte stream goes wrong.
 * Plain node:test — no framework, no fixtures.
 *
 *   npx tsx --test lib/receipt.test.ts     (or: npm test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_HEADER_SIZE,
  FONT_COLS,
  HEADER_SIZES,
  TEMPLATE,
  TEMPLATES,
  formatCurrency,
  formatDate,
  formatReceiptNo,
  amountToWords,
  headerBytes,
  layout,
  resolveTemplate,
  templateFields,
  colsAt,
  SIZE_SCALE,
  layoutHeightDots,
  DOTS_PER_MM,
  blankLayout,
} from "./receipt";
import { ASSET_SIZE } from "./asset-sizes";
import { ASSET_BITMAP } from "./asset-bitmaps";
import { encode, encodeText, UnprintableCharacterError } from "./escpos";

/** Every template, at every size — the combinations a user can actually pick. */
const everyVariant = Object.values(TEMPLATES).flatMap((t) =>
  HEADER_SIZES.map((size) => ({ name: `${t.id}/${size}`, template: resolveTemplate(t, size) })),
);

const sample = {
  receiptNo: "0012",
  date: "2026-09-15",
  projectCode: "GREENFIELD",
  plotNo: "A-14",
  customerName: "Rahul Sharma",
  amount: 2_500_000, // paise
};

test("Indian digit grouping, not Western", () => {
  assert.equal(formatCurrency(10_000, "print"), "Rs. 100");
  assert.equal(formatCurrency(2_500_000, "print"), "Rs. 25,000");
  assert.equal(formatCurrency(12_500_000, "print"), "Rs. 1,25,000");
  assert.equal(formatCurrency(100_000_000, "print"), "Rs. 10,00,000");
  assert.equal(formatCurrency(1_000_000_000, "print"), "Rs. 1,00,00,000");
});

test("preview and print differ only in the currency symbol", () => {
  assert.equal(formatCurrency(2_500_000, "preview"), "₹25,000");
  assert.equal(formatCurrency(2_500_000, "print"), "Rs. 25,000");
});

test("fractional paise are rejected rather than rounded silently", () => {
  assert.throws(() => formatCurrency(100.5, "print"), /integer paise/);
});

test("date renders DD-MMM-YYYY", () => {
  assert.equal(formatDate("2026-09-15"), "15-Sep-2026");
  assert.throws(() => formatDate("not a date"), /invalid date/);
});

test("the form is derived from the template, never hard-coded", () => {
  assert.deepEqual(templateFields(TEMPLATE), [
    "receiptNo",
    "date",
    "projectCode",
    "plotNo",
    "customerName",
    "amount",
  ]);
});

test("no laid-out line exceeds its own font width", () => {
  for (const line of layout(resolveTemplate(TEMPLATE, DEFAULT_HEADER_SIZE), sample, "print")) {
    if (line.kind !== "text") continue;
    assert.ok(
      line.text.length <= FONT_COLS[line.font],
      `"${line.text}" is ${line.text.length} cols, Font ${line.font} allows ${FONT_COLS[line.font]}`,
    );
  }
});

test("a long value wraps and is never truncated", () => {
  const longName = "Purushottam Venkataraman Subramaniam Iyer";
  const text = layout(resolveTemplate(TEMPLATE, DEFAULT_HEADER_SIZE), { ...sample, customerName: longName }, "print")
    .filter((l) => l.kind === "text")
    .map((l) => l.text)
    .join("\n");
  // Every word survives somewhere in the output.
  for (const word of longName.split(" ")) assert.ok(text.includes(word), `lost "${word}"`);
});

test("splitRow puts the date flush right on a 32-column line", () => {
  const line = layout(resolveTemplate(TEMPLATES.om, DEFAULT_HEADER_SIZE), sample, "print").find(
    (l) => l.kind === "text" && l.text.includes("15-Sep-2026"),
  );
  assert.ok(line && line.kind === "text");
  assert.equal(line.text.length, 32);
  assert.ok(line.text.startsWith("0012"));
  assert.ok(line.text.endsWith("15-Sep-2026"));
});

test("the rupee sign and om never reach the byte stream", () => {
  assert.throws(() => encodeText("₹25,000"), UnprintableCharacterError);
  assert.throws(() => encodeText("ॐ"), UnprintableCharacterError);
  assert.throws(() => encodeText("नमस्ते"), UnprintableCharacterError);
  // Rejected, not dropped (rule 10) — the message has to name the character.
  assert.throws(() => encodeText("₹"), /U\+20B9/);
});

test("printed bytes say Rs. and carry the om bitmap", () => {
  const bytes = encode(layout(resolveTemplate(TEMPLATES.om, DEFAULT_HEADER_SIZE), sample, "print"));
  const ascii = bytes.toString("latin1");
  assert.ok(ascii.includes("Rs. 25,000"));
  assert.ok(!ascii.includes("₹"));
  assert.ok(ascii.includes("\x1dv0"), "missing GS v 0 raster command");
  assert.ok(ascii.startsWith("\x1b@\x1bt\x00\x1bR\x00"), "preamble missing or out of order");
  assert.ok(ascii.endsWith("\x1bd\x04"), "job must end with ESC d 4, never GS V");
});

test("at most one raster per receipt, in every template and size", () => {
  for (const { name, template } of everyVariant) {
    const bytes = encode(layout(template, sample, "print"));
    const image = template.sections.find((s) => s.type === "image");
    const rasters = bytes.toString("latin1").split("\x1dv0").length - 1;
    assert.equal(
      rasters,
      image ? 1 : 0,
      `${name}: rasterising more than the heading costs seconds on Bluetooth`,
    );
    // Everything that is not the heading is plain text and must stay tiny.
    const heading = image ? ASSET_SIZE[image.assetId as keyof typeof ASSET_SIZE].bytes : 0;
    assert.ok(
      bytes.length - heading < 400,
      `${name}: ${bytes.length - heading} non-heading bytes, expected under 400`,
    );
  }
});

test("every generated bitmap declares the size it actually contains", () => {
  // Regression: PowerShell's [int] cast rounds, so a height of 184 produced a
  // high byte of 1 and told the printer to expect 440 rows of data.
  for (const [id, size] of Object.entries(ASSET_SIZE)) {
    const cmd = ASSET_BITMAP[id as keyof typeof ASSET_BITMAP];
    assert.deepEqual([...cmd.subarray(0, 4)], [0x1d, 0x76, 0x30, 0x00], `${id}: not a GS v 0 command`);
    const declaredWidth = (cmd[4] | (cmd[5] << 8)) * 8;
    const declaredHeight = cmd[6] | (cmd[7] << 8);
    assert.equal(declaredWidth, size.width, `${id}: width header disagrees`);
    assert.equal(declaredHeight, size.height, `${id}: height header disagrees`);
    assert.equal(
      cmd.length - 8,
      (size.width / 8) * size.height,
      `${id}: raster data length does not match the declared size`,
    );
  }
});

test("every bitmap heading exists at all three sizes, and bigger really is bigger", () => {
  const withBitmap = Object.values(TEMPLATES).filter((t) =>
    t.sections.some((s) => s.type === "image"),
  );
  assert.ok(withBitmap.length >= 2, "expected the Devanagari headings to be bitmaps");
  for (const template of withBitmap) {
    const [s, m, l] = HEADER_SIZES.map((size) => headerBytes(template, size));
    assert.ok(s < m && m < l, `${template.id}: sizes are not increasing (${s}, ${m}, ${l})`);
  }
});

test("every heading fits the 384-dot print head", () => {
  for (const { name, template } of everyVariant) {
    const image = template.sections.find((s) => s.type === "image");
    if (!image) continue; // a text heading has no dots to overflow
    assert.ok(image.widthDots, `${name}: heading has no width`);
    assert.ok(image.widthDots! <= 384, `${name}: ${image.widthDots} dots is wider than the paper`);
    assert.equal(image.widthDots! % 8, 0, `${name}: width must be a multiple of 8`);
  }
});

test("no line in any template overflows its font width", () => {
  for (const { name, template } of everyVariant) {
    for (const line of layout(template, sample, "print")) {
      if (line.kind !== "text") continue;
      assert.ok(
        line.text.length <= FONT_COLS[line.font],
        `${name}: "${line.text}" is ${line.text.length} cols, max ${FONT_COLS[line.font]}`,
      );
    }
  }
});

test("laying out an unresolved template fails loudly", () => {
  // Without resolveTemplate() there is no size, and silently picking one would
  // print a heading nobody chose.
  assert.throws(() => layout(TEMPLATES.om, sample, "print"), /call resolveTemplate/);
});

test("an unknown heading size is refused", () => {
  assert.throws(
    () => resolveTemplate(TEMPLATES.om, "xl" as unknown as typeof DEFAULT_HEADER_SIZE),
    /no xl variant/,
  );
});

test("amount in words, Indian system", () => {
  assert.equal(amountToWords(2_500_000), "Twenty Five Thousand Rupees Only");
  assert.equal(amountToWords(12_500_000), "One Lakh Twenty Five Thousand Rupees Only");
  assert.equal(amountToWords(100), "One Rupee Only");
  assert.equal(amountToWords(1_00_00_00_000), "One Crore Rupees Only");
  assert.equal(amountToWords(10_150), "One Hundred One Rupees and Fifty Paise Only");
  assert.equal(amountToWords(101), "One Rupee and One Paisa Only");
  assert.equal(amountToWords(1_900), "Nineteen Rupees Only");
  assert.equal(amountToWords(0), "Zero Rupees Only");
  assert.throws(() => amountToWords(-100), /negative/);
  assert.throws(() => amountToWords(1.5), /integer paise/);
});

test("printed receipt numbers are six plain digits", () => {
  assert.equal(formatReceiptNo("128"), "000128");
  assert.equal(formatReceiptNo("0012"), "000012");
  assert.equal(formatReceiptNo("1234567"), "1234567");
});

test("the detailed template matches the agreed layout", () => {
  const lines = layout(resolveTemplate(TEMPLATES.detailed, "m"), sample, "print").filter(
    (l) => l.kind === "text",
  );
  const find = (needle: string) => lines.find((l) => l.text.includes(needle));

  // Alignment as drawn in the design, line by line.
  assert.equal(find("SHRI GANESHAY NAMAH")?.align, "center");
  assert.equal(find("SHRI GANESHAY NAMAH")?.bold, true);
  assert.equal(find("Receipt No.")?.align, "left");
  assert.equal(find("Date")?.align, "left");
  assert.equal(find("GREENFIELD")?.align, "center");
  assert.equal(find("A-14")?.align, "center");
  assert.equal(find("Rahul Sharma")?.align, "center");
  assert.equal(find("Rs. 25,000")?.align, "center");
  assert.equal(find("Twenty Five Thousand Rupees Only")?.align, "center");
  assert.equal(find("Signature"), undefined, "the signature line was removed");
  assert.ok(find("000012"), "receipt number is not formatted");
});

test("the heading is English text, so this template carries no bitmap", () => {
  const heading = layout(resolveTemplate(TEMPLATES.detailed, "m"), sample, "print").find(
    (l) => l.kind === "text" && l.text.includes("GANESHAY"),
  );
  assert.ok(heading?.kind === "text", "the heading must be a text line, not an image");
  // Every character has to survive CP437 or it could not be text at all.
  assert.doesNotThrow(() => encodeText(heading.text));
});

test("the label column keeps its colons in one column", () => {
  const lines = layout(resolveTemplate(TEMPLATES.detailed, "m"), sample, "print").filter(
    (l) => l.kind === "text",
  );
  const no = lines.find((l) => l.text.includes("Receipt No."))!;
  const date = lines.find((l) => l.text.startsWith("Date"))!;
  assert.equal(no.text.indexOf(":"), date.text.indexOf(":"), "colons are in different columns");
  assert.equal(no.align, "left");
  assert.equal(date.align, "left");
});

test("the detailed template needs no bitmap at all", () => {
  const bytes = encode(layout(resolveTemplate(TEMPLATES.detailed, "m"), sample, "print"));
  assert.ok(!bytes.toString("latin1").includes("\x1dv0"), "unexpected raster");
  assert.ok(bytes.length < 400, `${bytes.length} bytes, expected under 400`);
  assert.equal(headerBytes(TEMPLATES.detailed, "m"), 0);
});

test("the box-drawing divider encodes to CP437, not a dropped character", () => {
  // U+2500 is 0xC4 in CP437. If this ever throws, the divider silently vanishes.
  assert.deepEqual([...encodeText("──")], [0xc4, 0xc4]);
});

test("an unknown image asset throws instead of printing a gap", () => {
  assert.throws(
    () => encode([{ kind: "image", assetId: "nope", align: "center", widthDots: 96 }]),
    /unknown image asset/,
  );
});

test("CP437 accented characters still print", () => {
  assert.deepEqual([...encodeText("café")], [0x63, 0x61, 0x66, 0x82]);
});

test("the unimplemented items section throws instead of printing nothing", () => {
  assert.throws(
    () =>
      layout({ ...TEMPLATE, sections: [{ type: "items", field: "lines" }] }, sample, "print"),
    /not implemented/,
  );
});

test("the size hierarchy matches the reference: amount > name/plot/project > body", () => {
  for (const { name, template } of everyVariant) {
    const lines = layout(template, sample, "print").filter((l) => l.kind === "text");

    for (const needle of ["GREENFIELD", "A-14", "Rahul Sharma"]) {
      const line = lines.find((l) => l.text.includes(needle));
      assert.ok(line, `${name}: "${needle}" is missing`);
      assert.equal(line.size, "large", `${name}: "${needle}" should be 2x`);
      assert.equal(line.bold, true, `${name}: "${needle}" should be bold`);
    }

    const amount = lines.find((l) => l.text.includes("Rs. 25,000"))!;
    assert.equal(amount.size, "xlarge", `${name}: the amount should be the largest line`);
    assert.equal(amount.bold, true);

    // Body text — labels, dividers, the words — stays at 1x.
    const body = lines.find((l) => l.text.includes("Twenty Five Thousand"))!;
    assert.equal(body.size, "normal", `${name}: the words block must stay at 1x`);
    assert.ok(
      SIZE_SCALE[amount.size] > SIZE_SCALE["large"] && SIZE_SCALE["large"] > SIZE_SCALE[body.size],
      `${name}: hierarchy is not strictly increasing`,
    );
  }
});

test("an amount too long for 3x steps down instead of wrapping", () => {
  const sizeOf = (amount: number) =>
    layout(resolveTemplate(TEMPLATES.detailed, "m"), { ...sample, amount }, "print")
      .filter((l) => l.kind === "text")
      .filter((l) => l.text.startsWith("Rs. "));

  // Up to ten characters fits at 3x.
  assert.deepEqual(sizeOf(2_500_000).map((l) => [l.text, l.size]), [["Rs. 25,000", "xlarge"]]);
  // Sixteen characters only fits at 2x — one line, not two.
  assert.deepEqual(
    sizeOf(12_32_33_434_00).map((l) => [l.text, l.size]),
    [["Rs. 12,32,33,434", "large"]],
  );
});

test("no size stretches text: width and height always scale together", () => {
  // GS ! n is (widthMultiplier-1) << 4 | (heightMultiplier-1). Equal nibbles
  // mean equal scaling; 0x01 would be the forbidden height-only stretch.
  for (const [size, scale] of Object.entries(SIZE_SCALE)) {
    const bytes = encode([
      { kind: "text", text: "X", font: "A", align: "left", bold: false, size: size as never },
    ]).toString("latin1");
    const at = bytes.indexOf("!");
    if (scale === 1) { assert.equal(at, -1, "normal needs no GS !"); continue; }
    const n = bytes.charCodeAt(at + 2);
    assert.equal(n >> 4, n & 0x0f, `${size}: width and height multipliers differ - that is a stretch`);
    assert.equal((n >> 4) + 1, scale, `${size}: wrong multiplier`);
  }
});

test("bigger glyphs mean fewer columns", () => {
  assert.equal(colsAt(32, "normal"), 32);
  assert.equal(colsAt(32, "large"), 16);
  assert.equal(colsAt(32, "xlarge"), 10);
});

test("each size emits the right GS ! command", () => {
  const of = (size: "normal" | "large" | "xlarge") =>
    encode([{ kind: "text", text: "X", font: "A", align: "left", bold: false, size }]).toString(
      "latin1",
    );
  assert.ok(!of("normal").includes("\x1d!"), "normal should not need GS !");
  assert.ok(of("large").includes("\x1d!\x11"), "large must be GS ! 0x11 — 2x2");
  assert.ok(of("xlarge").includes("\x1d!\x22"), "xlarge must be GS ! 0x22 — 3x3");
  // Spacing has to grow with the glyph or the next line prints through it.
  assert.ok(of("large").includes("\x1b3\x38"), "large must set ESC 3 56");
  assert.ok(of("xlarge").includes("\x1b3\x50"), "xlarge must set ESC 3 80");
  // And the printer is left unscaled for whatever prints next.
  assert.ok(of("large").includes("\x1d!\x00"), "the printer must be left unscaled");
});

test("an overlong line is refused rather than silently clipped", () => {
  assert.throws(
    () =>
      encode([
        { kind: "text", text: "x".repeat(33), font: "A", align: "left", bold: false, size: "normal" },
      ]),
    /exceeds Font A normal width 32/,
  );
});

/** Templates whose heading is text or a thin strip, so they always fit 80mm. */
const fitting = everyVariant.filter(({ name }) => !name.startsWith("om/"));

test("every receipt is exactly 80mm tall", () => {
  for (const { name, template } of fitting) {
    const dots = layoutHeightDots(layout(template, sample, "print"));
    assert.equal(dots, 80 * DOTS_PER_MM, `${name}: ${dots / DOTS_PER_MM}mm, expected 80mm`);
  }
});

test("the closing divider is the last printed line", () => {
  for (const { name, template } of everyVariant) {
    const text = layout(template, sample, "print").filter((l) => l.kind === "text");
    assert.ok(
      /^[-─]+$/.test(text[text.length - 1].text),
      `${name}: last printed line is not a divider`,
    );
  }
});

test("a long amount in words does not push the divider off the page", () => {
  // Twelve crore: three wrapped lines of words instead of one.
  const big = { ...sample, amount: 12_32_33_434_00 };

  // The designed template has no bitmap, so it always has room to absorb this.
  const detailed = layout(resolveTemplate(TEMPLATES.detailed, "m"), big, "print");
  assert.equal(layoutHeightDots(detailed), 80 * DOTS_PER_MM, "detailed: the fill did not absorb it");

  for (const { name, template } of everyVariant) {
    const lines = layout(template, big, "print");
    // A Devanagari heading can be 184 dots tall; at the largest size, with a
    // crore-sized amount, the page genuinely will not fit in 90mm. It grows
    // rather than losing a line — but the divider is still last on the page.
    assert.ok(
      layoutHeightDots(lines) >= 80 * DOTS_PER_MM,
      `${name}: shorter than the fixed height`,
    );
    const text = lines.filter((l) => l.kind === "text");
    assert.ok(/^[-─]+$/.test(text[text.length - 1].text), `${name}: divider moved`);
  }
});

test("only the square om heading pushes past 80mm", () => {
  // Pinned down here rather than discovered on paper. The om glyph is square, so
  // at Small/Medium/Large it eats 12/18/23mm of the page on its own; the
  // Devanagari phrase is a thin strip and the text heading costs one line.
  const big = { ...sample, amount: 12_32_33_434_00 };
  const over = everyVariant
    .map(({ name, template }) => ({
      name,
      mm: layoutHeightDots(layout(template, big, "print")) / DOTS_PER_MM,
    }))
    .filter((r) => r.mm > 80);
  assert.deepEqual(
    over,
    [
      { name: "om/m", mm: 83 },
      { name: "om/l", mm: 88 },
    ],
    `overflow set changed: ${over.map((r) => `${r.name} ${r.mm}mm`).join(", ") || "none"}`,
  );
});

test("a huge amount shrinks to fit instead of wrapping", () => {
  const lines = layout(resolveTemplate(TEMPLATES.detailed, "m"), { ...sample, amount: 12_32_33_434_00 }, "print")
    .filter((l) => l.kind === "text");
  const amount = lines.find((l) => l.text.includes("12,32,33,434"));
  assert.ok(amount, "the amount was wrapped or lost");
  assert.equal(amount.text, "Rs. 12,32,33,434");
  // Asked for xlarge (10 columns); sixteen characters only fit at large.
  assert.equal(amount.size, "large");
});

test("amount in words wraps naturally, never stretched or cut", () => {
  const lines = layout(resolveTemplate(TEMPLATES.detailed, "m"), { ...sample, amount: 12_32_33_434_00 }, "print")
    .filter((l) => l.kind === "text");
  const words = amountToWords(12_32_33_434_00);
  const printed = lines.filter((l) => words.includes(l.text.trim()) && l.text.trim()).map((l) => l.text.trim());
  assert.equal(printed.join(" "), words);
  for (const l of lines) assert.ok(l.text.length <= colsAt(32, l.size), `"${l.text}" overflows`);
});

test("blankLayout prints each line as typed, wrapping long ones", () => {
  const lines = blankLayout("hello\n\n" + "x".repeat(40), "print");
  const texts = lines.map((l) => (l.kind === "text" ? l.text : null));
  assert.deepEqual(texts, ["hello", "", "x".repeat(32), "x".repeat(8)]);
  assert.ok(encode(lines).length > 0);
});
