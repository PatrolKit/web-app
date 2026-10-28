# iOS handoff: shifts are time entries (server Plan 58)

The server now calls a clock-in and its clock-out a **time entry**. "Shift" is kept for a later feature: a start and end time a scheduling admin assigns. Nothing the app does today breaks.

Server details: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## What changed on the server

| | Before | Now |
|---|---|---|
| `GET …/time-clock/shifts` (bare array, `walk=true` page as `{ shifts, … }`) | The only route | Unchanged, kept for builds in the field |
| `GET …/time-clock/entries` | — | The same rows. A walk's page is `{ entries, total?, syncedAt, nextAfter? }` |
| `GET …/time-clock/entries/:id/history`, `PATCH …/time-clock/entries/:id` | — | Staff only, as under `shifts` |
| Row fields | | Unchanged: `id`, `clockInAt`, `clockOutAt`, `dutyType`, `deletedAt` and the rest |

## What the app should change, when convenient

- **`Services/TimeClockAPIClient.swift`, `listShifts`:** call `time-clock/entries` and decode `entries` instead of `shifts`. The row type doesn't change.
- **Copy:** "On shift" becomes "Clocked in" (`Components/OnShiftCard.swift`, the home board, the clock-out screen).
- **Names in code** (`APIShift`, `ShiftProjection`, the store's shift tables) can move to "time entry" at the app's own pace. Nothing on the server depends on them.

Once Time Tracking → Health shows every terminal on a build that reads `entries`, the server retires `shifts`.
