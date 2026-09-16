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

**An Android phone skips all of it.** The bytes come back in the response and
RawBT drives the printer over Bluetooth, so no PC has to be awake. Every other
device — laptop, iPhone, anything — goes through the connector, because no
desktop browser can reach a USB thermal printer on Windows. See *Known
ceilings*.

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

### 3. The connector, on the printer PC

The printer needs to be reachable one of two ways, and the connector prefers
the first:

- **USB** — plug it in and run **Setup printer.cmd** once (below). The
  connector then finds the queue itself and pushes RAW ESC/POS into it.
  Verified here as `POS-58-Series (1)`.
- **Bluetooth** — pair it (PIN `1234`, MAC `DC:0D:30:59:51:A9`) so Windows
  gives it an outgoing COM port. Used when the cable is not in.

```
cd connector
npm install
npm run build:connector      # from the project root
```

That writes `dist/POS Printer Connector/`. Copy the whole folder to the PC the
printer is attached to — often the same laptop you develop on — then:

1. edit `connector.env` with the two Supabase values
2. **over USB:** right-click **Setup printer.cmd** → *Run as administrator*
3. double-click **Start Printer Connector.vbs** — it runs with no window
4. run **Run at startup.cmd** once, so it comes back after a reboot

**Only one PC may run the connector.** There is one queue and the connector
that claims a job first wins, so a second one on a laptop with no printer will
take receipts and fail them. That is not a theory: it happened, and the log
read `Opening COM9: File not found` on a machine whose Bluetooth was off while
the printer sat on a different laptop's USB cable. Stop the other connector and
delete its shortcut from
`%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup`.

#### Setup printer.cmd

Everything it does is something a person would otherwise type, and two of those
things are traps nobody guesses. It finds the port the printer is actually on,
then either moves an existing queue onto it or creates one, and prints a slip
so the answer is paper rather than a status code.

No vendor driver is needed. Receipts are RAW ESC/POS, so Windows' own
**Generic / Text Only** driver carries them through untouched — which matters
on a fresh laptop with no installer to hand. If the vendor's driver is already
installed, its queue is moved rather than replaced.

It needs administrator rights, because adding a printer and moving a port both
do. It asks for them instead of failing halfway.

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
- **On a laptop** there is one button, *Print*, and it goes to the connector.
  Plug the printer into that PC with the USB cable and it prints over the
  cable; unplug it and the same button prints over Bluetooth instead, with
  nothing to change.
- **Send to the printer PC** is the other button: the receipt is queued and
  whichever PC is running the connector prints it over Bluetooth. That PC may
  well be the laptop in front of you — the point of the button is that the
  printing happens somewhere else, not that the room does. It is the only route
  on iPhone, in Firefox and Safari — see *Known ceilings*.
- **The light in the corner** says *Printer PC* and names the route it found —
  `POS-58-Series (1) (USB)` or `COM9`. On an Android phone it disappears unless
  jobs are waiting, because a PC being asleep is not news to a phone that
  prints for itself.

Retrying a `SUCCESS` job is refused by the server, so no retry can ever produce
a second physical receipt.

## Development

```
npm run dev         # http://localhost:3000
npm test            # layout, money, byte-level and printer-queue checks
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
- **No desktop browser can reach this printer directly, and WebUSB was tried.**
  `usbprint.sys` binds itself to any USB printer-class device and will not
  release it, so Chrome is refused the handle — measured here, where the
  printer comes up as `USB\VID_0456&PID_0808\PRINTER` owned by *USB Printing
  Support* and returns Access denied out of `open()`. The way round would be
  [Zadig](https://zadig.akeo.ie) and WinUSB: an admin, the loss of the Windows
  print queue for that cable, and the same surgery on every laptop. Going
  through the queue instead costs one connector install and no driver changes,
  so that is what the connector does.
- **RAW to a queue means the spooler took it, not that paper came out.** If the
  printer is off or unplugged the job would sit in the queue while the
  connector reported `SUCCESS`, so the USB route is used only when the queue's
  port is the port a plugged-in printer is on this minute:

  ```
  USBPRINT\UNKNOWNPRINTER\7&19B07E4B&0&USB002   the printer, right now
  POS-58-Series (1)   PortName: USB002           the queue, matching
  ```

  The two drift apart on their own, and both ways of drifting print nothing
  while looking fine. This printer shipped with its queue on the vendor's
  `Printer PORT:` monitor, attached to nothing — Windows accepted every
  receipt, drained the spooler, and the paper stayed blank. Windows also
  renumbers the device to `USB003` and up after a replug, leaving the queue
  aimed at a port with nothing behind it. Both fall back to Bluetooth, and the
  log names the one command that fixes it:

  ```
  Set-Printer -Name "POS-58-Series (1)" -PortName "USB002"
  ```

- **The USB queue is picked by name.** Among the queues on the live port, one
  matching `pos|58|thermal|receipt` wins, or the only candidate if there is
  just one. Anything else logs what it saw and falls back to Bluetooth — set
  `PRINTER_NAME` in `connector.env` to settle it. `npm test` covers every one
  of these cases; none of them need a printer.
- **iPhone cannot drive this printer directly.** Two independent reasons: iOS
  reaches Bluetooth Classic only through MFi-certified accessories, and this
  printer is not one; and the iOS 13+ CoreBluetooth exception needs GATT over
  BR/EDR, which this printer does not expose (checked — it advertises SPP and
  nothing else). iPhones create receipts and the printer PC prints them.
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
