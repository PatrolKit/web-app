# Plan 55: Time Tracking catches up with Ski Swap

> **Status:** phases 1–5 implemented and tested locally; not yet deployed. Phase 6 is [IOS_HANDOFF.md](IOS_HANDOFF.md). See "Where the build drifted" at the end.

## Goal

Make Time Tracking safe to put in front of a real patrol. Its design is sound: iPads send clock events, and the server replays each patroller's whole log into shifts (iPad Plan 5 §5.5). But it was built in a week and never used, and it lacks what Ski Swap learned over a season of real use:

- **Two bugs.** Correcting an open shift can move a different shift's clock-out. A terminal can claim to be an admin, or another device.
- **Sync that stays correct as data grows.** Today every event rewrites all of that patroller's shifts. Shifts come back as one capped array with a cursor the iPad makes up. A shift the fold drops is never reported to the iPads.
- **A record of who changed what.** A correction overwrites the times it replaces.
- **Tests that run the real pipeline.** Today there are only pure-function unit tests.
- **Seasons**, so hours mean "this season's hours."
- **A place to see what went wrong**: rejected events, quiet terminals, events from the wrong resort.

Nothing in this plan changes how a patroller clocks in or out.

## Decisions

| # | Decision |
|---|---|
| D1 | **A shift knows the event that closed it.** The fold records `closeEventId` on each shift, and a correction edits that event. Today the correction searches by time, and on an open shift it matches the patroller's newest clock-out anywhere. |
| D2 | **Events are never deleted.** Reopening a shift marks its closing event `voided`: kept, and left out of the fold like `rejected`. A retry, or a late auto clock-out from another iPad, arrives with an id the server already holds, so it can't close the shift again. |
| D3 | **A device speaks only for itself.** On events from a device, `deviceId` always comes from its token, and the body's value is ignored. `source` may be `device` or `device_auto`. An `admin` event from a device is rejected with `source_not_allowed`. Only the server's own correction and close paths write `admin` events. |
| D4 | **Resort binding is recorded, not enforced.** Each event stores the resort its device was bound to on arrival (`deviceResortId`). A mismatch shows on Health (D13) and is never refused, because events queued before a terminal moved are legitimate (commit `e14c253`). |
| D5 | **The fold writes only what changed.** A shift is written only when one of its fields changed, and an event's status only when it changed. `updatedAt` then means something changed, so a delta carries only real changes. |
| D6 | **A shift the fold drops becomes a tombstone.** It gets `deletedAt` and is no longer deleted. A delta carries it so iPads drop their copy. A shift that comes back clears it. Screens and reports never see a tombstone. This is the rule items follow (Plan 15). |
| D7 | **Ski Swap's paged sync, opted into.** `walk=true` returns `{ shifts, syncedAt, nextAfter? }`, paged in `(updatedAt, id)` order 500 at a time. `syncedAt` is taken before the read, as `ItemService.list` does, and is the iPad's next cursor. Patrollers get the same shape. Without `walk` or `take`, the response stays the bare array, for iPad builds already in the field, until a later plan removes it. |
| D8 | **One recompute per patroller at a time.** The recompute locks the patroller's profile row (`SELECT … FOR UPDATE`) before reading the log, so two iPads syncing the same patroller take turns. An event id that loses an insert race is treated as already held (`isUniqueViolation`), with no server error. |
| D9 | **Queries are validated.** Shift list, hours report and Health take zod query DTOs, as `SellerExportFiltersDto` does. A bad date, status or duty type gets a 400 with a sentence. |
| D10 | **Devices get what they use.** A device's roster carries no email, phone or `contactVerified`. Shifts carry no `nspId` for anyone: the NSP ID is the clock-in verifier, and neither the web nor the iPad reads it from a shift. The hours report keeps it, because it's an admin export. |
| D11 | **Every correction is audited.** Shift corrections, reopenings, admin closes, roster create/edit/delete, and imports each write an `AuditLog` row with the before and after. A corrected shift shows "Edited" on Shifts, with its history one click away. |
| D12 | **Seasons split the year at a cutover date.** The org sets one month and day under Org Admin → General (default July 1). Each season runs from that day to the day before it in the following year, and is named by the two years it spans: with a July 1 cutover, "2026–2027" is July 1, 2026 to June 30, 2027. There's no list of seasons to manage, so every year has one, with no gaps and no overlaps. A shift is in the season containing its clock-in date in the resort's local time. That is worked out on read and never stored, so moving the cutover refiles nothing. Shifts and Hours open on the current season, and custom dates stay available. The iPad never sees seasons. |
| D13 | **A Health tab.** Time Tracking → Health (`time_tracking:manage`) shows:<br>• events the fold didn't apply in the last 30 days (rejected, orphan, anomalous, voided), with terminal, patroller and reason;<br>• every terminal with its resort, last seen and app version;<br>• events whose resort differs from their terminal's binding (D4);<br>• a count of shifts still open past the auto-close time, linking to Shifts. |

## Phases

The phases ship in order, and each one is deployable alone.

1. **The bugs, and a smoke test that would have caught them.** D1–D3, plus the pipeline smoke test.
2. **Sync.** D5–D10.
3. **History.** D11.
4. **Seasons.** D12.
5. **Health.** D4 and D13.
6. **The iPad.** A handoff once 2 is live, then iPad Plan 5's hardware matrix (TC-T20–T24).

## Server

### Schema (migration `…_time_clock_hardening`, additive)

- `TimeClockShift`:
  - `closeEventId String?` (D1);
  - `deletedAt DateTime?` (D6);
  - index `(orgId, updatedAt, id)` for the walk (D7).
- `TimeClockEvent`:
  - `deviceResortId String?` (D4);
  - `voided` joins the status values (D2), as a string, so no migration is needed for it.
- `Organization` (migration `…_season_cutover`, phase 4): `seasonCutover String @default("07-01") @db.VarChar(5)`, the month and day each season starts, as `MM-DD` (D12).

### Fold (`fold.service.ts`)

- `foldEvents`:
  - sets `closeEventId` on each closed shift;
  - leaves out `voided` events as it does `rejected` ones.
- `recomputeForPatroller`:
  - locks the profile row first (D8): `$queryRaw` `SELECT id FROM PatrollerProfile WHERE id = ? FOR UPDATE`, inside the caller's transaction;
  - reads the current shifts in full and diffs them against the fold with a pure `shiftChanges(existing, folded)`. It writes only new and changed shifts, tombstones the dropped ones and clears `deletedAt` on returning ones (D5, D6);
  - updates event statuses only where they changed, grouped into one `updateMany` per status.

### Events (`event.service.ts`)

- Rules:
  - `deviceId` always comes from the token (D3);
  - `source: 'admin'` from a device is rejected with `source_not_allowed`;
  - each event stores `deviceResortId` from the device's current binding (D4).
- The existing-id check becomes one `findMany` over the batch, replacing a `findUnique` per event.
- An insert that loses a race reads the row back and reports its status (D8).
- `EVENT_STATUSES` gains `voided`. The iPad treats any status other than `rejected` as accepted (`TimeClockSyncEngine.swift:270`), so it needs no change for this.

### Shifts (`shift.service.ts`, `shift.controller.ts`)

- **Correction (D1, D2, D11):**
  - uses `closeEventId`, never a search by time;
  - setting a clock-out on a shift with none writes `admin-close:<shiftId>`, or revives it if it was voided;
  - reopening voids the closing event, with its id and the user in `statusNote`;
  - writes an audit row (`time_clock.shift.corrected` or `time_clock.shift.reopened`) with the before and after times, duty type and note.
- **List:**
  - a `ShiftListQuery` zod DTO (D9) covering `resortId`, `status`, `dutyType`, `from`, `to`, `season`, `pastSweep`, `updatedSince`, `walk`, `after`, `skip` and `take`;
  - with `walk`: `{ shifts, total, syncedAt, nextAfter? }`, a keyset walk using the cursor helpers moved out of `item.service.ts` into `common/util/cursor.ts`, with tombstones included only alongside `updatedSince` (D6, D7);
  - with `take`: the same shape, offset-paged for Shifts;
  - with neither: today's bare array, minus tombstones and `nspId`.
- **`GET shifts/:shiftId/history`** (`time_tracking:report`): the shift's events (type, source, device, times, status) and its audit rows, oldest first.
- `ShiftResponse` loses `nspId` and gains `edited`, which is `editedByUserId != null` (D10, D11).

### Roster (`patroller.service.ts`, `patroller.controller.ts`)

- `walk=true` returns `{ patrollers, syncedAt, nextAfter? }`, keyset by `(membership.updatedAt, id)` (D7).
- A device's read uses `DevicePatrollerResponseSchema`, which is `PatrollerResponseSchema` without `email`, `phone` and `contactVerified` (D10). The iPad doesn't decode them (`TimeClockAPIClient.swift:11`).
- Create, edit, delete and import write audit rows. An import writes one row with its counts, not one per patroller (D11). A deactivation that closes a shift says so in its row.

### Reports (`report.service.ts`)

- An `HoursReportQuery` DTO (D9), adding `season`.
- Tombstones are excluded.

### Seasons (`common/util/season.ts`, phase 4)

- **The setting:**
  - `PatchOrgSchema` gains `seasonCutover`, an `MM-DD` that must be a real date. February 29 is refused, because a season has to start every year;
  - `OrgResponse` carries it;
  - it is written by whoever can already edit the org's General settings (`org:manage`) and audited as `org.season_cutover.changed`, with before and after.
- **Pure helpers:**
  - `seasonOf(date, cutover)` gives a local calendar date's season, named by its start year;
  - `seasonLabel(startYear, cutover)` gives "2026–2027", or just "2026" when the cutover is January 1 and the season is a calendar year;
  - `seasonRange(startYear, cutover, timeZone)` gives the season's first and last instants in one resort's zone, from the cutover's local midnight to the next year's.
- **Queries:**
  - shifts and the hours report take `season=<startYear>`, which D9 validates as a year;
  - they filter by resort: an `OR` over the org's resorts, each with its own range.
- **`GET orgs/:orgId/time-clock/seasons`** (`time_tracking:report`) returns:
  - the cutover;
  - the current season, today's in the org's first resort's zone;
  - every season from the earliest shift's to the current one, newest first, each as `{ startYear, label, startsOn, endsOn }`, for the pickers.

### Health (`health.service.ts`, phase 5)

- `GET orgs/:orgId/time-clock/health` (`time_tracking:manage`) returns everything D13 lists.
- Terminals come from `Device` (role `time_clock.terminal`, `lastSeenAt`, the latest `appVersion`), not from events, so a terminal that has gone quiet still shows.

## Web

- **Shifts:**
  - a season picker, defaulting to the current season, then custom dates;
  - paged with `take` and `skip`, replacing the silent cap of 2,000;
  - an "Edited" mark that opens the shift's history;
  - "Reopen" says what happens: "The clock-out is set aside, not deleted."
- **Hours Report:** the same season picker. The CSV names the season or the dates.
- **Org Admin → General:** a "Season starts" setting, as a month and a day, with a line under it naming the current season and its dates: "2026–2027: July 1, 2026 to June 30, 2027." Changing it says what it does: "Shifts and hours are grouped by the new dates at once. Nothing is moved."
- **Health:** a new tab, after Devices, with D13's four sections.
- The query keys for patrollers and shifts follow the new shapes in `api.ts`.

## The iPad (sibling repo; handoff after phase 2)

- Walk shifts and patrollers with `walk=true`, page through `nextAfter`, and store `syncedAt` as the cursor once the last page lands. This replaces the newest `updatedAt` received.
- Delete the local shift when `deletedAt` is set.
- Stop sending `deviceId` in events; the server ignores it now anyway.
- `source_not_allowed` is a rejection like any other. `voided` needs nothing (see Events).
- Then iPad Plan 5 Phase 5 on hardware:
  - **TC-T20:** the offline matrix;
  - **TC-T21:** two-iPad convergence, including across two resorts;
  - **TC-T22:** auto clock-out convergence;
  - **TC-T23:** pruning and the 5,000-event pass;
  - **TC-T24:** a wrong device clock.

## Tests

- **Pure:**
  - `foldEvents` sets `closeEventId` and leaves out voided events;
  - `shiftChanges`: no writes when nothing changed, a tombstone for a dropped shift, a revival for one that returns;
  - `seasonOf` on the day before the cutover, on the cutover, and with a January 1 cutover, whose seasons are calendar years named "2026";
  - `seasonRange` across a DST change;
  - the query schemas refuse bad dates and statuses.
- **Service:**
  - a device's `source: 'admin'` is rejected, and its body `deviceId` is ignored;
  - a correction and a reopen each write an audit row with before and after;
  - a cutover of February 29, or of a day that doesn't exist, is refused, and a change is audited;
  - a device's roster has no contacts.
- **Smoke `smoke-time-clock.mjs`** (new; the pipeline end to end, as a terminal and as staff):
  - clock in and out, then retry the batch: the same results and the same shifts;
  - deliver a morning clock-in after the afternoon's events: the shifts converge;
  - **the D1 regression**: a patroller with a closed shift and an open one; set a clock-out on the open one; the closed one is unchanged;
  - reopen a shift, then send its `auto:` clock-out from a second terminal: it stays open;
  - a walk after one clock-in returns that shift only; one that crosses a page boundary returns every row exactly once; a superseded shift arrives as a tombstone;
  - the history lists the edit;
  - Health lists a rejected event and a resort mismatch.
- **Smoke `smoke-time-clock-concurrency.mjs`:**
  - two terminals send events for one patroller at once, 20 times: the shifts always match a single replay;
  - the same event id from two terminals at once: one is applied, the other reads it back, with no server error.
- **Load `load-time-clock.mjs`:** 500 patrollers and 5,000 events over a simulated season. One batch has to recompute in under a second for a patroller with a season's history. If it doesn't, a fold limited to recent events goes into a plan of its own.

## Rollout

- **Before phase 1,** look at production read-only: which orgs have `time_tracking` on, and how many resorts, patrollers, events, shifts and time-clock terminals exist. If real shifts exist, tell the user before deploying, since the D2 and D5 changes touch the shifts table.
- Additive migrations only. Deploy each phase as usual.
- **Backfill `closeEventId`** by recomputing every patroller once, with a script (`scripts/recompute-time-clock.mjs`) that prints what it would change unless given `--apply`. It touches each changed shift's `updatedAt` once, so iPads re-download those shifts once. **Run on production only with the user's go-ahead.**
- The bare-array responses stay until every time-clock terminal reports an app version that walks. Health's terminal list shows when that happens.

## Not in this plan

- Enforcing resort binding (D4 records it; refusing is a decision for after a season of data).
- A fold limited to recent events, unless the load test says it's needed.
- Pruning events on the server.
- Seasons for Ski Swap. The cutover is an org setting, so Ski Swap can use it later, but nothing there reads it yet.
- Scheduling, payroll, approvals, breaks, and patrollers seeing their own hours (still out of scope, iPad Plan 5 §1).

## Where the build drifted

- **One migration, not two.** `20261030120000_time_clock_hardening` carries the season cutover too, so there is one schema change to approve.
- **A third device gap, found on the way.** `@RequireDeviceRole` sat on the whole shifts, roster and reports controllers, and `PermissionsGuard` passes a device on its role alone. So a time-clock terminal could correct shifts, edit, delete and import the roster, and read reports. The role now sits only on the two reads the iPad makes (shift list, roster list). Reports, seasons and Health take a signed-in person only (`JwtAuthGuard`), and `device-role-coverage.spec.ts` holds that line. The smoke test checks every refusal.
- **Corrections that would break the fold are refused.** A correction may not run into the patroller's next shift or back into the previous one, and a shift with a later shift after it can't be reopened. Either would make the fold close the wrong shift.
- **A superseded shift saved unchanged writes no close.** Its "close" is the next shift's clock-in. Writing an admin clock-out at that instant would close the next shift instead.
- **The clock-in is re-labelled "by staff" only when its own time or duty changed**, so a corrected clock-out still shows the iPad recorded the start.
- **A deactivation's close goes through the same writer as a correction** (`writeAdminClose`), so reopening and closing a shift twice reuses its close rather than colliding with it.
- **Health lists terminals with their app version and build**, and `revoked` was dropped: a revoked device is deleted, so there's nothing to show.
- **`recompute-time-clock.mjs` uses the built fold** (`dist/`), so the backfill runs the server's own code. Build before running it.
- **Local preview:** `vite.config.ts` reads `API_PORT` for its proxy, and `.claude/launch.json` has `api-4001` and `web-4001`. The gitignored `apps/web/vite.config.js` is a stale build of the config, and Vite prefers it, so `web-4001` passes `--config vite.config.ts`.

