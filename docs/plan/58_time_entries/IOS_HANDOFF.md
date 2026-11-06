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

Found by a read of `patrolkit_ios` `develop` at `fddd2c5`:

- **`Services/TimeClockAPIClient.swift`:**
  - `listShiftsPage` calls `orgs/\(orgId)/time-clock/entries` instead of `…/shifts`.
  - `APIShiftPage` decodes `entries` instead of `shifts`, for example with a `CodingKeys` case `shifts = "entries"`. The `.list` fallback (bare array) is unchanged: `entries` answers it exactly as `shifts` did.
  - The row type, `APIShift`, doesn't change.
- **Copy**, to match the web:

  | File | Today | Becomes |
  |---|---|---|
  | `Features/TimeClock/Home/TimeClockHomeViewModel.swift:36` | "1 patroller on shift" / "N patrollers on shift" | "1 patroller clocked in" / "N patrollers clocked in" |
  | `Features/TimeClock/Home/TimeClockHomeView.swift:116` | "No one is on shift" | "No one is clocked in" |
  | `Features/TimeClock/NotReady/TimeClockNotReadyView.swift:94` | "…before anyone can clock in — a shift has to be filed somewhere." | "…before anyone can clock in: each clock-in is recorded at a resort." |

  The clock-in and clock-out screens already say "clocked in" and "in at …", and `OnShiftCard` shows no "shift" text.
- **Names in code** (`OnShiftCard`, `APIShift`, `ShiftProjection`, the store's shift tables, comments) can move to "time entry" at the app's own pace. Nothing on the server depends on them.

Once Time Tracking → Health shows every terminal on a build that reads `entries`, the server retires `shifts`.

## Where the iPad stands (2026-11-06)

Three server plans wait on the app. Suggested order:

1. **Plan 56 (Tablets):** done on branch `plan-56-tablets` (worktree `patrolkit_ios-tablets`, `d89cb82`), not yet merged into `develop`. It touches `TimeClockNotReadyView.swift`, so merge it before the copy change above.
2. **Plan 57 (PINs):** not started. See [57's handoff](../57_members_are_the_roster/IOS_HANDOFF.md). Until it ships, members with only a PIN can't clock in on the iPad.
3. **Plan 58 (this handoff):** small, and nothing breaks without it.
