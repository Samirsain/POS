# Printer verification — DNT-585-LU5325 (HOP-H58)

Phase 0 results. **Nothing here is verified until a human has looked at the
paper and filled it in.** Spec rule 9: do not report hardware behaviour as
verified without the hardware.

Run: `npm run print-test` (add `--port COM4` if COM3 is the wrong one).

| | |
| --- | --- |
| Date run | _(not yet run)_ |
| Port used | |
| Baud | 9600 |
| Payload bytes | 1513 (bitmap 1064 = 70%) |
| Time to drain | |
| Time until paper stops, by eye | |

## 1. Receipt block

- [ ] ॐ bitmap printed, centred, not stretched or clipped
- [ ] ॐ density readable — not a black blob, not ghostly
      → if wrong: `npm run bitmap -- -Threshold 190` (heavier: lower it), re-check `phase0/om-96.png`, re-print
- [ ] Divider reaches both paper edges exactly — confirms 32 columns
- [ ] `0012` and the date sit on one line, date flush right
- [ ] `Amount  Rs. 25,000` is bold, and reads `Rs.` not `¥s.`
- [ ] Blank space after `Sign` clears the tear bar when torn


## 2. Font B character test (spec §1.3)

The self-test showed `0x24` as `$` in Font A but `¥` in Font B. `ESC R 0` is
sent before this block, so this tells us whether the charset command fixes it.

| Line | Expected | Actual on paper |
| --- | --- | --- |
| `A: $100  Rs. 100` | `$` correct | |
| `A: 0123456789 #@%&*` | all correct | |
| `B: $100  Rs. 100` | `$` correct? | |
| `B: 0123456789 #@%&*` | all correct? | |
| `A cols: ....` | ends exactly at right edge (32) | |
| `B cols: ....` | ends exactly at right edge (42) | |

**Decision this drives** — record the outcome, it sets §5.2's default font:

- [ ] Font B is clean → long values may wrap in Font B at 42 cols
- [ ] Font B substitutes characters → Font B is banned; everything stays Font A
      at 32 cols and long values wrap there

## 3. Anything unexpected

_(garbled output, dropped bytes, printer stalling mid-bitmap, reconnect
behaviour after the port closes — write it down here even if it seems minor)_
