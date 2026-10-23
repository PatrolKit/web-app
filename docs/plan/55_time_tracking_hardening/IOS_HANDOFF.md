# iOS handoff: the time clock's sync catches up with Ski Swap's (server Plan 55)

The server now pages the time clock's deltas the way it pages items (iOS Plan 17 E), tells a terminal when a shift goes away, and stops trusting a few fields a terminal sends. **Nothing here is a hard cutover.** Builds in the field keep working unchanged; the changes below make the iPad correct as a season's data piles up.

Server details: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## What changed on the server

| | Before | Now |
|---|---|---|
| `GET …/time-clock/shifts?updatedSince=` | A bare array, capped at 2,000, every open shift plus what changed | Unchanged for builds that send nothing new, except that it never carries a removed shift |
| `GET …/time-clock/shifts?walk=true[&updatedSince=][&after=]` | — | `{ shifts, total, syncedAt, nextAfter? }`, 500 a page in `(updatedAt, id)` order |
| `GET …/time-clock/patrollers?walk=true[&updatedSince=][&after=]` | — | `{ patrollers, syncedAt, nextAfter? }`, the same paging |
| A shift the server no longer produces | Deleted, so the iPad kept its copy forever | Kept with `deletedAt` set, and sent in a walk's delta |
| A shift's `updatedAt` | Moved on every event for that patroller | Moves only when the shift itself changed |
| Shift `nspId` | Sent | Gone (`APIShift.nspId` is already optional) |
| A terminal's roster: `email`, `phone`, `contactVerified` | Sent | Gone (`APIPatroller` doesn't decode them) |
| An event's `deviceId` | Trusted | Ignored; the token's device is recorded |
| An event with `source: "admin"` | Accepted | `rejected`, note `source_not_allowed` |
| Event result statuses | `applied`, `duplicate`, `orphan`, `anomalous`, `rejected` | Adds `voided`: a close staff set aside by reopening its shift |

`voided` needs nothing from the app: `TimeClockSyncEngine` treats every status except `rejected` as accepted (`TimeClockSyncEngine.swift:270`), and that's correct here. A terminal retrying a voided close, or a second iPad sending its auto clock-out late, is answered `voided` and should mark it synced.

## What the app should change

Found by a read of `patrolkit_ios` at `7e45d7b`:

- **`Services/TimeClockAPIClient.swift`**
  - `listShifts` (around line 87) and `listPatrollers` (around line 77): send `walk=true`, decode the page shape, and follow `nextAfter` with `after=` until it's absent.
  - `APIShift` gains `deletedAt: String?`.
- **`Services/TimeClockSyncEngine.swift`**
  - `refreshShifts` (around line 220) and the roster refresh (around line 200): store the response's `syncedAt` as the cursor, once the last page has landed, instead of the newest `updatedAt` received. A cursor taken from the rows can skip a row committed out of order. `syncedAt` is taken before the read, so the worst case is a row arriving twice, and an upsert doesn't mind.
  - Stop sending `deviceId` in events (around line 321). It's harmless either way.
- **`Services/PatrolKitStore+TimeClock.swift`**
  - `upsertShifts` (around line 288): delete the local row when `deletedAt` is set, instead of inserting it. Without this, a shift staff removed by correcting another one stays on the board.

A walk with no `updatedSince` returns every live shift in the org, with no tombstones, because a device holding nothing has nothing for one to remove. That's what a freshly provisioned terminal should send.

## Then, on hardware (iPad Plan 5, Phase 5)

None of these has been run on an iPad yet. The server side of each is covered by `smoke-time-clock.mjs` and `smoke-time-clock-concurrency.mjs`, which is not the same thing.

- **TC-T20:** the offline matrix (§9.3), in airplane mode.
- **TC-T21:** two-iPad convergence: clock in on A offline, out on B, and both reconcile. Repeat across two resorts. Time Tracking → Health lists an event whose resort differs from where its iPad is placed.
- **TC-T22:** auto clock-out convergence: two iPads at one resort, one awake at 03:00 and one catching up next morning, produce one row with the same timestamp. Then reopen that shift on the web and let the late iPad sync: it must stay open.
- **TC-T23:** pruning, and the 5,000-event pass. The server's side runs in about 20 ms per batch for a patroller with 150 shifts (`load-time-clock.mjs`).
- **TC-T24:** a wrong device clock. An event dated more than a day ahead is refused as `clock_implausible`, kept, and listed on Health.

Health also shows each terminal's last-seen time and app version. That's how to tell when every iPad runs a build that walks, so the bare-array responses can be retired.
