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

Found by a read of `patrolkit_ios` at `7e45d7b` (the server repo can't see later work):

- **`Services/TimeClockAPIClient.swift`:** `APIPatroller` gains `clockPin: String?`.
- **`Services/PatrolKitStore+TimeClock.swift`:**
  - `PatrollerRecord` and the `tc_patrollers` table gain `clockPin`;
  - `patroller(orgId:nspId:)` (around line 235) also matches `clockPin` when the typed code isn't anyone's NSP ID, so clock-out finds a PIN holder.
- **`Features/TimeClock/ClockIn/ClockInIdViewModel.swift`:** verify the typed code against the chosen person's NSP ID, or their PIN when they have no NSP ID.
- **Copy:** "NSP ID" becomes "NSP ID or PIN" on the clock-in and clock-out keypads.
- **A member with neither** (`nspId` empty, `clockPin` null) still appears in name search, as "Can't clock in yet: ask a patrol leader", rather than vanishing.

## Compatibility

Builds in the field keep working for everyone with an NSP ID. A member who only has a PIN can't clock in on them, and the empty `nspId` must not match an empty keypad entry: check that a blank code is refused before matching. No iPad runs the time clock in production yet.
