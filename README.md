# Plot Receipt Printing

Staff open a hosted web page, type four fields, press Print, and a 58mm thermal
receipt comes out of the printer in the office.

Built to `POS_Thermal_Printing_Build_Spec_v2.md`. Read that first — it holds the
verified hardware facts and the rules this code follows.

## How the pieces fit

```
Browser (anywhere)                Vercel                        Office PC
──────────────────                ──────                        ─────────
form + live preview  ──POST──▶  Next.js server                 connector
                                 · allocates receipt no.         · claims a job
                                 · layout() → ESC/POS bytes      · writes bytes
                                 · queues the job                  to COM9
                                        │                              │
                                        └────── Supabase ──────────────┘
                                              receipts · print_jobs
```

**The connector is for receipts printed from somewhere else.** If the printer is
in front of you, the browser drives it directly and none of the above runs: an
Android phone hands the bytes to RawBT over Bluetooth, a laptop pushes them down
the USB cable through WebUSB. The connector is what an iPhone, a Firefox, or
someone in another building uses.

**The connector pulls, it never listens.** No port forwarding, no firewall change,
no inbound connection to the office.

**The connector is deliberately dumb.** The server builds the finished bytes; the
it writes them to a serial port and reports back. It is ~300 lines and
almost never needs updating — which matters on a PC you cannot redeploy to.

**One layout implementation.** `lib/receipt.ts` `layout()` produces the lines;
the browser preview and the ESC/POS encoder both consume them. The only
permitted divergence is the rupee sign, because the printer has no glyph for it
(`₹` on screen, `Rs.` on paper).

## Setup

### 1. Supabase

Create a project at supabase.com, then apply every file in
`supabase/migrations/` in order — paste them into the SQL editor, or set
`DATABASE_URL` to the connection string and run `npm run db:migrate`. They are
safe to re-run. From **Settings → API** take the project URL and the
**service-role** key.

If you are continuing an existing receipt book, run
`select setval('receipt_no_seq', <last used number>);` afterwards.

### 2. Vercel

Import the repo and set two environment variables:

| | |
| --- | --- |
| `SUPABASE_URL` | `https://<ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | the service-role key |

There are **no user accounts** — anyone with the URL can print. If you want a
gate, set `ACCESS_CODE` to any string and open `https://<site>/?code=<string>`
once per device.

### 3. The connector, on the office PC

The printer must already be paired over Bluetooth (PIN `1234`, MAC
`DC:0D:30:59:51:A9`) so Windows has given it an outgoing COM port.

```
cd connector
npm install
npm run build:connector      # from the project root
```

That writes `dist/POS Printer Connector/`. Copy the whole folder to the
office PC, then:

1. edit `connector.env` with the two Supabase values
2. double-click **Start Printer Connector.vbs** — it runs with no window
3. run **Run at startup.cmd** once, so it comes back after a reboot

`connector.log` beside it says what happened. `node connector.js --ports`
lists serial ports and `--test` prints a slip.

**Not a single .exe, deliberately.** Node's single-executable format works by
injecting into `node.exe`, which invalidates its Authenticode signature, and
Windows Smart App Control then blocks the result outright. The signed
`node.exe` therefore ships untouched with the script beside it. Same result
for the user: one folder, one file to double-click, no Node install, no npm.

**The port is found by MAC, not by number.** This laptop has four Bluetooth
SPP ports and only one is the printer (COM9 at the time of writing) — the
others belong to headsets and to Windows itself, and writing ESC/POS to those
would be worse than printing nothing. Windows also renumbers these after a
re-pair or a reboot, so `PRINTER_PORT` is left blank and `PRINTER_MAC` does
the work.

## Daily use

- **New Receipt** — four fields, live preview, Print. The receipt number is
  allocated by the database (six digits: `000001`, `000002`, …), so two people
  printing at the same moment cannot collide. Project, plot and name are forced
  to capitals as you type.
- **Queue** — every job with its status. `Retry` re-queues a failed job.
  `Reprint` makes a deliberate second copy and is logged as one.
- **On Android** the first button is *Print on this phone*. The phone drives the
  printer itself over Bluetooth through [RawBT](https://rawbt.ru), so no laptop
  and no connector need to be running. Pair the printer once in Android's
  Bluetooth settings; the first print offers the RawBT install.
- **On a laptop** the first button is *Print on the USB printer*. Plug the
  printer in with the cable, press *Connect the USB printer* once and pick it
  from Chrome's list — a green dot then says it is connected and every Print
  after that goes straight to paper. Chrome remembers the choice across reloads
  and reboots, and the dot goes out if the cable is pulled. No connector, and it
  works on any laptop, not just the office one.
- **On iPhone, or in Firefox and Safari** the office connector is the only route
  to this printer — see *Known ceilings*.

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
- **One printer.** The connector claims from a single queue. Multiple printers need
  a device id on the job.
- **Templates are code, not data.** Changing the wording is a deploy. Move them
  to a table when someone needs to change it without shipping.
- **One layout, chosen in code.** `DEFAULT_TEMPLATE_ID` in `lib/receipt.ts`
  picks it. The ॐ and श्री गणेशाय नमः headings still exist and the API still
  accepts them; there is just no control for them at the counter.
- **Headings are pre-rendered rasters.** ESC/POS cannot scale a bitmap, so each
  is rendered at three fixed widths. Adding a size means editing the fractions
  in `phase0/make-bitmaps.ps1`.
- **The fixed 80mm height is unverified.** It relies on `ESC 3` (line spacing)
  and `ESC J` (feed n dots), neither of which appears in the self-test. Measure
  the first print with a ruler before trusting it.
- **No auto-cut.** `GS V` is not in the self-test, so jobs end with `ESC d 4`
  and the paper is torn by hand.
- **USB printing needs Chrome or Edge.** WebUSB exists in neither Firefox nor
  Safari and is not coming, so those browsers get the office connector button
  only. The page checks for `navigator.usb` rather than sniffing the browser.
- **Windows may hold the USB printer for itself.** If the printer was installed
  with a Windows driver, `usbprint.sys` owns the interface and Chrome cannot
  claim it — the print fails with a message saying so. Either uninstall that
  driver (Device Manager → the printer → *Uninstall device*, tick *delete the
  driver software*, replug) or bind the interface to WinUSB with
  [Zadig](https://zadig.akeo.ie). One-time, per PC. Untested here: nobody has
  yet plugged this printer into a laptop and pressed the button — do that before
  trusting this paragraph.
- **A USB failure needs Reprint, not Retry.** The job is written `SUCCESS`
  before the bytes go out, the same as an Android print, so a failed cable write
  leaves a saved receipt that never reached paper. The page says so and points
  at Reprint. Reporting the write back would need a second endpoint.
- **iPhone cannot drive this printer directly.** Two independent reasons: iOS
  reaches Bluetooth Classic only through MFi-certified accessories, and this
  printer is not one; and the iOS 13+ CoreBluetooth exception needs GATT over
  BR/EDR, which this printer does not expose (checked — it advertises SPP and
  nothing else). iPhones create receipts and the office connector prints them.
  A printer with Wi-Fi would remove the connector for every device at once.
- **Plain `fs` cannot open a COM port on Windows.** `fs.openSync("COM9")`
  creates a *file* named COM9 and reports success, so a receipt lands on disk
  while the connector says it printed. That is why `serialport` is a hard
  dependency, and why `assertRealPort()` refuses to write when a file of that
  name is in the way.

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
the heading ranges from 712 to 4424. On Bluetooth that is the entire wait. The
default layout uses a plain ASCII heading and so carries no raster at all.

| | Small | Medium | Large |
| --- | --- | --- | --- |
| ॐ | 1,160 | 2,600 | 4,424 |
| श्री गणेशाय नमः | 712 | 1,592 | 2,888 |
