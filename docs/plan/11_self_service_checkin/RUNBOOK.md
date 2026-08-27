# Check-in at a venue: what breaks, and what to do

Written for whoever is standing at the swap when something stops working. Every
symptom below has one place to look — the **Check-in stations** tab under
Devices — and most have a fix that takes under a minute.

## The shape of the thing

```
seller's phone ──HTTPS──> server ──queue──> bridge (ESP-32) ──BLE──> Phomemo
```

A **station** is a QR code, a bridge, and a printer. It owns a one-character
code that appears in every SKU printed there (`SS26-T-0042`), which is how a tag
can be traced back to where it came out. The station is the durable part:
replace the bridge or the printer under it and queued work carries on, because
jobs belong to the station rather than to either box.

Labels are rendered **on the server**, when a job is claimed. The bridge only
forwards bytes. That means a margin or layout change is a deploy, never a
firmware flash — and it means a job picks up an edit made in the seconds before
it prints.

## Reading the stations tab

Each station shows **one line saying whether it can print right now**. That is
the whole status — scan down the list for anything that is not green.

| Station line | What to do |
|---|---|
| **Ready** | Nothing. |
| **Printing — N in the queue** | Nothing. It is draining. |
| **N labels gave up** | Fix the printer, then **Clear** and have sellers reprint. |
| **Online — printer unconfirmed** | The bridge is not reporting its printer link. Send a **Test** print; if it works, the bridge needs a firmware update. |
| **Cannot reach the printer** | Printer power, or something else paired to it. |
| **Offline** | Bridge power and wifi. Declared after 20 seconds of silence — the bridge calls in every 1–5 seconds, so that is four missed beats. Hover for how long. |
| **Needs a bridge / a printer** | Bind one from the dropdowns on the row. |

Underneath are the queue counts — queued, printing, and anything failed or given
up on. Depth alone says nothing: work behind a **Ready** station is just a busy
counter. It is depth plus a status that is not green that means someone has to
move.

**There is no out-of-paper indicator, and that is not an oversight.** A Phomemo
out of labels — or jammed, or with its cover open — still accepts every byte and
still reports success. Nothing in the bridge, the web client, or the iOS app can
tell the difference. **Check the roll by eye.** **Ready** means the bridge can
reach the printer, and nothing more.

## Symptoms

### A seller's tag never came out

Their screen still says *Printing…*, which is honest — `hasPrintedTag` is set by
the printer's acknowledgement, not by the save, so it stays false until paper
actually comes out.

1. Check the station's queue depth and bridge state.
2. If the bridge is `online` and depth is falling, wait — it is coming.
3. If depth is stuck, work through *The bridge is quiet* below.
4. Once printing again, the seller taps **A tag did not come out properly?** and
   reprints. The reprint reuses the item's stored SKU, so the barcode is
   identical to any tag that did come out.

### The bridge is quiet

In order, stopping when tags start printing:

1. **Power.** Unplug the ESP-32, wait five seconds, plug it back in. It
   re-authenticates and resumes claiming; queued jobs are waiting for it.
2. **Wifi.** Confirm the venue network is up from a phone on the same SSID.
3. **The printer.** Check the roll, the lid latch, and the Phomemo's own power.
   A jammed printer usually shows as jobs claimed but never acknowledged, which
   after five attempts become `gave up`.
4. **Swap the hardware.** Take a spare bridge, provision it as a
   `Ski Swap - Network Printer Adapter`, and re-point the station at it from the
   Bridge dropdown. Queued jobs are unaffected — they belong to the station.

### The printer prints garbage, or nothing scans

Send a **Test** print from the stations tab. It queues a calibration pattern,
which exercises the entire chain: server, bridge, BLE link, printer.

- **Nothing at all** — the chain is broken above the printer; see above.
- **A pattern, but skewed or clipped** — the paper size or margins are wrong.
  Fix them on the **Printers** tab; the next job re-renders against the new
  geometry with no firmware change and no requeue.

### Jobs say "gave up"

The queue tried five times and stopped, on purpose — a job that hangs a printer
would otherwise block its station for the rest of the swap.

1. Fix the printer.
2. **Clear** the station's queue to discard work nobody wants any more.
3. Have affected sellers reprint from their own screen.

### A seller cannot sign in

- **No code arrived** — have them try the other channel. The screen offers
  "Use my email instead", and vice versa.
- **The emailed link opens the wrong app** — `SELLER_SITE_URL` is unset or wrong
  on the server. Sign-in links go to whichever origin the seller is standing on;
  unset, it falls back to localhost. `release.mjs` warns about this.
- **"That contact is already verified by another account"** — two people have
  claimed the same phone or email. One of them has to use a different contact;
  merging is a support task, not a venue one.

### A seller finished, but their items are not in Square

Expected for a short while: the Square push is batched at **finish**, not at each
save, so items appear together at the end of a check-in rather than one by one.
Nothing is lost if it fails — the finish reports how many pushes failed, and
staff can re-push from the items table. An item not on the floor cannot be sold
in the meantime, so the delay costs nothing.

## Before the doors open

- Every station has a bridge and a printer bound, and reads `online`.
- **Test** print from each station produces a clean, square calibration pattern.
- Scan each station's QR with a phone and confirm it lands on the right station
  name.
- One swap is **active**. Only an active swap accepts check-ins, and no two
  active swaps in an org may share a SKU prefix.

## Checking the queue by hand

`apps/api/scripts/smoke-print-queue.mjs` exercises the whole queue against a real
database, including the reaper. It creates and removes its own fixtures:

```bash
SMOKE_BASE=http://localhost:4000/api/v1 node apps/api/scripts/smoke-print-queue.mjs
```
