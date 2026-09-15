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

**One thing worth knowing on your side:** the web picker filters on the name,
not on a service. It tried `18F0` first, on the reasoning that the barcode-data
service is the scanner's alone and `FF00` is not — but a `filters` entry matches
only services in the *advertisement*, and the BCST-23 advertises none of its own.
`18F0` is discoverable after connecting and never before, so the filter matched
nothing and a scanner on the bench simply never appeared. It now matches name
prefixes instead: `HPRT`, which is every scanner today, and `pkscan_`, which
nothing wears yet and is there for whenever renaming starts working. Your warning
about the `FF00` collision still stands for the firmware, where naming the two
services distinctly is still the fix.

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

## We tried to rename a scanner from the browser. It did not work.

`adv_name_matches` in `scanner_ble.c` is the only thing that finds a scanner, so
the name is the identity, not decoration. The plan was to mint one at
provisioning and write it over `0x40` before recording the scanner at all, so
that a shelf of factory-reset units stopped being a shelf of identical `HPRT`s.

**It was built, run against a real scanner, and the name did not change.** The
writes were accepted. Nothing came back to say otherwise — which is exactly the
hole: `FF04` takes no response, `FF01`'s reply format is unpublished, and Chrome
has never shipped advertisement scanning, so a browser cannot read the new name
back to check. Success and silent refusal look identical from up here.

So provisioning now stores whatever the scanner advertises, and that is what
arrives in `bluetoothName`. **Nothing changes for you** — same field, same byte
comparison. Two things do follow:

- **Your trailing-space trim stays load-bearing.** We are recording OEM names
  again, including the `"PKScan-01 "` your comment calls out. Good thing it is
  there.
- **Uniqueness is now the hardware's problem, not ours.** If two units advertise
  the same name, the second cannot be added at all — the server refuses a
  duplicate `bluetoothName`. Whether that bites depends on whether `HPRT…`
  carries a per-unit suffix, which is a question the hardware answers.

**What would help.** The encoding is not where this failed — `buildSetName`
reproduces the vendor encoder's frames byte for byte, and our copy of your
`SCANNER_AUTH_FRAME` verifies against its own checksum. Everything below is still
good. What we cannot do from a browser is see what the scanner made of it. You
can: you have the same frames, a wired console, and `FF01` already subscribed and
logging. If `scanner auth` followed by a `0x40` set-name over your link does
change the name, then the gap is something about how Chrome puts those bytes on
the air — 20-byte chunks, their pacing, or a commit step we did not capture — and
the rename belongs on the bridge rather than in the browser anyway. If it does
not change the name over your link either, then the BLE route is a dead end on
this firmware and the programming barcodes in the manual are the only way in.

Either answer is worth more than what we have, which is one negative result and
no way to see past it. No rush — the web UI works without it.

## The opcode is `0x40` — everything you need to try it

Not part of your handoff, but you own the only code that can watch what happens
when it is sent.

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

## One line is blocking provisioning from dropping `printer_name`

`apply_assignments` works. Both peripherals are now chosen on the bridge in the
web UI, saved server-side, and picked up on the next claim — no board reset, no
Bluetooth, no standing next to the hardware. That is the whole point of §1 and it
landed.

**But `printer_name` cannot actually leave provisioning yet**, because
`pk_config_commit` still refuses a commit without one:

```c
// pk_config.c:117
if (staged->printer_name[0] == '\0')    return ESP_ERR_INVALID_ARG;
```

Nothing needs that value any more. The first claim overwrites it — including
with `""` when the bridge drives no printer, which `apply_assignments` does
happily. So the check now rejects a configuration the firmware itself creates
thirty seconds later.

Until it goes, the web provisioning flow writes the literal string
`(unassigned)` to `7a1c0003` so commit succeeds. It survives until the first
claim and shows up in `status` as `"printer":"(unassigned)"` while it lasts. It
is a placeholder to work around one `if`, and it is marked as such in
`BridgeProvisioningService.ts`.

**Please delete that line.** Then `printer_name` can go from the provisioning
write entirely and a bridge is set up with Wi-Fi and credentials alone — which is
what a board that learns its peripherals over HTTP should need. Worth deciding at
the same time whether `7a1c0003` stays as a characteristic at all; we would stop
writing it either way, and leaving it costs you nothing but is one more thing
that reads as required.

## Unchanged

Everything you listed: device token exchange, the raster format and its 11,200
bytes, `ack`/`nack`, `backoffMs`, job expiry and attempt accounting, and every
existing field on the claim.
