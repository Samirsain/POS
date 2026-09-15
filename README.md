# Plot Receipt Printing

Staff open a hosted web page, type four fields, press Print, and a 58mm thermal
receipt comes out of the printer in the office.

Built to `POS_Thermal_Printing_Build_Spec_v2.md`. Read that first — it holds the
verified hardware facts and the rules this code follows.

## How the pieces fit

```
Browser (anywhere)                Vercel                        Office PC
──────────────────                ──────                        ─────────
form + live preview  ──POST──▶  Next.js server                 print agent
                                 · allocates receipt no.         · claims a job
                                 · layout() → ESC/POS bytes      · writes bytes
                                 · queues the job                  to COM3
                                        │                              │
                                        └────── Supabase ──────────────┘
                                              receipts · print_jobs
```

**The agent pulls, it never listens.** No port forwarding, no firewall change,
no inbound connection to the office. It also means staff can print from a phone.

**The agent is deliberately dumb.** The server builds the finished bytes; the
agent writes them to a serial port and reports back. It is ~150 lines and
almost never needs updating — which matters on a PC you cannot redeploy to.

**One layout implementation.** `lib/receipt.ts` `layout()` produces the lines;
the browser preview and the ESC/POS encoder both consume them. The only
permitted divergence is the rupee sign, because the printer has no glyph for it
(`₹` on screen, `Rs.` on paper).

## Setup

### 1. Supabase

Create a project at supabase.com, then run `supabase/migrations/0001_init.sql`
in the SQL editor. From **Settings → API** take the project URL and the
**service-role** key.

If you are continuing an existing receipt book, change `start with 12` in the
migration to your last used number before running it.

### 2. Vercel

Import the repo and set two environment variables:

| | |
| --- | --- |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role key |

There are **no user accounts** — anyone with the URL can print. If you want a
gate, set `ACCESS_CODE` to any string and open `https://<site>/?code=<string>`
once per device.

### 3. The agent, on the office PC

The printer must already be paired over Bluetooth (PIN `1234`, MAC
`DC:0D:30:59:51:A9`) so Windows has given it an outgoing COM port.

```
copy agent\.env.example agent\.env      # then fill in the same Supabase values
npm install
node agent\index.mjs --list             # marks which port is the printer
npm run agent
```

**The port is found by MAC, not by number.** This laptop has four Bluetooth SPP
ports and only one of them is the printer (COM9 at the time of writing) — the
others belong to headsets and to Windows itself, and writing ESC/POS to those
would be worse than printing nothing. Windows also renumbers these ports after a
re-pair or a reboot, so `PRINTER_PORT` is left blank and `PRINTER_MAC` does the
work. Set `PRINTER_PORT` only to force a specific port.

Leave it running. The site header shows `Agent: Online` within five seconds.

To start it automatically at login: Win+R → `shell:startup` → put a shortcut to
`npm run agent` there, with the project folder as **Start in**.

## Daily use

- **New Receipt** — pick a heading, pick its size, fill four fields, Print. The
  receipt number is allocated by the database; expand the summary line to set
  one manually.
- **Queue** — every job with its status. `Retry` re-queues a failed job.
  `Reprint` makes a deliberate second copy and is logged as one.

Retrying a `SUCCESS` job is refused by the server, so no retry can ever produce
a second physical receipt.

## Development

```
npm run dev         # http://localhost:3000
npm test            # layout, money, and byte-level checks
npm run typecheck
npm run check       # both
```

### Hardware work

```
npm run print-test          # Phase 0: raw test print, no app involved
npm run bitmap              # re-render every phase0/assets/*.txt (-Threshold to tune weight)
npm run inline-bitmap       # push the results into lib/
```

Results go in `docs/printer-verification.md`.

## Known ceilings

- **Font B is unverified.** `DEFAULT_FONT` in `lib/receipt.ts` is `"A"` (32
  columns) because the self-test printed `¥` where `$` was expected. Long names
  wrap at 32 instead of 42 until `docs/printer-verification.md` says otherwise.
- **One printer.** The agent claims from a single queue. Multiple printers need
  a device id on the job.
- **Templates are code, not data.** Changing the wording is a deploy. Move them
  to a table when someone needs to change it without shipping.
- **Headings are pre-rendered rasters.** ESC/POS cannot scale a bitmap, so each
  heading is rendered at three fixed widths and the size control picks one.
  Adding a size means editing the fractions in `phase0/make-bitmaps.ps1`.
- **No auto-cut.** `GS V` is not in the self-test, so jobs end with `ESC d 4`
  and the paper is torn by hand.

## Headings

Devanagari cannot be sent to this printer as text — it has no Unicode and no
Devanagari code page (§1.1), so `ॐ` or `श्री गणेशाय नमः` as characters would
come out as garbage. Every heading is therefore a 1-bit raster rendered at build
time from a plain text file:

```
phase0/assets/om-logo@192.txt     ॐ
phase0/assets/ganesh@360.txt      श्री गणेशाय नमः
```

The number after `@` is the Large width in dots (max 384, the print head).
`npm run bitmap` renders each file at 50% / 75% / 100% of that — the `-s`, `-m`
and `-l` assets the size control chooses between — and writes a `.png` beside
each so the weight can be checked before printing. Then `npm run inline-bitmap`
inlines them into `lib/`.

To add a heading: drop a new `<name>@<width>.txt` in `phase0/assets`, run both
commands, and add an entry to `TEMPLATES` in `lib/receipt.ts`.

**The heading is nearly the whole receipt.** Everything else is under 300 bytes;
the heading ranges from 712 to 4424. On Bluetooth that is the entire wait, which
is why the size control shows the byte count next to it.

| | Small | Medium | Large |
| --- | --- | --- | --- |
| ॐ | 1,160 | 2,600 | 4,424 |
| श्री गणेशाय नमः | 712 | 1,592 | 2,888 |
