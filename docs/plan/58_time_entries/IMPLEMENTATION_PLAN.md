# Plan 58: Time entries, so "shift" is free for scheduling

## Goal

Time Tracking records when each patroller clocks in and out, and adds that time up across the season. Today the clock-in and clock-out pair is called a "shift" everywhere: the table, the API, the web pages and the iPad.

A shift will mean something else later: a start and end time a scheduling admin assigns. This plan renames the pair to a **time entry** now, before scheduling arrives, so the two never share a name. Behavior doesn't change.

## Now and later

| | Now (this plan) | Later (scheduling, not planned yet) |
|---|---|---|
| **Time entry** | One clock-in and its clock-out, at a resort, with a duty type. Folded from the iPad's clock events, as today. | Unchanged. |
| **Shift** | Not a thing. | An assigned start and end, set by a scheduling admin, for a patroller at a resort. |
| **Time on patrol** | A patroller's closed time entries, added up per season, split by duty type (the Hours report, as today). | Also compared with their shifts: covered, late, early, missed. That comparison is worked out from both, not stored on the time entry. |

## Decisions

| # | Decision |
|---|---|
| D1 | **A clock-in/clock-out pair is a time entry.** Every word a person reads says so: "Time entries" for the Shifts tab, "Clocked in" for On Shift, "Edit time entry", "Entries" in the report. |
| D2 | **The code says it too.** The Prisma model, services, contracts and web types are renamed. The table stays `TimeClockShift` through `@@map`, so there's no migration. |
| D3 | **The API adds `time-clock/entries` and keeps `time-clock/shifts`.** iPads in the field read `shifts`, so it stays, answering in its current shape, until Health shows every terminal on a build that reads `entries`. Then it's retired, as Plan 55 retires bare arrays. |
| D4 | **Duty type stays on the time entry.** The patroller picks it at clock-in, and the report splits hours by it. |
| D5 | **Nothing else changes.** Auto clock-out, "Still open", needs review, corrections, history, seasons and Health behave exactly as they do today. |
| D6 | **"Shift" is reserved.** No new code uses the word for a time entry. When scheduling comes, it gets its own model and routes (for example `orgs/:orgId/scheduling/shifts`), so it never clashes with the old route while that route lives. |

## Server

### Schema (no migration)

- `model TimeClockShift` becomes `model TimeEntry { … @@map("TimeClockShift") }`. Columns keep their names: `clockInAt`, `clockOutAt`, `dutyType` and the rest already describe a time entry.
- Relation fields: `PatrollerProfile.shifts`, `Organization` and `Resort` become `timeEntries`.
- **Check:** `prisma migrate diff` against production's schema shows no SQL. Index names are derived from the mapped table, so they don't move either.

### Code

| Today | After |
|---|---|
| `shift.service.ts`, `ShiftService` | `time-entry.service.ts`, `TimeEntryService` |
| `shift.controller.ts` | `time-entry.controller.ts` (`entries`), plus `legacy-shift.controller.ts` (`shifts`, D3) over the same service |
| `shift-closer.service.ts`, `ShiftCloserService` (`openShiftOf`, `closeFor`) | `clock-out.service.ts`, `ClockOutService` (`openEntryOf`, `closeFor`) |
| `fold.service.ts`: `foldEvents` returns shifts, `shiftChanges` | Returns time entries, `entryChanges` |
| `ShiftResponseSchema`, `ShiftListQuerySchema`, `ShiftPageResponseSchema`, `ShiftHistoryResponseSchema`, `PatchShiftSchema` | `TimeEntry…` versions. The legacy controller maps the page to `{ shifts, … }`. |
| `HoursReportRow.shiftCount` | `entryCount` (web only, so renamed outright) |
| `MemberResponse.onShift` | `clockedIn` (web only) |
| Audit actions `time_clock.shift.corrected`, `.reopened`, `.closed_by_roster` | `time_clock.entry.…` for new rows. History reads both, so older rows still show. |
| Health: "shifts no device closed" | "time entries no device closed" |

Comments and error messages follow, for example `entry_not_found` and "This time entry overlaps another".

### Routes

| Route | Who | Answer |
|---|---|---|
| `GET time-clock/entries` | staff, terminals | `{ entries, total, syncedAt, nextAfter? }` with `walk=true`; `{ entries, total }` with `take` |
| `GET time-clock/entries/:entryId/history` | staff | as today's shift history |
| `PATCH time-clock/entries/:entryId` | `time_tracking:manage` | the corrected entry |
| `GET/PATCH time-clock/shifts…` | unchanged | unchanged, including the bare array (D3) |

The device-role coverage test lists the new controller.

## Web

- **Tabs:** "On Shift" becomes "Clocked in", and "Shifts" becomes "Time entries". Routes move to `/time-tracking/clocked-in` and `/time-tracking/entries`, and the old paths redirect.
- **Pages:** `OnShiftPage` becomes `ClockedInPage`, `ShiftsPage` becomes `TimeEntriesPage`, and `ShiftHistoryDialog` becomes `TimeEntryHistoryDialog`. `api.timeClock` gets `listEntries`, `patchEntry` and `entryHistory`.
- **Copy:**
  - "Patroller" column stays.
  - "on shift" in a row becomes "clocked in".
  - The reopen dialog says "Reopen this time entry?".
  - Members' warning: "Jane Doe is clocked in at North Lodge. Saving clocks them out."
  - Hours report: the "Shifts" column becomes "Entries", in the CSV too.
- `grep -i shift` over `apps/web/src/pages/time-tracking`, members and account turns up nothing afterwards.

## The iPad (handoff)

None of this is urgent for the app: `shifts` keeps answering as it does.

- **When convenient:** read `time-clock/entries` and decode `entries` instead of `shifts`. The rows are the same.
- **Copy:** "On shift" becomes "Clocked in" (`OnShiftCard`, the home board).
- **Code names** (`APIShift`, `ShiftProjection`, the local store) can move to "time entry" at the app's pace.
- Once Health shows every terminal on such a build, the server retires `shifts`.

## Tests

- **Unit:** the fold's spec and the existing specs, renamed. The device-role coverage test includes the new controller.
- **Smoke:** `smoke-time-clock.mjs` and `smoke-time-clock-concurrency.mjs` move to `/entries`. One added check: `/shifts` still answers in its old shapes (bare array, walk page with `shifts`, PATCH).
- **Schema:** `prisma migrate diff` is empty.

## Rollout

No migration and no data change, so this falls under deploying without asking: release, run the smokes on the server, then push.

## Not in this plan

- Scheduling: shifts, assignments and comparing them with time entries.
- Days on patrol, or hours by resort, in the report.
- Renaming the table.

## Where the build drifted

- **Clocked in stays the tab's index route** (`/time-tracking`), rather than moving to `/time-tracking/clocked-in`. Only `shifts` moved, to `entries`, and the old path redirects.
- **`time-clock/entries` answers exactly as `shifts` does,** including the bare array when a request names neither `walk` nor `take`. Only the page's key differs. One service serves both, so the two can't drift apart.
- **Older audit rows** (`time_clock.shift.…`, target `time_clock_shift`) are read alongside the new ones, and a history names them by their new action.
- **The scripted rename touched prose too.** Comments now say "entry" where they said "shift". The auto clock-out setting reads "Clocked-in time recorded".
