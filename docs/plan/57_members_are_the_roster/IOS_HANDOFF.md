# iOS handoff: the roster is the members, and PINs (server Plan 57)

The time clock's roster is now the org's members. Nothing about how the iPad reads it changes: `GET …/time-clock/patrollers` (with or without `walk=true`, Plan 55) returns the same rows. Two things are new.

Server details: [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## A member with no NSP ID clocks in with a PIN

Every member can clock in. One with an NSP ID uses it. One without chooses a 6-digit PIN on the web (My account), and the terminal's roster row carries it:

| Field | Before | Now |
|---|---|---|
| `nspId` | Always set | `""` for a member with no NSP ID |
| `clockPin` | — | The member's PIN, 6 digits; `null` for anyone with an NSP ID and for anyone who hasn't chosen one |

A PIN is unique in the org, and never equal to any member's NSP ID there, so a code typed at clock-out still finds exactly one person.

## What the app should change

Found by a read of `patrolkit_ios` at `7e45d7b`, rechecked at `fddd2c5` (2026-11-06):

- **`Services/TimeClockAPIClient.swift`:** `APIPatroller` gains `clockPin: String?`.
- **`Services/PatrolKitStore.swift`, a new migration (after `v34-item-comps`):**
  - `tc_patrollers` gains `clockPin`.
  - The unique index `tc_patrollers_nsp` on `(orgId, nspId)` must stop covering empty NSP IDs: drop it and recreate it as a partial index (`WHERE nspId != ''`). Today, two members with `nspId: ""` collide on it. `upsertPatrollers` inserts with `onConflict: .replace`, so each one silently deletes the last, and only one member without an NSP ID survives on the iPad.
- **`Services/PatrolKitStore+TimeClock.swift`:**
  - `PatrollerRecord` gains `clockPin`;
  - `patroller(orgId:nspId:)` (around line 235) also matches `clockPin` when the typed code isn't anyone's NSP ID, so clock-out finds a PIN holder.
- **`Features/TimeClock/ClockIn/ClockInIdViewModel.swift`:** verify the typed code against the chosen person's NSP ID, or their PIN when they have no NSP ID.
- **Copy:** "NSP ID" becomes "NSP ID or PIN" on the clock-in and clock-out keypads.
- **A member with neither** (`nspId` empty, `clockPin` null) still appears in name search, as "Can't clock in yet: ask a patrol leader", rather than vanishing.

## Compatibility

Builds in the field keep working for everyone with an NSP ID. On them, members without an NSP ID overwrite one another in the local roster (the index above), which costs nothing there because they can't clock in anyway. A member who only has a PIN can't clock in on them, and the empty `nspId` must not match an empty keypad entry: check that a blank code is refused before matching. No iPad runs the time clock in production yet.
