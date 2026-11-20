# iOS handoff — the time clock from any source (server Plan 59 → iOS Plan 44)

**From:** the server session. **To:** the iOS session.

The user decided to drive this work from the server side, since most of it is there. The
server's plan is [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) (Plan 59, commit a8e54ec).
This document gives you what we agreed and what the iPad must do.

**What we'd like back:** a new `IMPLEMENTATION_PLAN.md` for iOS Plan 44 that **replaces the
existing one**. Keep `SERVER_REQUEST.md` as history; Plan 59 answers it. Where Plan 44 and
this document differ, this document wins. If something here is unclear, or can't be built as
written, ask the server session before planning around it. Don't change the contract on the
iPad's side alone.

---

## 1. How it was decided

The user and the server session ran 30 edge cases, one at a time, each stating which device
did what. The user decided each outcome, and those outcomes are the source of truth. The
rules were then reworked to give exactly those answers with the least logic. The timelines,
with the decided result for each case, are on the
[Time Clock Edge Cases](https://claude.ai/artifact/WH77GRWhatBjH9iBtqrygi) page. The table is
in Plan 59 §8.

When there was a choice, the user asked for less logic and smaller code. Please plan the iPad
the same way.

---

## 2. The rules, as the iPad sees them

1. **One log, many sources.** iPads (`device`, `device_auto`), the patroller's phone or the
   website (`member`), staff (`admin`) and the server's sweep (`auto`) all write events to one
   log. The server's fold is the only truth, and the iPad shows what the server says.
2. **One shift at a time; nothing supersedes.** A clock-in while she has an open shift, at
   any resort, is a `duplicate`: the shift keeps its earlier start and resort. `superseded`
   is gone (E9, E17, E19, E20).
3. **Every clock-out names its shift** (`entryId`, required). It closes the open shift if it
   names that shift or a duplicate clock-in folded into it; otherwise it's an `orphan`. A
   shift's id is its first clock-in's id (E10, E17, E20).
4. **The earliest close wins.** The server's sweep counts as happening at the sweep moment
   (03:00), though it closes the shift at the auto time (12:00). A clock-out dated before 03:00
   beats it; one dated after is too late (E3, E4, E12, E15).
5. **Only the server sweeps.** It sweeps every shift at startup, every 5 minutes, and just
   before any phone or staff event, under the policy in force when it sweeps. A reopened shift
   is swept again. The server **ignores the iPad's auto clock-outs**: they're stored as
   `orphan`, noted `server_sweeps`. The iPad may still sweep for its own screen (E2, E5, E11,
   E14, E28).
6. **No second clock-in.** The iPad keeps every open shift in the org and never clocks in
   someone it knows is on shift, even offline (E25, E29):
   - **On shift at this resort:** she's shown clocked in and offered only a clock-out.
   - **On shift at another resort:** the iPad asks her to close that shift first, at a
     clock-out time she chooses between its clock-in and now. Then she can clock in here.
   - **Offline and unaware of the shift:** the iPad clocks her in, and the server makes that
     a duplicate (E17, E19).
7. **The phone and the website are online only,** with no offline queue (E30). Only the
   iPad works offline.
8. **Patrollers:** a clock-in from someone staff just made inactive or removed is accepted
   and flagged, because it was real (E16, E24). Someone added while the iPad is offline isn't
   on its roster until it syncs (E23).
9. **Switching Time Clock off** clocks everyone out at that moment. The server refuses clock
   events while it's off. The iPad discards its pending events and shows "Time Clock isn't
   turned on for this organization." (E18)
10. **The iPad's resort is set only on the iPad:** asked for at first setup, and changed from
    the iPad's settings, which needs a connection. The website can't set or clear it, and
    there's no out-of-service state (E21).
11. **Removing an iPad is destructive.** Staff acknowledge the loss on the website. Once the
    iPad's credentials stop working, it deletes all its local data (E22).

---

## 3. What the server provides

| Need | Server (Plan 59) |
|---|---|
| Clock-outs | `ClockEventSchema` requires `entryId` on a clock-out and refuses it on a clock-in. Live on patrolkit.io since 2026-11-20 (build 0344e76) |
| Open shifts everywhere | The entries walk without `resortId` (already the iPad's delta) |
| An iPad's auto | Accepted (not `rejected`), stored as `orphan`, noted `server_sweeps`; changes nothing |
| Server sweeps | Ids `sweep:<entryId>:<n>`, source `auto`; they reach the iPad like any other close. The server also sweeps a batch's patrollers right after it lands |
| Reopening | Staff reopening a shift sets aside every close of it, the iPad's included; a resend of one answers `voided` |
| Duplicates | Status `duplicate`; a later clock-out naming the duplicate's id closes the shift |
| A shift's id changing (E20) | The phone's shift is tombstoned and the earlier clock-in's shift replaces it, through the usual delta |
| Inactive or removed | Accepted, noted `inactive_patroller`, shift flagged |
| Time Clock off | `POST …/time-clock/events` → 403 (already). `devices/me` already lists the enabled modules |
| Resort | `PATCH devices/me/resort` is the only way to set it. Creating a time clock iPad no longer takes a resort |
| Removal or reissue | The old credentials stop working; nothing new on the wire |
| Validation | Unchanged: one malformed event fails the batch (400); unknown resort or patroller, a disallowed source and an implausible clock are `rejected` per event |
| A patroller's own clock | `GET me/orgs/:orgId/time-clock/shift` → `{ entry }`; `POST …/events`; 409 `on_shift` carries the shift in `details.entry`. For the harness, acting as her phone |
| Harness | `tc-harness-seed.mjs` adds `members: { ann, ben }` sessions (access and refresh tokens) for acting as their phones, locally and with `--test-org`; devices are bound through `devices/me/resort`; `--sim` the same |
| Shared vectors | `scripts/tc-vectors.cjs` (server T2): standard flows, the SERVER_REQUEST cases updated, duplicates, aliases, earliest close, daylight saving, E26 |

---

## 4. What the iPad must do

| # | Requirement | Cases |
|---|---|---|
| IR1 | **`entryId` on every clock-out**, from the row: the server's shift id, or a local clock-in's event id if it isn't confirmed yet. No fallback for old builds. | E10 |
| IR2 | **Keep every open shift in the org**, not just this resort's: the entries walk with no `resortId` already does. | E25 |
| IR3 | **No second clock-in.** Someone on shift at this resort gets only a clock-out. Someone on shift elsewhere is asked to close that shift first, at a time she chooses between its clock-in and now; the iPad writes a `device` clock-out naming that shift, dated at the chosen time, and then lets her clock in. This replaces Plan 44 D4 and its "clocking in here ends it" caption. `ShiftProjection` must stop letting a newer local clock-in replace an open shift. | E1, E8, E25, E29 |
| IR4 | **Follow the server's shift.** When the server's shift for a patroller has a different id or start than the local row (E20), show the server's. A local clock-in the server calls `duplicate` folds into her open shift, not a second row. | E17, E19, E20 |
| IR5 | **The server owns the sweep.** The iPad may keep sweeping locally so its board is right offline, but the server's sweep is the answer. Sending iPad autos is optional, since the server ignores them. Choose whichever is less code. Drop D7's prune clause. | E5, E11, E14 |
| IR6 | **Time Clock off.** When `devices/me` says Time Clock is off, or a batch gets a 403 and `devices/me` confirms it's off, discard pending time clock events and show "Time Clock isn't turned on for this organization." Any other 403 or 404 stays pending, as in D10. | E18 |
| IR7 | **Resort at first setup**, chosen on the iPad through `devices/me/resort`, and changed from Settings with a connection. Remove anything that expects a resort from the website or an out-of-service state. | E21 |
| IR8 | **Wipe on unprovisioning.** When the device credentials are refused for good (the token exchange rejects the client id or secret, not a passing 401), delete all local data, then show setup. | E22 |
| IR9 | **Keep D10–D12:** split a refused batch, a 2-minute backoff cap with a 401 retry, and skew stamped at write time. | — |

**Nothing new** for: a patroller added while offline (E23); clocking out at an offline iPad
that never heard of a phone shift (E28: the auto rule stands, and she can clock out on her
phone); the phone with no signal (E30); inactive or removed patrollers (E16, E24).

---

## 5. Plan 44 decisions: kept, changed, dropped

| Plan 44 | Now |
|---|---|
| D1 One log, many sources | Kept; adds `auto` for the server's sweep |
| D2 Online sources use the server's clock | Kept; the phone and web are also online only (E30) |
| D3 A clock-out names its entry; old builds fold as today | `entryId` is required; no old builds (IR1) |
| D4 Clocking in again ends the old shift | Replaced by "no second clock-in" (IR3) |
| D5 Both sweep, with one answer | Only the server sweeps; the iPad's are ignored (IR5) |
| D6 An auto yields to a real close | Replaced by "the earliest close wins, with the sweep at its sweep moment" (§2.4) |
| D7 A reopened entry is never swept again | Dropped: it's swept again (E5, E11) |
| D8 Location | Kept, for `member` events only; nothing on the iPad |
| D9 Who may act | Kept |
| D10–D12 | Kept (IR9) |

---

## 6. Tests

- **Shared vectors:** copy `apps/api/src/time-clock/__vectors__/` (both files, from
  `apps/api/scripts/tc-vectors.cjs`; 29 fold cases), and have
  `ReferenceFold` and the fake server follow Plan 59 §3 and §4.
- **Scenarios from the edge cases:** E1, E8, E11, E16–E20, E22, E24, E25, E28, E29.
- **Expectations that change:**
  - B8, C3, M4: one shift (R2) or the prompt (IR3), not `superseded`.
  - B9, M5, M6: the server's sweep; the iPad's auto is an `orphan` (`server_sweeps`), not a
    `duplicate`.
  - Invariant I11 (one applied auto per shift) still holds, and the applied one is the
    server's.
- **Then** L2 and L3 locally and in the test org, and L4 on the simulator.

---

## 7. Sequencing

The server is done and live on patrolkit.io (build 0344e76, 2026-11-20), so everything can
start now: the plan, IR1–IR9, the vectors and `ReferenceFold`, the scenarios, and the live L
runs.

Please reply with the new plan's path and any questions.
