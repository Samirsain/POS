import {
  DOTS_PER_MM,
  FONT_COLS,
  LINE_DOTS,
  SIZE_SCALE,
  lineDots,
  type LayoutLine,
} from "@/lib/receipt";

/** The 58mm head is 384 dots across, which is what widthDots is measured in. */
const PAPER_DOTS = 384;
const MM_PER_DOT = 1 / DOTS_PER_MM;

/**
 * What each image asset looks like on screen. The browser has Devanagari fonts,
 * so the preview draws the real character — sharper than showing the 1-bit
 * raster, and it is the same glyph the bitmap was rendered from.
 *
 * The paper still gets the raster: the printer has no Devanagari and no Unicode,
 * so dot data is the only way the symbol can physically appear (§1.1). That
 * makes this the one place the preview is a redrawing rather than a copy — tune
 * the printed weight with `npm run bitmap -- -Threshold n`, not from here.
 */
const ASSET_GLYPH: Record<string, string> = {
  "om-logo": "ॐ",
  ganesh: "श्री गणेशाय नमः",
};

/** Assets carry a "-s"/"-m"/"-l" suffix once resolved; the glyph is the same. */
const glyphFor = (assetId: string) =>
  ASSET_GLYPH[assetId] ?? ASSET_GLYPH[assetId.replace(/-[sml]$/, "")];

/**
 * Renders the same LayoutLine[] the printer gets (rule 3). The only difference
 * is the rupee sign, which layout() substitutes by target because the hardware
 * has no glyph for it (§6).
 *
 * Fixed character cells, not a proportional font — a preview that does not show
 * the real column grid is worse than no preview.
 */
export default function Preview({ lines }: { lines: LayoutLine[] }) {
  return (
    <div className="inline-block bg-white px-3 shadow-[0_1px_4px_rgba(0,0,0,0.15)]">
      <div className="font-mono text-[13px] whitespace-pre">
        {lines.map((line, i) => {
          if (line.kind === "image") {
            const glyph = glyphFor(line.assetId);
            // ch units are the monospace cell width, so the glyph scales with the
            // character grid instead of drifting away from it at other sizes.
            // A phrase is many glyphs wide, so it needs a smaller em than a
            // single symbol occupying the same dots.
            const cells = (line.widthDots / PAPER_DOTS) * FONT_COLS.A;
            const size = `${glyph && glyph.length > 1 ? cells / glyph.length : cells}ch`;
            return (
              <div
                key={i}
                className="py-1 leading-none"
                style={{
                  textAlign: line.align,
                  fontSize: size,
                  fontFamily: '"Nirmala UI", "Noto Sans Devanagari", Mangal, sans-serif',
                }}
              >
                {glyph ?? `[${line.assetId}]`}
              </div>
            );
          }
          if (line.kind === "feed") {
            return <div key={i} style={{ height: `${line.lines * LINE_DOTS * MM_PER_DOT}mm` }} />;
          }
          if (line.kind === "gap") {
            return <div key={i} style={{ height: `${line.dots * MM_PER_DOT}mm` }} />;
          }
          const cols = FONT_COLS[line.font];
          // Scale so both fonts show their true width against the 58mm paper,
          // then multiply by the glyph scale. Width and height together — the
          // printed text is never stretched, so the preview must not be either.
          const base = (32 / cols) * 13;
          return (
            <div
              key={i}
              className={line.bold ? "font-bold" : undefined}
              style={{
                textAlign: line.align,
                fontSize: base * SIZE_SCALE[line.size],
                // Match the printer's own line spacing, in millimetres of paper.
                height: `${lineDots(line.size) * MM_PER_DOT}mm`,
                lineHeight: `${lineDots(line.size) * MM_PER_DOT}mm`,
              }}
            >
              {line.text === "" ? " " : line.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
