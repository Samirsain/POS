# Thermal Receipt Printing System — Build Specification v2

**Status:** Supersedes v1 (`POS_Thermal_Printing_System_Claude_Spec.md`)
**Scope:** Single receipt template, print-first. Deliberately narrower than v1.
**Printer:** 58mm ESC/POS thermal printer, firmware `DNT-585-LU5325` (sold as HOP-H58)
**Primary transport:** Bluetooth Classic (SPP)
**Stack:** Next.js + TypeScript, Tailwind, shadcn/ui, Supabase, Node.js print agent

---

## 0. What changed from v1, and why

v1 specified a general-purpose POS system with a drag-and-drop visual template
builder, four built-in templates, multi-printer support, role-based access and a
Windows installer. That scope is not justified by the current requirement, which
is **one receipt format**, with a second format not yet defined.

Designing a template abstraction against a single known instance produces the
wrong abstraction. This specification therefore keeps the part that is cheap and
provides real extensibility (a JSON template model plus a renderer) and removes
the part that is expensive and provides only convenience (the visual builder).

Removed from scope for this build:

- Drag-and-drop template builder and per-section configuration panels
- GST invoice, payment receipt and simple receipt built-in templates
- Multi-printer management and printer pairing UI
- Role-based access control
- Windows installer and auto-start
- Cash drawer support

Retained: the JSON template model, the ESC/POS layer, the print agent, the print
queue, and the accuracy and reliability rules.

Template layout editing is delivered as a **validated JSON editor**, not a visual
builder. Revisit the builder only after the JSON has been edited in anger several
times and the required controls are known from evidence rather than guesswork.

---

## 1. Verified hardware constraints

These were read from the printer's own self-test output. They are facts about
this device, not assumptions. **Do not override them with values from a
datasheet.**

| Property | Value |
| --- | --- |
| Firmware version | `DNT-585-LU5325` |
| Print speed | 90 mm/s max |
| Printable width | 384 dots |
| Font A width | **32 characters per line** |
| Font B width | **42 characters per line** |
| Interfaces | USB and Bluetooth Classic |
| Bluetooth PIN | `1234` |
| Bluetooth MAC | `DC:0D:30:59:51:A9` |
| Default code page | Page 0 (PC437) |
| Default font | Font A |
| Print density | Level 2 (default) |
| Character sets supported | Simplified Chinese (GB18030), Alphanumeric |
| 1D barcodes supported | UPC-A, UPC-E, EAN13, EAN8, CODE39, ITF, CODE93, CODE128, CODABAR |

### 1.1 Character set limitations — hard constraints

The printer supports **no Devanagari and no Unicode**. The self-test lists over
ninety code pages; none contains Devanagari, and none contains the Indian Rupee
sign `₹` (U+20B9).

Two consequences that shape the whole design:

1. **`ॐ` cannot be sent as text.** It must be printed as a raster bitmap.
2. **`₹` cannot be sent as text.** Amounts must render as `Rs.` in printed
   output.

Any implementation that writes these characters into the byte stream is wrong,
regardless of how it renders in the browser preview.

### 1.2 Unverified capabilities

Do not assume these work. Implement behind a config flag, default off, and
provide a test procedure:

| Capability | Status | Required action |
| --- | --- | --- |
| QR code (`GS ( k`) | Not listed in self-test | Always render QR as a raster bitmap instead. Native command is an optional optimisation only. |
| Auto-cutter (`GS V`) | Not listed | Default off. Feed 4 lines before tear instead. |
| Cash drawer pulse | Not listed | Out of scope for this build. |
| Font B `$` glyph | Suspect | See §1.3. |

### 1.3 Font B character test — required before layout work

In the self-test character dump, the `$` position (0x24) renders correctly in
Font A lines but appears as `¥` in Font B lines.

Before building the layout engine, run a test print containing `$100` and
`Rs. 100` in both Font A and Font B, with `ESC R 0` (international character set
= USA) explicitly set. Record the result in `docs/printer-verification.md`.

If Font B substitutes characters unpredictably, restrict Font B to plain
alphanumeric label/value rows and keep all amount lines in Font A.

---

## 2. Architecture

Browser JavaScript cannot reach this printer. Web Bluetooth supports BLE only;
this device is Bluetooth Classic with SPP. A local agent is mandatory, not a
preference.

```text
┌─────────────────────┐
│     Next.js App     │  Receipt entry, preview, history,
│                     │  template JSON editor, settings
└──────────┬──────────┘
           │  HTTPS → localhost agent API (token-authenticated)
           ▼
┌─────────────────────┐
│    Print Agent      │  Node.js. Transport, ESC/POS
│    (Node.js)        │  encoding, sequential queue,
│                     │  bitmap cache, heartbeat
└──────────┬──────────┘
           │  Bluetooth SPP (virtual COM) or USB
           ▼
┌─────────────────────┐
│  DNT-585 / HOP-H58  │
└─────────────────────┘
```

The agent owns all printer state. The web app never reports a printer status it
did not receive from the agent.

---

## 3. Template model

Templates are JSON, stored in Supabase, validated with Zod on write and on
render.

```ts
interface ReceiptTemplate {
  id: string;
  name: string;
  paperWidth: 58;
  sections: TemplateSection[];
}

type TemplateSection =
  | ImageSection
  | TextSection
  | LabelValueSection
  | SplitRowSection
  | ItemsSection        // not used by template 1 — see §3.2
  | DividerSection
  | SpacerSection
  | FeedSection;

type Font = "A" | "B";
type Align = "left" | "center" | "right";

interface ImageSection {
  type: "image";
  assetId: string;      // resolves to a cached bitmap in the agent
  align: Align;
  widthDots: number;    // MUST be a multiple of 8
}

interface TextSection {
  type: "text";
  content: string;      // fixed text, edited by admin
  align: Align;
  font?: Font;
  bold?: boolean;
  size?: "normal" | "large";
}

interface LabelValueSection {
  type: "labelValue";
  label: string;        // fixed text
  field: string;        // runtime data key
  format?: "currency" | "date" | "text";
  font?: Font;
  bold?: boolean;
}

interface SplitRowSection {
  type: "splitRow";     // left-aligned and right-aligned on one line
  leftField: string;
  rightField: string;
  font?: Font;
}

interface DividerSection { type: "divider"; char?: string; font?: Font; }
interface SpacerSection  { type: "spacer"; lines: number; }
interface FeedSection    { type: "feed"; lines: number; }
```

### 3.1 The `content` / `field` distinction

This is the mechanism that satisfies both editing requirements without building
two separate systems:

- `content` and `label` hold **fixed text**. Changing them is a template edit,
  performed by an admin against the template JSON.
- `field` holds a **runtime data key**. Its value is supplied per print by the
  operator on the receipt entry form.

The receipt entry form is generated by scanning the template for `field` keys.
Adding a field to the template automatically adds an input to the form. Do not
hard-code the form.

### 3.2 `ItemsSection`

Template 1 does not use repeating item rows. Define the variant in the
discriminated union anyway and leave the renderer branch throwing
`NotImplementedError`.

Rationale: if the second template turns out to be a sales receipt or a GST
invoice, it will need N repeating rows with column alignment calculated against
the character grid. That is structurally different from `labelValue` rows.
Leaving room in the union now is cheap; refactoring the renderer later is not.

---

## 4. Template 1 — Plot Payment Receipt

### 4.1 Target output (32-column grid)

```text
        [ॐ  bitmap]

           RECEIPT
No. 0012      15-Sep-2026
--------------------------------
Project : Greenfield Enclave
Plot    : A-14
Name    : Rahul Sharma
--------------------------------
Amount  : Rs. 25,000
--------------------------------



Signature: ______________
```

### 4.2 Template JSON (seed this as the default template)

```json
{
  "id": "plot-payment-receipt",
  "name": "Plot Payment Receipt",
  "paperWidth": 58,
  "sections": [
    { "type": "image", "assetId": "om-logo", "align": "center", "widthDots": 96 },
    { "type": "text", "content": "RECEIPT", "align": "center", "bold": true, "size": "large" },
    { "type": "spacer", "lines": 1 },
    { "type": "splitRow", "leftField": "receiptNo", "rightField": "date", "font": "A" },
    { "type": "divider" },
    { "type": "labelValue", "label": "Project", "field": "projectName",  "font": "B" },
    { "type": "labelValue", "label": "Plot",    "field": "plotNo",       "font": "B" },
    { "type": "labelValue", "label": "Name",    "field": "customerName", "font": "B" },
    { "type": "divider" },
    { "type": "labelValue", "label": "Amount",  "field": "amount",
      "format": "currency", "bold": true, "font": "A" },
    { "type": "divider" },
    { "type": "spacer", "lines": 3 },
    { "type": "text", "content": "Signature: ______________", "align": "left" },
    { "type": "feed", "lines": 4 }
  ]
}
```

### 4.3 Runtime fields

| Field | Type | Notes |
| --- | --- | --- |
| `receiptNo` | string | See §9 — sequencing decision |
| `date` | date | Format `DD-MMM-YYYY` |
| `projectName` | string | Free text, may overflow — see §5.2 |
| `plotNo` | string | |
| `customerName` | string | |
| `amount` | integer | **Stored in paise.** See §6 |

---

## 5. Layout engine

A single layout engine produces the character grid. Both the browser preview and
the ESC/POS encoder consume its output. They must never lay out independently.

```ts
// Renders a template + data into an array of laid-out lines.
// The preview renders these lines as HTML; the encoder renders them as bytes.
function layout(template: ReceiptTemplate, data: ReceiptData): LayoutLine[];
```

### 5.1 Width rules

- Font A: 32 columns
- Font B: 42 columns
- Width is a property of the line's font, never a global constant

### 5.2 Overflow handling

`Project : <name>` will overflow 32 columns for realistic project names. Rules:

1. Render `labelValue` rows in Font B (42 columns) by default.
2. If the value still exceeds the available width, wrap onto continuation lines
   indented to align under the value column. Never truncate silently.
3. If §1.3 finds Font B unreliable, fall back to Font A with wrapping.

### 5.3 Divider

Full width of the current font, using `-`.

---

## 6. Money

Store amounts as **integer paise**. Never use floating point for totals.

Formatting is the renderer's responsibility, and differs by output target:

| Target | Output |
| --- | --- |
| Browser preview | `₹25,000` |
| ESC/POS bytes | `Rs. 25,000` |

Use Indian digit grouping (`₹1,25,000` / `Rs. 1,25,000`), not Western grouping.

This split is the only place where preview and print legitimately diverge, and it
exists because the hardware cannot represent the glyph. Implement it as a single
`formatCurrency(paise, target)` function so the divergence has exactly one home.

---

## 7. ESC/POS layer

### 7.1 Job preamble

Send explicitly at the start of every job. Do not rely on printer defaults —
the density and code page are user-modifiable via the vendor utility, and relying
on them causes silent breakage.

```text
ESC @        initialise
ESC t 0      select code page PC437
ESC R 0      international character set = USA
ESC M 0      Font A
ESC a 0      left align
```

### 7.2 Commands in use

| Purpose | Command |
| --- | --- |
| Alignment | `ESC a n` (0 left, 1 center, 2 right) |
| Font select | `ESC M n` (0 = A, 1 = B) |
| Bold | `ESC E n` |
| Double height/width | `GS ! n` |
| Raster bitmap | `GS v 0` |
| Feed n lines | `ESC d n` |

Encode text as CP437 bytes. Any character outside CP437 must be caught at
validation time and rejected with a clear error — never silently dropped.

### 7.3 Cut

Do not send `GS V`. End jobs with `ESC d 4` so the signature area clears the tear
bar. Leave a `autoCut` config flag defaulting to `false`.

---

## 8. Bitmap assets

### 8.1 The `ॐ` logo

- Pre-render **once** to a 1-bit monochrome bitmap, 96 dots wide
- Width must be a multiple of 8
- Cache in the agent, keyed by `assetId`; do not regenerate per print
- Ship as a build asset, not a runtime conversion

### 8.2 Bluetooth throughput constraint

Bluetooth SPP throughput is far below USB. A raster bitmap costs roughly fifty
times the bytes of the equivalent text.

**Rule: only the `ॐ` logo is a bitmap. Everything else is text.** Do not
rasterise the whole header block or the whole receipt — it will add seconds of
visible latency per print at the counter.

If QR codes are added later, budget for this: measure end-to-end print time
before and after.

---

## 9. Data model and the sequencing decision

### Decision required before Phase 1

This receipt records a money transfer and carries a handwritten signature. Two
possible postures:

**Option A — DB-backed record (recommended).** Receipts persist in Supabase.
`receiptNo` is generated by a Postgres sequence with a `UNIQUE` constraint, so
two concurrent operators cannot produce duplicate numbers. Gives an audit trail,
reprint capability, and a reconciliation path.

**Option B — print and forget.** No persistence. Operator types the receipt
number manually. Simpler, but duplicate numbers are inevitable with more than one
operator, and there is no record of what was issued.

Recommendation: Option A. A signed money receipt without a record is a
reconciliation problem waiting to happen, and the Supabase layer is already in
the stack. The rest of this specification assumes Option A.

### Tables

```sql
templates (
  id text primary key,
  name text not null,
  content jsonb not null,
  is_default boolean not null default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)

receipts (
  id uuid primary key default gen_random_uuid(),
  receipt_no text not null unique,
  template_id text not null references templates(id),
  data jsonb not null,           -- runtime field values
  amount_paise bigint not null,
  created_at timestamptz default now()
)

print_jobs (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null references receipts(id),
  status text not null,          -- PENDING | PRINTING | SUCCESS | FAILED | CANCELLED
  idempotency_key text not null unique,
  attempts int not null default 0,
  error text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)
```

The `idempotency_key` on `print_jobs` is what prevents duplicate physical
receipts. The agent rejects a job whose key it has already processed.

---

## 10. Screens

Four screens. No more.

| Screen | Contents |
| --- | --- |
| **New Receipt** | Form generated from template `field` keys; live 58mm preview; `Save & Print` |
| **Receipts** | List, search by receipt no / customer, reprint (creates a new job with a new idempotency key, and is logged as a reprint) |
| **Print Queue** | Job list with status, error text, manual retry |
| **Settings** | Template JSON editor (Zod-validated, with preview), agent connection, store details, `autoCut` flag |

Agent status indicator is persistent in the shell: `Agent: Online/Offline`,
`Printer: Connected/Disconnected`, last heartbeat.

---

## 11. Build phases

**Phase 0 — Hardware verification (do this first)**
Standalone Node script. Pair over Bluetooth, open the SPP port, send the §7.1
preamble plus a hardcoded version of the §4.1 receipt as raw bytes. Print the
`ॐ` bitmap. Run the §1.3 Font B test. Measure round-trip time.

Do not start Phase 1 until a physical receipt matching §4.1 has come out of the
printer. Record findings in `docs/printer-verification.md`.

**Phase 1 — Agent**
Node service, localhost API with token auth, BT SPP transport, USB transport,
sequential queue, idempotency, bitmap cache, heartbeat endpoint.

**Phase 2 — Layout engine and ESC/POS encoder**
`layout()` + encoder. Unit tests covering: 32/42 column widths, overflow
wrapping, Indian digit grouping, currency target switching, and rejection of
non-CP437 characters.

**Phase 3 — Web app**
Next.js, Supabase, template seeding, New Receipt form generated from fields,
preview rendering `LayoutLine[]`, print job creation.

**Phase 4 — Queue, history, settings**
Job list, retry, receipts list, reprint, JSON template editor.

---

## 12. Rules for the implementation

1. **Never emit `ॐ` or `₹` as text bytes.** Bitmap and `Rs.` respectively.
2. **Never hard-code a character count.** Width comes from the line's font.
3. Preview and print consume the same `LayoutLine[]`. No parallel layout logic.
4. Printer status originates from the agent only. Never synthesise it.
5. Never expose the Supabase service-role key to the browser.
6. Retries must go through the idempotency key. A retry must never be able to
   produce a second physical receipt for the same job.
7. Money is integer paise end to end. Totals are computed server-side.
8. Strict TypeScript. `any` requires a written justification in a comment.
9. When a hardware behaviour cannot be verified without the physical printer,
   implement the abstraction and write the manual test procedure. Do not report
   it as verified.
10. Reject, do not silently drop, characters the printer cannot represent.

---

## 13. Acceptance test

The build is functional when this completes end to end:

1. Agent starts and pairs with the printer over Bluetooth
2. Dashboard shows `Agent: Online`, `Printer: Connected`
3. Operator opens **New Receipt**
4. Form shows inputs for Project, Plot, Name, Amount, Date
5. Operator enters `Greenfield Enclave`, `A-14`, `Rahul Sharma`, `25000`
6. Preview shows the §4.1 layout with `₹25,000`
7. Operator clicks **Save & Print**
8. Receipt number is allocated from the DB sequence
9. Agent receives the job, encodes ESC/POS, prints
10. Physical receipt matches §4.1, with the `ॐ` bitmap and `Rs. 25,000`
11. Signature area clears the tear bar with usable blank space
12. Job status becomes `SUCCESS`; receipt appears in history
13. Clicking retry on a `SUCCESS` job does **not** produce a second receipt

---

## 14. Deferred

Not in this build. Revisit only when there is evidence of need:

Second template · visual template builder · repeating item rows · GST fields ·
QR codes · multi-printer · role-based access · Windows installer and auto-start ·
cash drawer · offline mode · WhatsApp sharing

The architecture must not block these, but none should be built now.
