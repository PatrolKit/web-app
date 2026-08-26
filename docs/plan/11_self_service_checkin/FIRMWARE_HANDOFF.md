# Firmware handoff — reconciling the HTTP contract

For whoever is working on `webprinter_esp32`. The server side of the print queue
is built and deployed; this is what it actually exposes, and what has to change
on each side to meet it.

`docs/PROTOCOL.md` in the firmware repo calls its endpoints provisional
placeholders in `main/pk_protocol.c`, so this replaces that file's contract and
nothing above it. The raster format section of that document is **correct and
stays** — the server is moving to match it.

## Who changes what

| | Change | Why |
|---|---|---|
| **Firmware** | Endpoints: poll → claim, result → ack/nack. Unwrap the response envelope. | These were always placeholders; the server's model carries station binding and retry accounting the poll model has nowhere to put. |
| **Server** | Payload: full ESC/POS → packed 1bpp raster, no feed rows. **Done.** | `phomemo.c` is byte-verified against the reference ESC/POS builder by `test/host/run.sh`, and print energy and speed are per-printer hardware tuning. Both belong on the device. |

Nothing else moves. `POST /api/v1/auth/device/token` is unchanged, and the
raster geometry — 400 dots wide, 50 bytes per row, MSB leftmost, 1 = burn — is
exactly what the server already produces internally.

## Bug to fix first: the response envelope

Every endpoint wraps its result. `pk_protocol.c` reads `accessToken` from the
root of the token response, so **authentication fails today** regardless of
anything else here:

```json
{ "success": true, "data": { "accessToken": "…", "tokenType": "Bearer" } }
```

Read through `data` on every 2xx. Errors are the same shape inverted, and the
message is worth logging:

```json
{ "success": false, "error": "Requires a device of role: Ski Swap - Network Printer Adapter" }
```

## The endpoints

All paths are under `/api/v1`. All three require
`Authorization: Bearer <accessToken>` and a device whose role is
`Ski Swap - Network Printer Adapter`; anything else gets `403`.

### Claim work

```
POST /devices/me/print-jobs/claim?limit=4
```

`limit` is clamped to 1–16 and defaults to 4.

```json
{ "success": true, "data": {
  "stationId": "cmt…",
  "backoffMs": 1000,
  "jobs": [ { "id": "cmt…", "kind": "item", "seq": 0, "payload": "<base64>" } ]
} }
```

- **This is not a long poll.** It returns immediately, empty if there is no work.
  `backoffMs` says how long to wait before asking again — 1000 while jobs are
  flowing, 5000 when idle. Honour it rather than choosing your own cadence; it is
  how the server tunes pickup latency against load, and a seller is stood at the
  printer waiting.
- **A batch, ordered.** Print in `seq` order, then `id` order. A seller's tags
  come out in the order they entered them.
- **`404` means this device is not bound to a station.** Not an error to retry
  around — it is a configuration problem a human fixes in the web UI. Surface it
  and back off hard rather than hammering.
- `kind` is `item`, `receipt_header`, `receipt_items`, `qr`, or `calibration`.
  Informational; every kind prints the same way.

### Report a result

```
POST /devices/me/print-jobs/{jobId}/ack     -> 204
POST /devices/me/print-jobs/{jobId}/nack    -> 204   { "error": "paper out" }
```

Two endpoints rather than one status field. `ack` is what sets `hasPrintedTag`
on the seller's item, so send it only when the printer has taken the whole job —
which is exactly the rule `PROTOCOL.md` already states.

`nack` returns the job to the queue for another attempt, and `error` (≤ 500
chars) is shown to staff on the stations screen. Send it for terminal failures
only; internal retries should stay invisible, as they are now.

An `ack` for a job already acked is accepted and does nothing, so a report lost
to a flaky network can be re-sent safely.

## What the server does that you should not duplicate

- **Claims expire after 90 seconds.** A job claimed and never acked or nacked
  returns to the queue on its own. If the board reboots mid-print, the work is
  not lost — do not build recovery for this.
- **Five attempts, then abandoned.** Every claim counts an attempt, whether or
  not you nack. After five the job stops being offered and is reported to staff
  as given up on. So a job that hangs a printer will not block its station
  forever, and the firmware needs no attempt cap of its own beyond the internal
  retries it already does.
- **Rendering happens at claim time**, against whichever printer the station is
  currently pointed at. Swap a Phomemo mid-swap and queued jobs re-render for the
  new paper size and margins. Nothing is cached; do not hold a job across a
  reconfiguration expecting it to still be right.

## Payload

Base64 of a packed 1bpp bitmap, exactly as `PROTOCOL.md` describes:

- 400 dots per row, 50 bytes, MSB is the leftmost dot, `1` = burn
- 224 rows for a 50 × 30 mm label → 11,200 bytes
- **No feed rows and no ESC/POS.** The firmware adds both.

This has shipped — `claim` returns a bare raster. The firmware's
`payload_is_escpos()` detection makes the transition a non-event either way, so
no cutover needed coordinating in the end.

The browser still receives full ESC/POS from
`POST /orgs/:orgId/ski-swap/printers/:printerId/labels`, because it writes those
bytes straight to a Phomemo over Web Bluetooth. Same layout, same renderer, two
wrappings — `toPrintJob` for the browser, `toRaster` for the bridge.

The golden fixtures in `apps/api/src/ski-swap/printing/__fixtures__/` are stored
in this exact packing, so a fixture *is* the payload a bridge is handed.

## Station binding

The claim response carries `stationId`. `docs/PROVISIONING.md` does not write a
station id to the board, and it does not need to: binding lives on the server,
where it can be changed when hardware dies mid-swap. If the firmware wants the
mismatch check described in the plan's D9, `stationId` is the value to compare
against — but it has to come from somewhere the web UI can update, not from
provisioning.

## Verifying against a real server

`apps/api/scripts/smoke-print-queue.mjs` in the server repo exercises the whole
queue — claim, ack, nack, expiry, the attempt cap, and role refusal — against a
live database. It is the fastest way to see the exact wire shapes, and it creates
and removes its own fixtures:

```bash
SMOKE_BASE=https://patrolkit.io/api/v1 node apps/api/scripts/smoke-print-queue.mjs
```
