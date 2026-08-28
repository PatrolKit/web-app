# Firmware handoff — print latency and the provisioning button

Written against `webprinter_esp32` at the commit that has `pk_proto_claim` using a
20-second HTTP timeout and `net_client.c` flushing results at the top of its loop.

Nothing here is breaking. The server changed this week and the firmware kept
working throughout, by design — every change was checked against what the board
already does before it shipped. What follows is one question that could strand a
user, and two refinements that the server cannot make on its own.

---

## 0. What changed on the server, so the timings make sense

**An empty claim is now held open.** `POST /devices/me/print-jobs/claim` used to
answer "nothing for you" immediately and hand back `backoffMs: 5000`. It now
holds the request for up to **10 seconds** and answers the moment a job is
queued, then hands back `backoffMs: 1000`.

This took the gap between a seller pressing print and the bridge receiving the
job from up to 5000 ms down to 52 ms, measured end to end.

Two things made it safe without touching the firmware:

- `pk_proto_claim` passes a 20 000 ms timeout to `http_do`
  (`main/pk_protocol.c:354`), so a 10-second hold has 10 seconds of headroom.
- `backoffMs` is clamped to `PK_BACKOFF_MIN_MS`…`PK_BACKOFF_MAX_MS`
  (250…60 000, `main/pk_protocol.h:43`), so the new value of 1000 passes through
  unchanged.
- The task watchdog is 30 s and the net task is not subscribed to it, so a
  10-second block cannot trip it. A slow server could already block that task for
  up to 20 s before any of this.

**The server never holds a bridge that still owes an acknowledgement.** While a
station has a job in `claimed` state, its claims are answered immediately. This
exists because acks leave the board only between requests — see §2 — and parking
a mid-print bridge in a 10-second hold sat on the message saying the paper came
out. Measured at 9054 ms before the guard, 110 ms after.

---

## 1. Question first: which button clears provisioning?

**This one can strand a user, so it is worth answering before either change.**

`README.md` says:

> Hold the **BOOT** button (GPIO0 on the ESP32-CAM-MB base) for 5 seconds.

The web UI now tells people to hold **RESET**, because that is what the boards in
use are labelled. Those are not interchangeable on a standard ESP32 board: `EN` /
`RESET` is a hardware reset that never runs firmware, so if the erase is bound to
GPIO0 and someone presses `EN`, nothing is cleared, the board comes back latched,
and every Bluetooth write is refused with no explanation that fits.

Please confirm and reply with:

1. The **GPIO** the factory-reset hold is bound to.
2. The **silkscreen label** on that pin on the hardware actually being deployed.
3. Whether the hold must happen while powering on, or at any time — the UI
   currently says "press and hold before making changes", and the README says
   "hold for 5 seconds", which are different instructions.

If the answer is that the erase is on GPIO0 and the boards say `BOOT`, say so and
the web copy gets corrected — it is a one-line change on our side and much
cheaper than a volunteer holding the wrong button at a venue.

---

## 2. Wake from the backoff when a print finishes

**Priority: medium. Removes up to one second from a spinner the seller is
watching.**

### Why

`flush_results()` runs at the top of the loop, immediately before the claim
(`main/net_client.c:192`), so a print result can only leave the board *between*
requests. The printer task finishes asynchronously and posts to `s_results`
(`main/net_client.c:91`); the net task is meanwhile sleeping out its backoff:

```c
vTaskDelay(pdMS_TO_TICKS(ctx.backoff_ms));   // main/net_client.c:247
```

A print that completes one millisecond into that sleep waits the whole `backoff_ms`
before anything is sent. The seller's screen shows "Printing…" until the ack
lands, so that sleep is visible to a person standing at the printer.

The server-side guard in §0 covers the *other* window — a print finishing while
the board is blocked in a held claim, which only the server can end. It cannot
help here: nothing on the server knows the board is sitting in `vTaskDelay`.
These two changes are complementary, not alternatives.

### What

Replace the unconditional sleep on the **`ESP_OK` path only** with a bounded wait
on the result queue, so a finished print ends the sleep early:

```c
case ESP_OK:
    mark_up();
    /* ...dispatch claimed jobs, link logging, unchanged... */

    // Sleep out the backoff, but not through a finished print: the report is
    // what the seller's screen is waiting on, and it can only be sent from the
    // top of this loop. Peek rather than receive — flush_results() still needs
    // the message.
    {
        result_msg_t pending;
        xQueuePeek(s_results, &pending, pdMS_TO_TICKS(ctx.backoff_ms));
    }
    break;
```

`xQueuePeek` returns as soon as an item is available and leaves it queued, or
returns `pdFALSE` when the timeout expires. Either way the loop continues to
`flush_results()`, which is already correct. If a result is already waiting when
this is reached, it returns immediately — also correct.

### What not to change

Leave the `vTaskDelay` on the error paths alone, including the one at
`main/net_client.c:275`. Those back off *because the network is unhappy*, and
acks would fail for the same reason — waking early there would hammer a server
that is already struggling.

### How to check it

With a job queued and a printer that takes noticeably longer than `backoff_ms`
to print — a real Phomemo pushing an 11 200-byte raster does — the ack should
reach the server within tens of milliseconds of the paper finishing, not up to a
second later. Server-side, `PrintJob.status` flips `claimed` → `printed` at that
moment, and the check-in screen swaps its spinner for a tick.

Note for testing: a simulated print that finishes *faster* than `backoff_ms` will
not show the difference, because the sleep expires first either way. That is how
this was nearly missed — a 400 ms fake print measured no change, and only a 3 s
one revealed the gap.

---

## 3. Declare the claim wait explicitly

**Priority: medium. Prevents a silent breakage rather than fixing a current one.**

### Why

The server holding a claim for 10 s works today because the firmware happens to
allow 20 s. That is an agreement neither side states. If someone tunes the
firmware timeout down to 5 s for good reasons, claims start failing as transport
errors with nothing pointing at the cause; if someone raises the server's hold,
the same. Both sides would be individually reasonable and the system would break.

The client is the only party that knows its own timeout, so it should be the one
that says how long it may be held.

### What

Send a `wait` query parameter on claims, derived from the firmware's own HTTP
timeout with headroom for the response and TLS:

```c
// pk_proto_claim, main/pk_protocol.c — near the existing url snprintf
#define PK_CLAIM_TIMEOUT_MS 20000
// Half the timeout, so a held claim still has room to answer and be read.
#define PK_CLAIM_WAIT_MS    (PK_CLAIM_TIMEOUT_MS / 2)

snprintf(url, sizeof(url),
         "%s/api/v1/devices/me/print-jobs/claim?limit=%u&wait=%u",
         ctx->base_url, (unsigned)limit,
         limit == 0 ? 0u : (unsigned)PK_CLAIM_WAIT_MS);
```

Two properties worth keeping:

- **Derive `wait` from the timeout**, rather than writing 10000 twice. The point
  is that changing one changes the other.
- **Send `wait=0` when `limit == 0`.** A heartbeat carries the printer link and
  proves the board is alive; it should never be held. The server already refuses
  to hold those, but saying so makes the request self-describing.

The server clamps `wait` to its own maximum, so asking for more than it will give
is harmless — it is a ceiling the client sets, not a demand.

### How to check it

An empty claim with `wait=10000` should take about ten seconds and return
`{"jobs": []}`. The same claim with `wait=0` should return immediately. Queueing
a job during the held request should end it early, with the job in the response.

---

## What deliberately did not change

- **`LINK_REFRESH_MS` (30 s, `main/net_client.c:35`).** Fine as it stands. A
  `down` link is reported on every claim, which is the case that matters, and a
  healthy one being re-stated every 30 s is enough for the station screen. No
  change wanted.
- **`state: "online"` reporting.** `mark_up()` is called only after a claim
  returns `ESP_OK` (`main/net_client.c:222`), so the board cannot report online
  without the server having accepted an authenticated request. That is exactly
  the right bar, and the web UI relies on it. Please keep it that way — reporting
  online on Wi-Fi association instead would make the status claim more than it
  knows.
- **The provisioning latch.** Working as intended. It is inconvenient by design
  and the UI now explains the cost at the point someone would hit it.

---

## Contract summary, after these changes

| | |
|---|---|
| `POST /devices/me/print-jobs/claim?limit=N&wait=M` | `wait` in ms, clamped by the server. `limit=0` is a heartbeat and is never held. |
| Held empty claim | Up to 10 s, or until a job is queued, whichever is first. |
| Never held | While the station has a job in `claimed` state — the board owes an ack. |
| `backoffMs` in the response | 1000 active or idle. Still clamped to 250…60 000 on the board. |
| Claim HTTP timeout | 20 000 ms, and `wait` must stay comfortably under it. |
