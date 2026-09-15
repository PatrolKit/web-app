# Reply to `webprinter_esp32` — peripheral assignment and scan ingest

Answering [`docs/plans/1_server_side_assignment/server-handoff.md`](../../../../webprinter_esp32/docs/plans/1_server_side_assignment/server-handoff.md).

All of it is built and deployed. Nothing in the contract changed from what you
specified; the notes below are what you would only find out by reading the code.

## §3 — do not add the symbology field

You asked whether the endpoint will ever need to tell an item SKU from a seller
QR, and said the field has to go in before boards ship because the code id is the
only thing carrying the difference.

**It is not the only thing.** The payloads are already distinguishable, and they
always will be. Everything this system puts a scanner in front of:

| What | Encoding | Payload |
|---|---|---|
| Item tag, minted | Code 128-B | `SS26-A-0001` |
| Item tag, legacy ticket | whatever the old vendor printed | bare digits — `67169` |
| Seller QR, on a tag and on the receipt header | QR | `https://skiswap.patrolkit.io/s/<sellerId>` |
| Station QR | QR | `https://…/app/checkin?swap=…&station=…` |

Both QRs are URLs. Neither item form can be one — a minted SKU is our prefix plus
a station letter plus a sequence, and a legacy ticket is digits. `startsWith("http")`
separates them completely, and will keep doing so because the QRs are URLs by
construction: they exist to be opened by a phone camera, which is what makes them
URLs in the first place.

Two further reasons the field would not earn its place:

**It would not identify a legacy ticket anyway.** Those come pre-printed from a
patrol's previous vendor, in whatever symbology that vendor used — we do not
print them and do not know. A rule keyed on the code id would work for the tags
we render and quietly fail on the ones we do not, which is the worse half to be
wrong about.

**An unknown barcode is already handled.** A manufacturer's UPC on a pair of skis
is bare digits and could in principle look like a ticket number. The lookup
refuses it — no item in this swap has that tag — and the code id would not
improve that answer, only arrive alongside it.

So: send the payload alone, as you planned. If something later genuinely needs
the symbology, it is an additive field on a request body and the boards shipping
now are not the obstacle — a board that does not send it is a board whose scans
are item tags, which is the only thing this endpoint receives.

## §0 — a scanner now has somewhere to live

Built and deployed. `SwapScanner` sits beside `SwapPrinter` rather than the two
collapsing into a peripheral with a kind: what they share is a name, a BLE name
and a bridge, and what they do not share is paper size, four margins, and the
business seller who can hold a printer. One table with a `kind` would put
nullable printer columns on every scanner and a branch in the print queue, which
today cannot be wrong about what it resolved.

As you said, none of that reaches you. The shape you will see is unchanged: a
name in the claim response.

The assignment UI is **one screen** — the Ski Swap tab formerly called Printers,
now Hardware, holding printers, scanners and bridges together.

**One thing worth knowing on your side:** the web picker filters on `18F0`, the
BCST-23's barcode-data service, not `FF00`. Your warning about `FF00` colliding
with the Phomemo's print service is right, and `18F0` is the scanner's alone — so
the collision stays contained to the firmware, where naming them distinctly is
still the fix.

## §1 and §2 — built

The claim response carries `printer` and `scanner` on every call, each either
`{ bluetoothName }` or `null`. They are always present now, so a missing field
only ever means a server older than this. `null` means release what you are
holding, as you specified.

The claim body takes `scannerLink`, `scannerBattery` and `scanQueueDepth`. Same
rule as `printerLink`: recorded with a timestamp, and omitting one leaves the
last report standing rather than clearing it — a bridge that says nothing about
its scanner has not said the scanner is down.

**One thing to know about §1.** The claim still 404s when a bridge is not bound
to a station, and a 404 carries no assignment. So a bridge holding a printer but
serving no station cannot learn about a reassignment. That predates this work —
it is how the endpoint has always behaved — but it is the one case where "no BLE
provisioning" does not yet hold. Say if it matters and it can be lifted.

## §3 — built

`POST /devices/me/scans`, `{ "sku": "..." }`, exactly the shape you proposed.

**What a scan does: it accepts the item onto the floor** — the same act as a
staff member tapping it on the iPad, through the same code, so there is one place
where an item becomes sellable.

| Response | Meaning |
|---|---|
| `200` | Accepted. The item is consigned, or already was. |
| `404` | No item in a running swap carries that tag. |
| `409` | That tag is on items in two running swaps at once. |

Every refusal is a 4xx deliberately, so your rule holds: dequeue and count,
because retrying cannot help. Anything you should retry is a 5xx.

**Idempotent, as you asked.** A repeat returns `200` and does not move the time
the item was accepted. Your retry-on-lost-response can be as eager as you like.

There is a body — the item id, the tag, and when it was accepted — but it is for
a person reading a log. You are right that the status is enough.

Two things worth knowing about what gets accepted:

- **Only tags in a *running* swap.** A station is not tied to a swap, so the tag
  is looked up across the organisation's active swaps. Last season's tag is a
  404.
- **Scanning an item that never had to wait is a no-op**, and still `200`. At an
  organisation that does not require the acceptance scan, everything is consigned
  when it is checked in, so a scan finds nothing to do. That is the honest
  answer, and it means you need no knowledge of the setting.

## §4 — agreed, and thank you for the numbers

Your fix settles it: a dedicated endpoint at 125 ms is quick enough for feedback
to reach the operator, and none of the coupling is worth buying. §3 is built as
its own endpoint, unchanged.

## Renaming a scanner — the opcode is `0x40`

Not part of your handoff, but you own the only code that can send it, and it was
the one thing blocking provisioning from giving a scanner a name of ours.

`inateck_scanner_cmd_set_name` is in the official header beside `set_bee` and
`set_led`, and the frame came out of the same `libinateck_scanner_cmd.dylib`
yours did — the `aarch64-apple-darwin` build from
`github.com/Inateck-Technology-Inc/scanner_lib`, called through `ctypes`:

```
set_name("Tom")        F3 05 7F 40 54 6F 6D E7
set_name("PKScan-01")  F3 0B 7F 40 50 4B 53 63 61 6E 2D 30 31 6B
set_name("A")          F3 03 7F 40 41 F6
set_name("")           F3 02 7F 40 B4
```

**The method was checked against your two known answers first**, because a
reading that cannot reproduce them is worth nothing:

```
set_bee(2,2,3)     F3 05 7F 5C 02 02 03 DA      opcode 0x5C, as your header says
set_led(2,2,2,2)   F3 06 7F 5B 02 02 02 02 DB   opcode 0x5B, as your header says
```

So, for `scanner_cmd.h`:

```c
#define SCANNER_CMD_SET_NAME 0x40

static inline size_t scanner_build_set_name(const char *name, uint8_t *out, size_t cap)
{
    return scanner_build_set(SCANNER_CMD_SET_NAME, (const uint8_t *)name, strlen(name), out, cap);
}
```

`scanner_build_set` already emits exactly these bytes — compiled verbatim from
your header and fed `0x40`, it reproduces all four frames above byte for byte.
Nothing else needs to change: same `FF04`, same write-without-response, same
auth frame first, reply on `FF01` parsed the way you parse the others.

Three things the encoder will not tell you:

- **The name is raw bytes.** No length prefix, no null terminator — the
  characters go straight in after the opcode.
- **The 20-byte limit is yours to enforce.** The library happily encoded a
  21-byte name and produced a valid checksum for it. The documented ceiling is
  20; the encoder does not hold you to it, so the scanner decides what happens
  and we would rather not find out.
- **Renaming breaks existing pairings.** Inateck's manual is explicit that the
  host must drop the connection and delete its pairing record before the new
  name appears. Whatever renames a scanner has to expect it to vanish and come
  back under another name.

The barcode route exists too — *Enter Setup → Set Bluetooth Name → one character
barcode per letter → Exit and Save* — but the manual prints those barcodes as
images and never publishes what they encode. They are Code 128 by their
structure; at roughly 2.4 pixels per module in the PDF, no decode of ours passed
its own checksum, so we are not guessing at them. The BLE command is documented
and exact, which is why it is the one above.

## Unchanged

Everything you listed: device token exchange, the raster format and its 11,200
bytes, `ack`/`nack`, `backoffMs`, job expiry and attempt accounting, and every
existing field on the claim.
