# Plan 23 — The M221, and printing on more than one printer

The M110's 50 × 30 mm label is too small: a price, a name and a barcode, with
nothing left over. The M221 takes 62 × 100 mm stock, and the draft uses it for a
price you can read across a room, a description, and a barcode a scanner finds
first pass.

But the ask is larger than one label — **both printers stay in service, and more
standard sizes follow.** So this is mostly a plan about the model the renderer
uses, and only then about a layout.

Scope is the server renderer and the web. iOS is a later plan; §8 records what it
will need.

---

## 1. Decisions

| | |
|---|---|
| **Media alignment** | The M221 physically centres narrower stock under the head. Confirmed on the hardware, not inferred from a driver. |
| **Head width** | **576 dots (72 mm).** §2. |
| **Tag orientation** | Price and name share an orientation, and both are rotated. Forced: the name column is ~22 mm wide, and no useful text runs across 22 mm. |
| **What "description" is** | The frozen `SwapItem.name`, already what `ItemLabelData` receives. Nothing new to thread through. |
| **Sizes** | 40 × 30 is dropped. 50 × 30 and 62 × 100 remain, and adding more is the point of §3. |
| **Receipts** | Redesigned too, on both printers. §7. |

---

## 2. The head width — 576 dots

The M221 is a 3-inch printer at **203 DPI** ([Phomemo](https://phomemo.com/products/m221-label-maker),
[manual](https://manuals.plus/phomemo/m221-label-maker-printer-manual)), which is
7.992 dots/mm, so the existing 8 dots/mm assumption holds to within a dot over
100 mm and needed no change.

The head is **576 dots — 72 mm**, which is the figure [the community CUPS
work](https://github.com/c08306605-crypto/Momir-Jamie-Dave/pull/4) reports for
the M220 class. It was briefly set to 600 on the manufacturer's quoted 75 mm
print width plus a reading of a calibration label, and that was wrong: the
quoted width is presumably the media it accepts rather than the dots it has, and
the label was read by estimating pixels off a photograph.

**The printer settles it, and does so unambiguously.** `GS v 0` declares bytes
per row in its header, so too large a head is not a shifted or clipped label —
the printer rejects the raster and no paper moves at all. At 600 nothing printed;
at 576 it does. Any future head width is measurable the same way, and a label
size that prints blank on new hardware should have this suspected first.

Centring still matters for small errors: content is drawn centred, so being a
little wrong shifts the label by half the error. It does not rescue an error
large enough to be refused.

---

## 3. The model: a printer and its media are two different things

### What is wrong now

`paperSize` reaches exactly one decision — the canvas height — and **both current
sizes return 224**. Nothing else in the renderer branches on it. `40x30` and
`50x30` are the same size as far as the code is concerned; the entire difference
between them is whatever margins somebody typed into a printer's settings.

That leaves margins doing two unrelated jobs:

- **A safety inset.** Labels do not always sit square in the printer, and
  anything drawn to the exact edge is the first thing lost. The margin pulls all
  content inward so a crooked label still prints whole. This is the job margins
  are for, and it is per-printer because different printers and stock misalign
  differently.
- **Physical alignment.** Where the media sits under the head. Not a preference
  but a hardware fact, and wrong means printing on the liner.

Only the second is a mistake. On `40x30` the margins are the only thing keeping
content on 40 mm of stock under a 50 mm head, so a number meant to absorb
misalignment is load-bearing for alignment as well. Adding the M221 the same way
would mean asking somebody to type a number they cannot derive in order to centre
62 mm stock.

### What replaces it

Two code-level tables and a derivation. Neither is user data.

```ts
interface PrinterModel {
  id: 'm110' | 'm221';
  headWidthDots: number;
  /** Where narrower media sits under the head. Measured, not chosen. */
  mediaAlignment: 'left' | 'centre' | 'right';
}

interface LabelSize {
  id: '50x30' | '62x100';
  widthMm: number;
  heightMm: number;
  /** Which composition the templates draw. §6. */
  tier: 'compact' | 'tall';
  /** Models this stock can run on. Media wider than the head is unprintable. */
  models: PrinterModel['id'][];
  /** Starting safety inset. Scales with the label rather than the printer. */
  defaultMargins: PrinterMargins;
}
```

The target becomes derived rather than typed:

```ts
interface PrintTarget {
  model: PrinterModel;
  size: LabelSize;
  headWidthDots: number;    // model
  mediaOffsetDots: number;  // alignment and (head − media) — never typed
  mediaWidthDots: number;   // size.widthMm × 8
  canvasHeightDots: number; // size.heightMm × 8 − feed rows
  margins: PrinterMargins;  // safety inset, applied inside the media box
}
```

`compose` gains a third box: the head-width raster, the media box at
`mediaOffsetDots`, and the content box inset by margins.

`escpos.util.ts` has to follow. `printRasterImage` pads every row to
`HEAD_WIDTH_BYTES` and declares that width in the `GS v 0` header, both read from
the module — so `buildPrintJob` takes the target too, or a 62 mm job goes out
claiming to be 50 mm wide.

Adding a printer is one row. Adding a size is one row. They compose, which is the
whole of the ask.

### Margins keep their job, and gain per-size defaults

Four per-printer numbers is right for a safety inset. Misalignment varies by roll
and by reload, so it has to be absorbed rather than cancelled, and it can be
asymmetric, so one number will not do.

What changes is where the starting values come from. The current default is 4
dots — half a millimetre — a sensible fraction of a 30 mm label and nearly
nothing on a 100 mm one. `LabelSize` supplies the defaults, and a printer row
overrides them only when somebody has a reason.

The branding coupling is correct and stays: `brandingLeft = fullW − marginRight −
BRANDING_STRIP_W` puts the logo's right edge exactly on the inset boundary, so
branding moves inward with the margin like all other content. `tall` needs a
variant only because the draft puts branding beside the barcode, not because the
existing arrangement is wrong.

The calibration label draws the margin rectangle, so it also shows whether
content lands safely inside the stock — making it the tool for setting margins on
a new printer as well as for measuring the head.

### One list, not six

The size list is declared in three places and hand-written as an inline
`'40x30' | '50x30'` union in five more:

```
apps/api/src/contracts/ski-swap.contracts.ts:557     PAPER_SIZES
apps/api/src/ski-swap/printing/geometry.ts:21        PAPER_SIZES
apps/web/src/lib/printing/PhomemoPrinterService.ts   PAPER_SIZES + labels
apps/web/src/lib/api.types.ts:428                    inline union
apps/web/src/components/AppShell.tsx:226,231,259     inline union ×3
apps/web/src/pages/ski-swap/PrintersPage.tsx         inline union ×4, literal <option>s
```

A hand-written union does not follow its source, so adding a size today means
finding eight places with no help from the compiler. Removing 40 × 30 visits
every one of them anyway, so they should come out deriving from a single exported
list, with the `<option>`s generated rather than typed.

### Migration

`SwapPrinter` gains a `model` column. The margin columns stay.

The system is pre-production, so this is a schema change and a reseed rather than
a careful migration: any printer stored as `40x30` becomes `50x30`, and every
printer becomes `m110`. Reset margins to the new per-size defaults rather than
carrying them — a 40 × 30 printer's margins were holding content on the stock,
and under the new model that is the media offset's job.

---

## 4. The M221 and its size

At 8 dots/mm:

| | Across head | Feed |
|---|---|---|
| 62 × 100 mm | 496 dots | 800 dots |
| Canvas | 496 | 784 (800 − 16 feed rows) |

`RASTER_FEED_TOP`/`BOTTOM` stay at 8 unless the M221 wants different values — a
hardware question, answered by the same calibration label.

---

## 5. Provisioning an M221

Registering a printer is its own path, and none of it knows about models.

**How it works now.** `scanAnyPrinter` (PrintersPage.tsx:185) opens the BLE picker
filtered on the advertised service `FF00`, captures `device.name`, and the form
posts a name, that Bluetooth name and a paper size. Afterwards the browser drives
the printer over the same service: it writes to `FF02` in 182-byte chunks and
waits on `FF03` notifications for a per-chunk acknowledgement, three chunks
in flight at a time. The bridge does the same thing independently —
`printer_ble.c` finds a printer by advertised name and uses the same three UUIDs.

**All three BLE unknowns are settled, by provisioning one and printing on it.**

| Question | Answer |
|---|---|
| Does it advertise `FF00`? | **No.** It never appeared in the picker, which filtered on that service. The picker now offers an unfiltered list as a fallback. |
| `FF02` write, `FF03` acknowledgements? | **Yes** — printing works unchanged. |
| Chunk size | `CHUNK_SIZE = 182` holds. |

**The model has to be asked for.** The guess was that printers name themselves
identifiably, the way `HPRT` does for scanners. They do not: both we own advertise
an opaque serial — `Q192E28B1060137` is an M110, `Q454E62S2530017` an M221 — so
the inference never fired and was removed. It is a dropdown against the label on
the hardware, and `SwapPrinter.model` is what the whole of §3 keys off.

**That constrains the form.** The size list is filtered by model (`LabelSize.models`),
so the model must be known before sizes can be offered. Pick the device first,
derive or ask for the model, then show the sizes it can take — rather than
today's flat form where all three fields are independent.

**The printer-ID label needs a tier too.** `drawPrinterLabel` prints the sticker
that goes on the printer itself, and it is drawn to the compact canvas like
everything else. So is `drawQrLabel`. Both want `tall` variants or they will
print an M110-shaped label in the corner of a 62 × 100 sheet — see §6.

### The bridge is not out of scope

Self check-in prints through the station's bridge, not the browser. So an M221 at
a check-in station is driven by the ESP-32, and the firmware's connection path —
name lookup, `FF00`/`FF02`/`FF03`, its own chunking and ACK handling — has to
work with it.

The raster contract genuinely does not change: the bridge is handed bits and
builds its own ESC/POS. But "the bridge can drive an M221 at all" is a firmware
question that this feature depends on, and it should be asked before a station is
promised the new printer. If the answer is no, the M221 works for staff printing
over Bluetooth and not for self check-in, which is the opposite of the priority.

---

## 6. Layouts: tier, not size

With more sizes coming, a template per size multiplies badly. But 50 × 30 and
62 × 100 are genuinely different compositions rather than one scaled, so a single
responsive template would be false economy in the other direction.

**Each size declares a tier; each template has one implementation per tier.** A
new size in an existing tier is free; a new tier is deliberate work.

`drawItemTag` becomes the `compact` item tag, unchanged. It is written to a
224-dot canvas with hard-coded offsets — `halfH + 60`, a 64-row barcode — and
must not be disturbed.

`drawLargeItemTag` is the `tall` one, from the draft, on a 496 × 784 content box:

```
┌──────────────────────────┬────────┐
│                          │        │
│        P R I C E         │  name  │   both rotated 90°
│        (rotated)         │  (rot) │   upper block
│                          │        │
└──────────────────────────┴────────┘
┌──────────────────────────┬────────┐
│  ▍▍ ▍ ▍▍▍ ▍ ▍▍ barcode   │ P. by  │
├──────────────────────────┤  PK    │   lower block
│  SKU                     │ (rot)  │
└──────────────────────────┴────────┘
```

- **Price** — rotated, sized by the existing `fitSize`/`fitted` against the box's
  long axis, with a far higher ceiling than today's 44.
- **Name** — rotated, in the narrow column, wrapped across lines. No template
  wraps yet: `fit` truncates and `fitted` shrinks, so `wrap(ctx, text, maxWidth,
  maxLines)` is new, and is the one genuinely new failure mode here.
- **Barcode** — `code128BModules` unchanged, with `moduleW` at 3 and a height
  well past 64 rows. This is the point of the bigger tag. Legacy tickets carry
  bare-digit SKUs and Code 128-B encodes those identically.
- **SKU** — human-readable, under the barcode.
- **Branding** — `drawRotatedBranding` assumes the right margin, so it needs a
  variant taking an explicit box.

---

## 7. Receipts

Same tiering, same rule: the compact receipt must not move.

`drawReceiptHeader` and `drawReceiptItems` take the target's real dimensions
rather than assuming the M110 canvas. `receiptItems` already paginates by
measured height, so a taller label simply fits more rows — that logic needs
nothing but correct dimensions.

The `tall` header can afford a much larger QR, which is worth having: it is what
a seller scans to follow their sales afterwards.

Its own commit, after the tag. It is the thing a seller takes home.

---

## 8. What iOS will need (not this plan)

`label-templates.ts` ties its sizing to `LabelGenerator.renderFitted` on the iPad
deliberately, so a tag from a phone matches one from a bridge. This plan breaks
that agreement for `tall` only.

The handoff needs the two tables, the tier rule, the wrap rule, the fact that the
size list now depends on the printer model, and that 40 × 30 is gone.

**Until then an iPad bound to an M221 prints an M110-shaped tag on a large
label.** If that is unacceptable mid-season, the alternative is refusing the
combination on iOS until it catches up.

---

## 9. Fixtures and tests

`label-renderer.service.spec.ts` asserts golden `.bin` rasters, and they are the
safety net for §3.

- The existing fixtures should come out byte-identical through the geometry
  refactor. Not a compatibility promise — the cheapest proof it changed only what
  was intended, since with 40 × 30 gone the M110 runs one stock that fills its
  head and the arithmetic is identical to today's. The spec's `40x30` target
  (line 45) goes with the size.
- Add `item-tag-62x100.bin`, plus the edge cases the small tag already covers: an
  over-long name and a 13-character SKU.
- Add the case only this layout has: a name long enough to wrap and be cut.
- Assert `mediaOffsetDots` lands where the model says. That is the assertion
  whose absence let 40 × 30 be a size in name only.

---

## 10. Order

1. **The model** (§3) — tables, derived target, `SwapPrinter.model`, media box in
   `compose`, one size list, 40 × 30 removed. Needs no hardware and no head-width
   number: making head width a per-target value is independent of the value.
2. **Per-size margin defaults** (§3). Small, and worth doing before anyone sets
   up an M221 by hand.
3. **One sitting with the hardware.** Print a calibration label for the head
   width, and read the GATT table for the service, characteristics and buffer
   size (§5). Centring is already known. Everything below needs the answers.
4. **Provisioning** (§5) — model capture, a form that asks in the right order, a
   size list filtered by model, and whatever the picker filter needs. Register
   the M221, print calibration again, set the margin defaults from what came out.
5. **`drawLargeItemTag`** (§6) with fixtures (§9).
6. **Receipts**, and `tall` variants of the printer-ID and QR labels (§6, §7).

Only steps 3 and 4 need hardware, and they are not first — 1 and 2 can start now.

---

## 11. Out of scope

- The iOS renderer (§8).
- **Changing** the ESP-32 firmware. The raster contract does not move: the bridge
  is handed bits and builds its own ESC/POS, so a bigger label is more bytes
  rather than a new agreement. Tell them a raster may now be 784 rows and 62–75
  bytes wide, so nothing assumes 224 or 50. **Confirming the bridge can drive an
  M221 at all is in scope** — see §5 — because self check-in depends on it.
- Retiring the M110.
