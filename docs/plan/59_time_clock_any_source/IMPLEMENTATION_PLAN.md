# Plan 59 — The time clock from any source

Clock-ins and clock-outs from iPads (offline-first), the website and a phone app, in any
combination. This is the server's half of iOS Plan 44
(`patrolkit_ios/docs/plan/44_time_clock_any_source/`), driven from here.

**The edge cases are the source of truth.** The 30 cases in §8 were decided one by one with
the user, and §1–§6 give exactly those answers with as little logic as possible. Each rule
cites the cases it serves. Where iOS Plan 44 says otherwise, this plan wins; §7 lists what
changes on the iPad.

It also fixes Plan 43's server-side failures: B3/C2 (a late auto clock-out beats a staff
close), B9 (nobody sweeps a resort without a working iPad) and B10 (a reopened entry is
re-sent forever).

**Ground rules:**
- Time tracking isn't in real use yet. The new fold may re-fold any existing entry, with no
  backfill or cutoff. There are no old iPad builds to keep working (E10): every time clock
  iPad gets the new build before rollout.
- The migration is additive, and still needs the user's yes before it reaches production.
- The server ships before the iPad sends anything new, because `ClockEventSchema` is
  `.strict()`.

---

## 1. The rules

| # | Rule | Cases |
|---|---|---|
| R1 | **One log, many sources.** Every clock-in and clock-out is an event in the patroller's log. The server replays the whole log in order, and that replay (the fold) is the only truth. Sources: `device` and `device_auto` (iPad), `member` (the patroller, on a phone or the web), `admin` (staff) and `auto` (the server's sweep). | all |
| R2 | **One shift at a time; nothing supersedes.** A clock-in while a shift is open, at any resort, is a `duplicate`, and the shift keeps its earlier start and resort. A staff edit never turns a duplicate back into a shift of its own. | E9, E17, E19, E20, E26 |
| R3 | **Every clock-out names its shift** (`entryId`, required). It closes the open shift if it names that shift or a duplicate folded into it; otherwise it's an `orphan`. A shift's id is its first clock-in's id. | E10, E17, E20 |
| R4 | **The earliest close wins,** whoever made it. The server's sweep counts as happening at the sweep moment (03:00), even though it closes the shift at its auto time (12:00). So a clock-out dated before 03:00 beats it, and one dated after is too late. A losing close is an `orphan`, kept in the history. | E3, E4, E12, E15, E19 |
| R5 | **Only the server sweeps.** Each shift still open at its sweep moment gets an auto clock-out at min(clock-in + window, sweep), under the policy in force when the sweep runs. The window is elapsed hours; the sweep time is resort-local. It runs at startup, every 5 minutes, and for a patroller just before any event of hers reaches a route. An iPad still sweeps for its own screen, but the server ignores its auto clock-outs. A reopened shift is open like any other, so it's swept again. The sweep is always on, and shifts never span the sweep time: an org sets it outside its working hours. | E2, E5, E11, E12, E13, E14, E27, E28 |
| R6 | **No second clock-in.** The phone and the website are refused while she has an open shift (409 `on_shift`, with that shift). The client asks her to close it first, at a clock-out time she chooses between its clock-in and now; at the same resort it offers "clock out and back in" or nothing. An iPad keeps every open shift in the org and never clocks in someone it knows is on shift, even offline: at its own resort it offers only a clock-out, and for a shift elsewhere it asks her to close it first, at a time she chooses. An offline iPad that hasn't heard of the shift clocks her in anyway, and R2 makes that a duplicate. | E1, E8, E9, E25, E29 |
| R7 | **The phone and the website are online only,** with no offline queue, and use the server's clock: a `member` event happens when the server receives it. R6's chosen clock-out is the only earlier time a patroller can give. An iPad keeps its own time. | E1, E12, E30 |
| R8 | **Staff add whole shifts.** A shift staff add can't overlap another of hers (409 `overlaps`), and needs its clock-out once its sweep moment has passed (400 `needs_clock_out`). Staff close, reopen and correct shifts as today, and can now remove one. | E6, E7, E11 |
| R9 | **Patrollers.** A patroller acts only on herself, while on the roster, active, and Time Clock is on. A clock-in from an iPad for someone inactive or removed is accepted and flagged, because it was real. Someone added while an iPad is offline isn't on its roster until it syncs. | E16, E23, E24 |
| R10 | **Switching Time Clock off clocks everyone out** at that moment. While it's off, the server refuses clock events, and an iPad that learns this discards its pending events and shows "Time Clock isn't turned on for this organization." | E18 |
| R11 | **An iPad's resort is set only on the iPad:** asked for at first setup, and changed from the iPad's settings, which needs a connection. The website can't set or clear it. A provisioned iPad stays in service until it's removed. | E21 |
| R12 | **Removing an iPad is destructive.** Staff acknowledge what's lost before removing an iPad or reissuing its code. Once its credentials stop working, the iPad deletes all its local data. | E22 |

Location (iOS D8) stays as planned: a `member` event may carry where it was sent from, staff
see it in the history, and it's never required.

---

## 2. Schema and contracts

`TimeClockEvent` gains, all nullable:

| Column | Holds |
|---|---|
| `entryId` | The shift a clock-out names (R3), also on every close the server writes |
| `sweepAt` | A server sweep's sweep moment, which is where the fold places it (R4) |
| `latitude`, `longitude`, `accuracyM` | Where a `member` event was sent from |

- **Sources:** `EVENT_SOURCES` adds `member` and `auto`. A device may still send only
  `device` and `device_auto`.
- **`ClockEventSchema`** (the iPad's batch): `entryId`, required on a clock-out and refused on
  a clock-in (R3).
- **Status notes:** `chosen_time` (a patroller's chosen clock-out), `inactive_patroller`
  (R9), `kept_duplicate` (R2), `server_sweeps` (an iPad's ignored auto, R5).
- **`PatrollerLogResponse`** events add `entryId`, `sweepAt` and the location; `api.types.ts`
  follows.
- **`superseded`** leaves the fold's close reasons, and reports and the web stop expecting it.

**Server-written ids:** `admin-close:<entryId>`, `admin-deactivate:<entryId>`,
`admin-disable:<entryId>` (R10), `admin-in:<uuid>` (a shift staff add) and `sweep:<entryId>:<n>`, where n counts that shift's sweeps
from 1. An iPad's own `auto:<entryId>` never clashes with them.

---

## 3. The fold

A pure function of the log, as today, now reading `entryId` and `sweepAt`. Events are placed
at `occurredAt`, except an event whose source is still `auto` (a server sweep), which is
placed at its `sweepAt` (R4); ties go by id. A sweep that staff correct becomes `admin`, so it
moves to its corrected time (E26).
Voided events are skipped, except that a voided duplicate still counts as its shift's alias.

1. **Clock-in, no open shift:** opens one, with the clock-in's id.
2. **Clock-in, a shift open:** `duplicate`. The shift keeps its id as an alias (R2).
3. **Clock-out naming the open shift or an alias:** closes it, at its `occurredAt`. `admin`
   gives `admin`, `auto` gives `auto` (flagged), and anything else gives `manual`.
4. **Any other clock-out:** `orphan`. That includes every iPad auto (`server_sweeps`), and a
   clock-out dated before its clock-in.

The fold records each duplicate's shift as its `entryId`, so a staff edit can find the
shift's duplicates. A clock-out stored before Plan 59, naming nothing, closes whatever is
open.

**A shift's id can change (E20).** When an iPad's earlier clock-in arrives late, the replay
opens the shift at that clock-in and tombstones the shift the phone saw. Clients follow the
server's shift, and a clock-out naming the old id still closes it through the alias.

**Shared vectors** (both repos, byte for byte, from `scripts/tc-vectors.cjs`):
- the standard flows: in and out on one iPad, on the phone, and mixed (in on either, out on
  the other);
- iOS SERVER_REQUEST §2's cases, updated: no supersede, an iPad's auto changes nothing, and
  a staff close dated after the sweep moment loses to the sweep (R4);
- a duplicate clock-in at the same resort, at another resort, and dated before the shift's
  first clock-in (E17, E19, E20);
- a clock-out naming a duplicate's id;
- the earliest close: a staff close, a deactivation, and a sweep against a clock-out before
  and after the sweep moment (E3, E4, E12, E15);
- both daylight-saving nights (E13);
- a staff correction that keeps a duplicate a duplicate (E26).

---

## 4. Ingest, the sweep and switching off

**An iPad's batch:**
- **Its `auto:<x>`:** stored, and changes nothing (R5).
- **A clock-in from someone inactive or removed:** noted `inactive_patroller`, and its shift
  is flagged (R9). Removal is a soft delete, so her profile is still there to hold the event,
  and removing her already closed any earlier shift.
- **Validation:** unchanged. One malformed event fails the whole batch with a 400; an unknown
  resort or patroller, a source a device may not send, and an implausible clock are
  `rejected` per event, so the iPad's batch split (iOS D10) still applies. Time Clock off is
  already a 403 (R10).

**The sweep (R5):** one function, `sweep(orgId, patrollerId?)`.
- **When:** at startup, then every 5 minutes, one run at a time, from a timer started in
  `onModuleInit` (no scheduler library). The patroller routes and the staff shift route
  also call it for that patroller before handling an event, so nothing reaches her log ahead
  of a due sweep (E2, E12). An iPad batch is followed by a sweep of its patrollers, so an old
  clock-in arriving late is closed at once.
- **What:** every shift open now whose sweep moment has passed, reopened ones included (E5,
  E11).
- **Writes:** `sweep:<entryId>:<n>`, source `auto`, with `entryId` and `sweepAt`, timed
  min(clock-in + window, sweep) under the current policy; then it re-folds the patroller.
- **Overview:** the "Past auto clock-out" tag now shows for minutes at most, as the sign that
  the sweep is behind.

**Switching Time Clock off (R10):** right after the switch, every open shift gets
`admin-disable:<entryId>` dated now, through `ClockOutService` as deactivation does. Events
are already refused by then, so nothing slips in between.
`devices/me` already reports which modules are on, so an iPad learns it without sending
anything. Turning it back on starts clean.

---

## 5. Routes

### A patroller: `me/orgs/:orgId/time-clock/…`

On the roster, active, and Time Clock on; otherwise 403 (R9).

| Route | Does |
|---|---|
| `GET shift` | `{ entry }`: my open shift, or null |
| `POST events` `{ id, type: "clock_in", resortId, dutyType, dutyNote?, location? }` | Clocks me in, or 409 `on_shift` with my open shift (R6) |
| `POST events` `{ id, type: "clock_out", entryId, chosenAt?, location? }` | Clocks me out of that shift |
| `GET entries?take=` | My recent shifts, newest first |

- **Time (R7):** `occurredAt` is the server's receive time, or `chosenAt` when given:
  between the shift's clock-in and now, noted `chosen_time`. "Clock out and back in" is two
  calls.
- **The response** is `{ event: { id, status, note }, entry }`, so the client shows the
  server's answer. A clock-out that came too late (E12) gets `orphan` and the shift as it
  stands.
- **Retries:** the same id returns the held result.
- **Ownership:** `entryId` must be one of my own shifts or its aliases.

### Staff: `POST orgs/:orgId/time-clock/patrollers/:patrollerId/shifts` (`time_tracking:manage`)

- **Body:** `{ resortId, dutyType, dutyNote?, clockInAt, clockOutAt? }`. It writes an `admin`
  clock-in, and an `admin-close` when `clockOutAt` is given.
- **Checks (R8):** times in the past, up to 5 minutes ahead; no overlap, using
  `assertNoOverlap` from corrections (409 `overlaps`); `clockOutAt` required once the sweep
  moment has passed (400 `needs_clock_out`).
- **Corrections** (close, reopen, correct, through `PATCH entries/:entryId`) work as today,
  except that each first voids the shift's duplicate clock-ins, noted `kept_duplicate`, so
  the replay can't turn one into a shift of its own (R2, E26). Reopening sets aside every
  close of the shift, not only the one that won, so a close it lost to can't close it again
  on the replay; the sweep then closes it with the next id (E5, E11).
- **Removing a shift** (new, `DELETE entries/:entryId`, E7): voids every event of that
  shift, its duplicates included, audits it, and re-folds.

### Devices (R11, R12)

- **Resort only from the iPad:** `PATCH orgs/:orgId/devices/:id/resort` refuses time clock
  iPads, and creating one no longer takes a resort; `PATCH devices/me/resort` is the only
  way. Signage displays keep the website route.
- **No out-of-service state:** a tablet's resort can't be cleared from the website. The
  legacy `time_clock.terminal` role, which no production iPad uses, keeps its old route.
- **Removing or reissuing:** the website shows when the iPad was last online and that
  anything it hasn't sent since will be lost, and staff tick that they understand. The server
  needs nothing new: the old credentials stop working.

---

## 6. The harness seed

- **Member sessions:** `tc-harness-seed.mjs` signs Ann and Ben in as it does the staff
  account, with no permissions, and prints `members: { ann: { accessToken, refreshToken },
  ben: … }`, both locally and with `--test-org`.
- **Resorts (R11):** devices are created without a resort, then bound through
  `devices/me/resort` with each device's own token. `--sim` does the same.

---

## 7. What changes for the iPad (iOS Plan 44)

These are the iOS session's tasks.

| Plan 44 | Now |
|---|---|
| D3: `entryId` on clock-outs, optional for old builds | Required on every clock-out; no old builds (R3, E10) |
| D4: clocking in elsewhere ends the old shift ("clocking in here ends it") | It never clocks in someone it knows is on shift, even offline. At its own resort it offers only a clock-out; for a shift elsewhere it asks her to close that shift first, and sends that clock-out dated at the time she chose. Offline and unaware, it clocks her in, and the server makes that a duplicate (R2, R6, E29) |
| D5: the iPad sweeps; the server's answer agrees | The iPad sweeps only for its own screen. The server ignores its autos and sends its own sweep back (R5) |
| D7: a reopened shift is never swept again | Dropped: the server sweeps it again (R5) |
| D10–D12 | Unchanged |
| (new) | Keep every open shift in the org: the entries walk without `resortId`, which the iPad already does (R6, E25) |
| (new) | Show the server's shift when its id or start changes (E20) |
| (new) | Time Clock off: discard pending events and show "Time Clock isn't turned on for this organization." (R10) |
| (new) | Ask for the resort at first setup; none from the website (R11) |
| (new) | When its credentials stop working, delete all local data, then show setup (R12) |
| Scenarios | B8, C3 and M4 expect one shift (R2) or the prompt (R6), not `superseded`; B9 expects the server's sweep. New ones from §8: E1, E8, E11, E16–E20, E22, E24, E25, E28, E29 |

---

## 8. The edge cases (source of truth)

The timelines are on the [Time Clock Edge Cases](https://claude.ai/artifact/WH77GRWhatBjH9iBtqrygi)
page. Times are resort-local, with the default policy (03:00, 4h).

| # | Situation | Decided |
|---|---|---|
| E1 | In at Lodge 08:00 (iPad, then offline). In at Summit Tue 02:00 (phone). | The phone asks her to close Lodge first, at a clock-out time she chooses (08:00 to now). Cancelling changes nothing. |
| E2 | In 08:00 (phone, no iPad at that resort). Server down overnight. In Tue 09:01 (phone). | The startup sweep closes Monday at 12:00 `auto`, and the clock-in goes through. |
| E3 | In 08:00 (iPad, offline from 10:00), out 16:00 held. Server sweeps (12:00 `auto`). iPad syncs Tue 10:00. | 08:00 → 16:00 `manual`. It reads 12:00 `auto` until the iPad syncs. |
| E4 | In 08:00 (iPad, offline from 10:00), out 15:00 held. Staff close 16:00. iPad syncs 17:00. | 08:00 → 15:00 `manual`; the staff close is discarded. |
| E5 | In 08:00, out 16:00 (iPad). Staff reopen Wed. | Swept again: 08:00 → 12:00 `auto`. |
| E6 | Staff clock her in Wed, backdated to Mon 08:00, with no clock-out. | Staff must enter the whole shift; the clock-in alone is refused. |
| E7 | In 08:00, out 12:00 (iPad). Staff clock her in at Summit, backdated to 10:00. | Refused as an overlap. Staff correct or remove the existing shift. |
| E8 | In 08:00 (iPad). In at Lodge 10:00 (phone). | The phone says she's already clocked in and offers "clock out and back in" or nothing. |
| E9 | In at Lodge (iPad) and at Summit (phone), same second. | One shift. |
| E10 | An old iPad build sends a clock-out with no `entryId`. | Not supported. |
| E11 | In 08:00 (iPad). Swept (12:00 `auto`). Staff reopen Wed. | Normal rules: swept again (12:00 `auto`). Staff who know the real time edit the clock-out instead. |
| E12 | In 08:00 (iPad). Swept at Tue 03:00. Out Tue 03:01 (phone). | The sweep is first; the phone's clock-out changes nothing. |
| E13 | In 23:30 on a daylight-saving night, forgotten. | Actual hours: spring forward closes at 03:00 (2.5h), fall back at 02:30 (4h). |
| E14 | In Tue 08:00 (iPad, offline from 10:00). Staff change the policy to 02:00 / 6h. | The server's auto clock-out stands: 14:00. |
| E15 | In 08:00 (iPad, offline from 10:00), out 15:00 held. Staff deactivate her 16:00. | The earlier close wins: 08:00 → 15:00. She stays inactive. |
| E16 | Staff deactivate her 09:00. In 10:00 on an offline iPad. | Accepted and flagged; normal rules close it. |
| E17 | In 08:00 (phone). In 08:05 on the same resort's offline iPad. | One shift from 08:00. |
| E18 | In 08:00 (iPad). Time Clock switched off at 12:00. | Everyone clocked out at 12:00. iPads discard pending data and show the "not turned on" screen. |
| E19 | In 08:00 at Lodge (iPad). In 23:00 at Summit's offline iPad. | One shift from 08:00 at Lodge. If nobody clocks out, the simple auto rule: 08:00 → 12:00, flagged for staff. |
| E20 | In 08:00 (iPad, offline, held). In 09:00 (phone). iPad syncs. | One shift from 08:00; the iPad and the phone both show it. |
| E21 | Staff move an offline iPad to another resort on the website. | Can't happen: the resort is set only on the iPad. |
| E22 | Staff remove an iPad, or reissue its code, while it holds events. | Staff must acknowledge the loss. The iPad deletes its local data once unprovisioned. |
| E23 | A patroller added while an iPad is offline. | She can't clock in on that iPad until it syncs. |
| E24 | Staff remove her from the roster 09:00. In 10:00 on an offline iPad. | Like E16: accepted and flagged; normal rules close it. |
| E25 | In 08:00 at Lodge (iPad, online). In 10:00 at Summit's online iPad. | Summit's iPad asks her to close Lodge first, as the phone does (E1). |
| E26 | E19, then Wed staff correct Lodge's clock-out to Mon 16:00 (web). | Still one shift, 08:00 → 16:00. Summit's 23:00 clock-in stays a duplicate; if she worked then, staff add that shift. |
| E27 | In 20:00 (iPad), out Tue 04:00, across the 03:00 sweep. | Doesn't happen: shifts never span the sweep time. The org sets it outside its working hours; the sweep can't be turned off. |
| E28 | In 08:00 (phone). At 16:00, Summit's iPad (offline since 07:00) shows her not clocked in. | The auto rule stands: 08:00 → 12:00, flagged. She can always clock out on the phone she clocked in with. Nothing new on the iPad. |
| E29 | In 08:00 for patrol (iPad). At 11:00, offline, she wants to switch to training on the same iPad. | The iPad shows her clocked in and offers only a clock-out. She clocks out, then clocks in for training. |
| E30 | Her phone has no signal at 09:00. | It can't clock her in: the phone and the website have no offline queue. She uses an iPad. |

---

## 9. Tasks

| # | Task | Depends on |
|---|---|---|
| **Server** | | |
| T1 | Migration and contracts (§2) | — |
| T2 | The fold and the vectors (§3) | T1 |
| T3 | Ingest, the sweep and switching off (§4) | T2 |
| T4 | The patroller routes (§5) | T3 |
| T5 | The staff shift route, removing a shift, and corrections keeping duplicates (§5) | T3 |
| T6 | Devices: resort only from the iPad, no out-of-service state, the removal acknowledgement (§5) | — |
| T7 | The harness seed (§6) | T4, T6 |
| T8 | Deploy (with the user's yes for the migration), then smoke in `patrolkit-time-clock-tests` | T1–T7 |
| **iPad** (sent to the iOS session from here) | | |
| I-1 | §7's changes, plus Plan 44's D10–D12 | T8 for anything that sends new fields; the rest can start now |
| I-2 | The fake server and `ReferenceFold` follow §3 and §4; copy the vectors | T2 |
| I-3 | Scenarios from §8, updated B8, B9, C3, M4, N9 and invariant I11 (one applied auto per shift); then L2, L3 locally and in the test org, L4 | T8, I-1, I-2 |

**Server tests:**
- **The fold:** unit tests and the vectors.
- **The sweep:** startup catch-up, a sweep for one patroller before a route event, a
  re-sweep after a reopen, a policy change, daylight saving.
- **Ingest:** an iPad auto changing nothing, an inactive or removed patroller.
- **Routes:** the guards, `on_shift`, `chosenAt` bounds, retries, someone else's `entryId`,
  `overlaps`, `needs_clock_out`, a correction keeping a duplicate a duplicate, and removing a
  shift.
- **Switching off:** every open shift closed in the same transaction.
- **Devices:** the website route refusing a time clock iPad, and binding through
  `devices/me/resort`.

**Later, in their own plans:** the website's clock screens and the phone app, both on §5.
