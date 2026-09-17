# Handoff to `webprinter_esp32` — the M221 and the 62 × 100 label

We have added a second printer. The M110 and its 50 × 30 label are unchanged and
must stay that way; the new one is a **Phomemo M221** running **62 × 100 mm**
stock, and it is what self check-in will print on.

Everything below is a requirement rather than a design. You know the firmware; we
have only read it, and where we name a line it is to be concrete about what we
found, not to say what it should become.

---

## The short version

| | M110, 50 × 30 | M221, 62 × 100 |
|---|---|---|
| Head | 400 dots | **576 dots** |
| Raster row | 50 bytes | **72 bytes** |
| Content rows | 224 | **784** |
| Raster | 11,200 bytes | **56,448 bytes** |

Two numbers that were constants are now per-printer, and one of them is baked
into a header you build.

---

## 1. A raster is no longer 50 bytes a row — and today that is a hard stop

`pk_protocol.c` derives the height by dividing:

```c
if (len % PHOMEMO_HEAD_WIDTH_BYTES != 0) { /* reject */ }
const size_t rows = len / PHOMEMO_HEAD_WIDTH_BYTES;
```

56,448 is not a multiple of 50 — it leaves 48 — so **a 62 × 100 job is refused
before it reaches the printer**, with "not a whole number of 50-byte rows". This
is the blocker: nothing else matters until the bridge can accept the payload.

`PHOMEMO_MAX_CONTENT_ROWS` is 1024 and 784 fits, so that bound is fine as it
stands.

## 2. The `GS v 0` header has to describe the raster you were given

`phomemo.c` writes `PHOMEMO_HEAD_WIDTH_BYTES` into the width field. For an M221
that would declare 50 bytes a row over a raster that has 72.

**Take the width from the job, not from a constant.** We made the same change on
our side for the same reason, and the failure mode is worth knowing because it is
not subtle: declare **more** bytes per row than the head has and the printer
refuses the raster outright — no paper moves, no error. We lost an afternoon to
a head width that was 24 dots too large and printed nothing at all. If a label
comes out blank on new hardware, suspect this before anything else.

## 3. Jobs are five times bigger

56 KB rather than 11 KB, over the same radio, pulling three times the paper.
Anything sized or timed for the old figure wants looking at — buffers, the
`big_alloc` in `job_queue.c`, chunk pacing, and any fixed ACK deadline.

We hit exactly this in the browser: a five-second ACK timeout that had been fine
for every 30 mm label was not obviously enough for a 100 mm one, because the last
chunks are only acknowledged as the label physically prints. We scaled ours by
job size with the old value as the floor. Whatever you do, a deadline that does
not know the job got bigger is the one to look for.

## 4. The M221 does not advertise `FF00`

Read off the hardware with LightBlue: it advertises **`AF30`** and **`1812`**
(standard HID), and not `FF00`. It *has* `FF00` — that is still where you write,
and it prints perfectly well through it — it simply does not announce it.

Your discovery is by advertised name (`adv_name_matches`), so we think you are
unaffected. Worth confirming that nothing in the scan path filters on `FF00`,
because our web picker did and the printer was invisible until we noticed.

Names are no help for telling models apart, if you were tempted: both of ours
advertise an opaque serial — `Q192E28B1060137` is the M110, `Q454E62S2530017`
the M221.

## 5. Still outstanding from the last handoff

`pk_config_commit` (pk_config.c:117) refuses a commit whose staged
`printer_name` is empty. Provisioning has stopped sending one — the board learns
its peripherals from the claim — so **a bridge cannot currently be set up at
all** until that check goes. This was raised in the Plan 21 reply and is now the
thing standing between the new flow and working hardware.

---

## What we need to agree: how the bridge learns the width

Today it infers the width from a compile-time constant, and there is no field
in the claim that carries it. That has to change, and the choice is yours.

Our preference is that **the job carries its own width**, so a raster is
self-describing and a third printer needs no new agreement:

```
{ "raster": "<base64>", "widthBytes": 72 }   // or widthDots
```

Absent, it means 50 and everything behaves as it does now, so nothing you have
deployed breaks. We will add the field — say which name and shape you want.

The alternatives, in case you prefer one: derive it from the printer assignment
the claim already carries, which couples the payload to a lookup; or have us send
finished ESC/POS, which the `payload_is_escpos` path already accepts but would
take print energy and speed away from you, and we think those belong with the
firmware.

## What we can tell you about the hardware

- **Head width 576 dots**, established by the printer itself — 600 printed
  nothing, 576 prints. Not by measuring a label, which we tried and got wrong.
- **It centres narrower stock** under the head, mechanically. Our renderer draws
  62 mm of content centred in a 576-dot raster, which puts 40 dots of margin
  either side. You receive it already centred; there is nothing to offset.
- **203 DPI**, so 8 dots/mm holds to within a dot over 100 mm.
- `FF02` write and `FF03` acknowledgements work exactly as on the M110, and the
  182-byte chunk we use in the browser is fine.

## What has not changed

The raster contract itself: row-major, one bit per dot, MSB leftmost, 1 = burn,
already thresholded. Feed rows are still yours. Print energy and speed are still
yours, and may well want different values on this printer — we have no opinion
and no way to test it.

The M110 path should be untouched by all of this. Every golden fixture we hold
for it is byte-identical after the work, which is how we know our own refactor
was inert, and the same standard seems worth holding yours to.
