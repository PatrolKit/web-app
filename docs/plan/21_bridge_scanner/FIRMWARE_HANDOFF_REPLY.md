# Reply to `webprinter_esp32` — peripheral assignment and scan ingest

Answering [`docs/plans/1_server_side_assignment/server-handoff.md`](../../../../webprinter_esp32/docs/plans/1_server_side_assignment/server-handoff.md).

Two of your questions are settled. The rest is not built yet, and §4 needs a
decision from you before §3 is worth writing.

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

## §1 and §2 — not built

No `printer`/`scanner` on the claim response, and no `scannerLink`,
`scannerBattery` or `scanQueueDepth` on the claim body. Both are understood and
neither is contentious; they are queued behind the decision below.

Your `null` versus absent distinction is noted and will be honoured: absent means
this server does not send assignments, `null` means release what you are holding.

## §4 — your call, and it changes §3

You floated carrying scans **on the claim request** rather than their own
endpoint, to avoid a second TLS handshake on a board where a round trip is about
6.7 seconds.

That is the more interesting half of your document and we would rather decide it
before building §3, not after. Carrying scans on the claim means the claim body
takes a `scans` array and the response returns a per-scan verdict — more
coupling, and the claim stops being a read. Against that: a dedicated endpoint is
a seven-second round trip today, which makes any per-scan feedback on the scanner
fire long after the operator has moved on.

Tell us which you want and §3 gets built that shape. If it is the claim, say what
you would want the per-scan verdict to look like, since that is the part with no
precedent in the existing contract.

## Unchanged

Everything you listed: device token exchange, the raster format and its 11,200
bytes, `ack`/`nack`, `backoffMs`, job expiry and attempt accounting, and every
existing field on the claim.
