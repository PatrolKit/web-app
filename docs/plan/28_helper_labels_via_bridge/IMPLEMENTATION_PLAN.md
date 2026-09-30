# Plan 28 — Legacy helper labels through a print bridge

A swap on legacy tickets can print two 25 × 67 stickers per ticket instead of
volunteers handwriting on it:
- the **item label**: name, size and price, for the section that stays with the
  gear;
- the **office label**: name, price and seller, for the office stub.

Today only the iPad prints them, over Bluetooth, to a printer it holds itself. An
iPad without its own printer can't print them at all.

This plan lets such an iPad print them through its station's bridge instead. The
bridge prints whatever raster it's given, so the firmware doesn't change. The
work is on the server:
- drawing the stickers;
- a bridge whose printer holds only this stock;
- an endpoint that prints now or says why it can't.

The iPad side is small (§8).

---

## 1. Decisions

| | |
|---|---|
| **A bridge whose printer holds 25 × 67** | Prints helper labels only. Every other kind of job is refused. §3 |
| **When the iPad uses the bridge** | Only when it has no ready 25 × 67 printer of its own. §8 |
| **Success** | The bridge is online, its printer is online, and the pair is queued. §4 |
| **No offline queue** | The iPad asks at the moment of saving. If the call fails, it tells the volunteer and the labels don't print. A pair not picked up within a minute is dropped, not printed late. §4, §5 |
| **What goes on the stickers** | Exactly the text the iPad already works out (`HelperLabelContent`), sent with the request. §4 |
| **Which counter a sticker is from** | The station's letter, as on item tags, taken from the station that asked. §7 |
| **Look** | A line-for-line port of the iPad's template, with the same typeface and rotation, checked against shared fixtures. §6 |

---

## 2. What is there today

- **The stock.** `SwapPrinter.paperSize` accepts `25x67`, on the M221 only.
  - Its `LabelSize` has `tier: null`, so the server refuses to render anything on
    it.
  - A bridge whose printer holds it fails every job at claim time.
- **The iPad's gate.** `HelperLabelGate` prints helper labels only when three
  things hold:
  - the swap's `printLegacyHelperLabels` is on;
  - a printer is connected and ready;
  - that printer holds 25 × 67.

  Otherwise it says why after the save: "Saved — helper labels didn't print: …".
  The reprint on the seller screen asks the same gate.
- **The text.** `HelperLabelContent` builds it: the name, the name without its
  size, the size, the price and the seller. The size comes from the category's
  size question.
- **The layout.** `HelperLabelTemplate` lays each sticker out in a landscape frame,
  turned a quarter into the strip the printer burns. The direction of that turn
  was set from a test print.
- **The bridge path.** Item tags already reach a station's bridge when the iPad
  has no printer. Helper labels have no such path.

---

## 3. A bridge that holds 25 × 67 prints helper labels only

The stock decides what a bridge may print. A 25 × 67 sticker is useless as an
item tag or a receipt.

- **Rendering.** `geometry.ts` gives the size a tier of its own, `strip` (the
  iPad's name for it).
  - The helper templates render only on it.
  - Every other template refuses it, as today.

  This stays the backstop at claim time.
- **Enqueuing.** The queue's enqueue methods check the station's bridge printer
  before writing a job.
  - **A tag reprint** gets `409 PRINTER_STOCK`: *"Station 3's printer is loaded
    with 25 × 67 helper labels, and prints nothing else."*
  - **QR and printer labels** don't go through a bridge's queue. They're rendered
    on request, and the renderer refuses 25 × 67 with the same sentence.
  - **Implicit ones** queue nothing, and the action that caused them still
    succeeds. Refusing the save would lose the item over a label.
    - **An item saved at such a station** queues no tag. It keeps
      `hasPrintedTag: false`, so it shows as needing one.
    - **Check-in finish** queues no receipt pages. The emailed receipt still goes,
      and `receiptPages` reports 0.
- **Test print.** The station's Test button queues a sample pair of helper labels
  instead of the calibration label.

---

## 4. The endpoint

```
POST /orgs/:orgId/ski-swap/stations/:stationId/helper-labels
Authorization: Bearer <device token>   (ski_swap.staff_check_in)
```

```jsonc
{
  "swapId": "…",
  "itemId": "…",          // optional; the item may not have synced yet
  "ticket": "10042",      // the legacy ticket number, for the job record
  "name": "Volkl Kendo 88 176cm",
  "itemName": "Volkl Kendo 88",
  "size": "176cm",        // or null
  "priceCents": 24900,
  "sellerName": "Dana Reyes"
}
```

- **Caller:** only the tablet bound to that station. Anything else gets `404`.
- **The text is taken as sent.** That's what makes the two printers match word for
  word, without a second copy of the size logic.
  - Only a staff device can call this.
  - Each field is length-bounded, and the price must be positive.
- **The item is optional.** Labels are wanted now, at the counter, even while the
  item is still in the iPad's offline queue. If `itemId` is given, it's recorded
  on the jobs.
- **Failures.** Everything is checked before anything is queued, so the answer
  comes back while the volunteer is still at the counter. Each failure is a `409`
  with a code, and a sentence the iPad can show after "helper labels didn't
  print:".

  | Code | When |
  |---|---|
  | `HELPER_LABELS_OFF` | The swap's switch is off. |
  | `NO_BRIDGE` | The station has no bridge. |
  | `BRIDGE_OFFLINE` | The bridge hasn't checked in within the offline rule's 20 seconds. |
  | `NO_PRINTER` | The bridge drives no printer. |
  | `PRINTER_STOCK` | The printer doesn't hold 25 × 67. |
  | `PRINTER_OFFLINE` | The bridge's last report doesn't say the printer is `ready`. That includes a printer that has never been reported. |

- **Success** means the bridge is online, its printer is online, and both jobs are
  queued.
  - The answer is `202` with `{ jobIds, notAfter }`.
  - It doesn't wait for the ink. §5 drops the pair if it isn't picked up.
- **No idempotency key.** A retried request prints another pair, which is what a
  reprint is.

---

## 5. The jobs

- **Two new kinds,** `helper_item` and `helper_office`. They're written by one
  `createMany` as a single batch, `seq` 0 and 1, so on a shared bridge (Plan 27)
  the pair comes out together.
- **The request's text** goes in the job's existing `params`, and the render reads
  it from there.
- **A pair not printed promptly is dropped.** Without this, a bridge that dropped
  off and came back an hour later would print stickers for tickets long since
  handed over.
  - `PrintJob` gains a nullable `notAfter`. Helper jobs set it to 60 seconds after
    queuing, and every other kind leaves it null.
  - The claim doesn't take a job past its `notAfter`.
  - The claim's existing sweep marks such jobs `abandoned`: *"Not printed within a
    minute of being asked for"*.

---

## 6. Drawing them

`label-templates.ts` gains `drawHelperItem` and `drawHelperOffice`, ported line for
line from `HelperLabelTemplate.swift`:

- **Rotation:** a quarter turn, copied from the iPad's `rotation` rather than
  re-derived, since that was set from a test print.
- **Numbers:**
  - a 28-dot minimum line size;
  - the item label's price at 67 bold, with 4 dots above it;
  - shrink, then cut with an ellipsis that fits;
  - `---` for no size;
  - `$45` for whole dollars.
- **Measurement:** the item label places its price by its ink, not its em box. The
  server reads ink from `measureText`'s bounding box, the same numbers the iPad
  reads from CoreText.
- **Typeface:** both render Inter. The iPad's `LabelCanvas` already matches the
  server's canvas in typeface, text origin, and a luminance threshold of 128.

**Matching.** The server's renderer spec gains golden rasters for both stickers
from fixed content. The iPad's test suite renders the same content and compares
its raster with those fixtures.
- Identical is the target.
- On the first comparison, any difference is either fixed, or written down as the
  known gap between two rasterisers.

**Target:**
- The bridge's printer's geometry: an M221, 576 dots wide, with 25 mm stock
  centred at dot 188, and the printer's own margins.
- A sticker is 37,440 bytes of raster, well within what the Sparkle Motion Mini
  bridge takes.

---

## 7. The station letter

A legacy ticket number carries no station, so a sticker takes its letter from the
station that asked: the job's station.

- **Where:** a filled square with the letter reversed out of it, at the right-hand
  end of the price row on both stickers. That row is always short, so the square
  never costs a name any room.
- **Size:** the price row's height, to be confirmed on a printed sample.
- **Both printers show it.** iPad-printed stickers show it too, from the iPad's
  own station, so the two printers' stickers stay the same.

---

## 8. The iPad

- **Route:**
  - **A ready 25 × 67 printer of its own:** print over Bluetooth, as now.
  - **No such printer, and online:** call §4 with the content it already builds.
  - **Offline:** don't try. Say "Saved — helper labels didn't print: this iPad is
    offline".
- **Failure:**
  - a `409`'s sentence goes into the existing "helper labels didn't print: …"
    notice;
  - a network failure says the server couldn't be reached;
  - either way nothing is queued, and the item's save is unaffected.
- **Success:** a notice that the labels went to the printer at that station.
- **Reprint** on the seller screen takes the same route.
- **Template:** gains the station letter (§7), with the code from `/devices/me`.

---

## 9. The web

- **Printer settings:** 25 × 67 loses "(iPad only)". Its description says a bridge
  with this stock prints helper labels and nothing else.
- **Station row:** says "Helper labels only" when its bridge's printer holds
  25 × 67 (`helperLabelsOnly` on the station). Test sends a sample pair.
- **Station status:** an expired helper job counts as given up, with the latest
  reason (`lastAbandonedReason` on the queue status) as the tooltip.

---

## 10. Firmware

No change. A helper sticker is a raster like any other. Claim, raster download,
ranges and acks all work as they do today.

---

## 11. Not in this plan

- **Helper labels from the web.**
- **Queuing labels for later** (§1).
- **A bridge with two stocks.** One printer per bridge (Plan 27).

---

## 12. Schema

- **`PrintJob.notAfter DateTime?`**, additive.
- **The new job kinds** are values in the existing `kind` string.

Whether to migrate in place or wipe is asked at deploy time, as with every schema
change.

---

## 13. Testing

**Unit:**
- **Stock:**
  - helper kinds render on 25 × 67 and nowhere else;
  - every other kind is refused there, at enqueue and at render;
  - an item saved at a helper-only station saves, and queues no tag;
  - check-in finish there emails, and queues no receipt pages.
- **Endpoint:**
  - each `409` code, from the state that should produce it, including a printer
    never reported;
  - `404` for another station's tablet;
  - the pair queued as one batch, with `notAfter` a minute out;
  - the text stored in `params` exactly as sent.
- **Expiry:**
  - a helper job past `notAfter` isn't claimed, and is swept to `abandoned` with
    its reason;
  - other kinds are untouched.
- **Rendering:**
  - golden rasters for both stickers, with and without a size;
  - a name long enough to be cut;
  - the station letter.

**Smoke** (`smoke-helper-labels.mjs`), over real HTTP:
- a staffed station whose bridge drives a 25 × 67 printer;
- a pair requested by the tablet comes back from one claim, rendered, in order;
- a bridge unseen for 30 seconds gives `BRIDGE_OFFLINE`;
- a 62 × 100 printer gives `PRINTER_STOCK`;
- a printer the bridge reports down gives `PRINTER_OFFLINE`;
- a pair left unclaimed past its minute is abandoned, and the station's status
  gives the reason;
- the station row says "Helper labels only";
- Test queues a sample pair;
- an item saved at the station saves and queues no tag.

A tag reprint's `409` is covered by the unit tests. Its only route is the
business seller's own reprint, which the smoke has no seller for.

**Across repos:** the iPad compares its rasters with the server's fixtures (§6).

**By hand:**
- An iPad with no printer, on a station whose bridge holds 25 × 67. Save a legacy
  ticket item, and the pair prints at the bridge within a couple of seconds.
- Unplug the bridge and save another. The iPad says why at once.

---

## 14. Order

1. The `strip` tier, the template port, and the fixtures (§6).
2. Stock rules at enqueue (§3).
3. `notAfter`, the endpoint, and the jobs (§4, §5).
4. The station letter (§7).
5. The web (§9).
6. Handoff to the iPad (§8), with the fixtures from §6.

---

## 15. Open questions

- **Sixty seconds** for `notAfter`: long enough for a busy shared bridge to finish
  a batch ahead of the pair, short enough that nothing prints after the volunteer
  has moved on.
- **The letter's size and position** on the sticker (§7), to be settled on a
  printed sample.
