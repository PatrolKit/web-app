# Plan 56: Tablets

## Goal

One set of iPads serves Ski Swap once a year and Time Tracking the rest of the year. Today each iPad is provisioned into one module for life: a `ski_swap.staff_check_in` iPad can never clock anyone in, and a `time_clock.terminal` can never check gear in. Each module provisions and manages its own iPads (Ski Swap → Check-in, Time Tracking → Devices).

After this plan:

- An iPad is the org's **tablet**, provisioned once.
- **Which module it runs is a setting on the iPad.**
- Everything about tablets lives on a new **Tablets** item in the main nav, for org administrators only:
  - adding one, and its pairing code;
  - status, mode and app version;
  - renaming, a new code, revoking;
  - the settings PIN.
- Ski Swap → Check-in gains a step: **choose the tablet that serves each staffed station**.

This partly reverses commit `b476150` ("each module owns its hardware, and Devices retires"). That commit was right for hardware one module uses. A tablet now belongs to both modules, so it belongs to neither. Print bridges, scanners and printers stay on Ski Swap → Hardware. Signage displays stay on Signage.

Production today: 12 staff check-in iPads across three orgs, 10 of them at live stations, and no time clock terminals.

## Decisions

| # | Decision |
|---|---|
| D1 | **One role for every iPad: `org.tablet`.** A tablet's token is accepted on every route that accepts `ski_swap.staff_check_in` or `time_clock.terminal`. Module checks still apply, so a tablet can't use Time Tracking in an org that hasn't enabled it. The two old roles stay accepted until D11 converts the iPads, then provisioning stops offering them. |
| D2 | **Tablets belong to the org.** `ROLE_OWNER` gains `org → org:manage`, with no module gate. Only org administrators provision, rename, re-code or revoke a tablet, and only they see the credential list. |
| D3 | **The mode is the iPad's.** It's chosen on the iPad, behind the settings PIN, and stored there. The server never sets or enforces it. The iPad offers only modules the org has enabled; `/devices/me` gains `modules: string[]`. |
| D4 | **The iPad reports its mode, and the web shows it.** `/devices/me` reads an `X-App-Mode` header, the way it reads `X-App-Version`, e.g. `ski_swap/check_in`, `ski_swap/end_of_swap_pickup` or `time_clock`. It's stored as `Device.appMode`. Like the version, a request without the header leaves the last report standing. |
| D5 | **One settings PIN per org.** It's set on the Tablets tab and stored as `Organization.tabletPin` (four digits, `DevicePinSchema`), and the iPad reads it from `/devices/me`. It's seeded from the Ski Swap PIN, else the Time Tracking one. The two module PIN cards are removed. Their endpoints and the iPad-facing settings fields return the org PIN until older iPad builds are gone. |
| D6 | **A station's kind is stored.** `CheckinStation.staffed` replaces deriving the kind from `attendantDeviceId`, backfilled from it. Now that tablets are provisioned apart from stations, a staffed station can exist without its tablet: it shows "Needs a tablet", not quietly turning into a self-service station. The bridge-sharing rules (Plan 27) read `staffed`. |
| D7 | **Ski Swap admins pick a station's tablet.** On Check-in, a staffed station's Tablet cell is a picker of the org's tablets. A new `GET ski-swap/stations/tablet-options` (`ski_swap:admin`) returns each tablet's id, name, mode, last seen and the station it serves; it carries no credentials. Choosing a tablet that serves another station moves it, after a confirmation naming that station. A tablet serves one station (`attendantDeviceId` stays `@unique`). Adding a staffed station no longer creates an iPad. |
| D8 | **A time clock tablet's resort is set on the iPad only.** `PATCH /devices/me/resort` accepts `org.tablet`. Time Tracking → Devices is removed. The Tablets tab shows the resort but can't change it. Provisioning no longer takes a resort. |
| D9 | **The Tablets tab** (`/tablets`, `org:manage`) shows one row per tablet: <br>• name; <br>• mode (D4); <br>• where it serves (the station, the resort, both, or nothing); <br>• status and last seen, judged as staff tablets are today (`OFFLINE_AFTER_TABLET_MS`); <br>• app version and build; <br>• whether its code was used (`lastTokenAt`). <br>Actions: rename, new code, revoke. **Add tablet** asks only for a name and opens the existing pairing popover. The PIN card sits above the list. |
| D10 | **Switching mode waits for the queue.** On the iPad, a switch is refused while the current mode has unsent work (queued items, receipts, clock events), and says how many are left. That data is never at risk of being stranded in a mode nobody opens again. |
| D11 | **Existing iPads convert in place, after they update.** A data migration sets `role = 'org.tablet'` on every `ski_swap.staff_check_in` and `time_clock.terminal` device. It keeps their credentials, names and station bindings, so nobody re-pairs. It runs only once the Tablets tab shows every iPad on a build that understands `org.tablet`: an older build routes on the role's prefix and would show its fallback screen. |
| D12 | **Station status still shows on Check-in.** The station's Status cell keeps reporting its tablet's health, because that's where a swap is run from. For org admins it links to the tablet's row on Tablets. |

## Phases

Each phase ships alone and leaves production working.

### Phase 1: Server accepts tablets (additive)

- **The role** (D1, D2):
  - `org.tablet` is added to `DeviceRoleSchema`, `ROLE_OWNER` and `moduleOfRole`.
  - Every `@RequireDeviceRole('ski_swap.staff_check_in')` and `@RequireDeviceRole('time_clock.terminal')` accepts it. Shared constants (`SKI_SWAP_TABLET_ROLES`, `TIME_CLOCK_TABLET_ROLES`) replace the literals.
    - On the Ski Swap side these are the whole item, seller, swap, station-print and indemnification controllers, plus individual routes in settings, printer, receipt, scanner and taxonomy.
    - On the Time Clock side, since Plan 55 narrowed them, only five routes name the role: the shift list, the roster list, the two settings reads, and the resort list.
  - Role checks written in code accept it too: `station.service` `assertAttendantFree`, `devices-me.controller` rebind, and `RESORT_BOUND`.
  - **Clock events get a role check.** `time-clock/event.controller.ts` checks only that the caller is *a* device, so a print bridge's or a display's token is accepted as well. It now refuses anything outside `TIME_CLOCK_TABLET_ROLES`.
  - **Health finds tablets** (`time-clock/health.service.ts`). Its terminal list reads `role: 'time_clock.terminal'`. It now also lists tablets whose `appMode` is `time_clock` or that have a resort.
- **What `/devices/me` adds:** `modules` and `tabletPin` in the response, and the `X-App-Mode` header (D3–D5).
- **One migration, for the user's OK first:**
  - `Device.appMode VARCHAR(64) NULL`;
  - `Organization.tabletPin VARCHAR(4) NULL`, seeded per D5;
  - `CheckinStation.staffed BOOLEAN NOT NULL DEFAULT false`, backfilled from `attendantDeviceId`.
- **Station service** reads `staffed` (D6), and `tablet-options` is added (D7).
- **Tests:**
  - a tablet token passes both modules' guards and fails a disabled module's;
  - an org admin who doesn't hold `ski_swap:admin` can provision a tablet, and a Ski Swap admin can't;
  - a staffed station without a tablet stays staffed;
  - `X-App-Mode` is stored, and its absence leaves the last report alone;
  - clock events from a print bridge are refused;
  - `device-role-coverage.spec.ts` gains a check: no route names a legacy iPad role without its tablet constant.

### Phase 2: Web

- **Nav:**
  - **Tablets** in `AppShell`, under Org Admin, gated on `org:manage`.
  - The route and `TabletsPage` (D9). It reuses `DeviceCredentialList`, `PairingCodePopover` and `DevicePinCard` from `pages/devices/`.
- **Check-in** (`StationsTab`, `AddStationForm`):
  - Adding a staffed station asks for its name and letter, and optionally a tablet (D7).
  - Its Tablet cell is the picker, and "Needs a tablet" is its status when empty.
  - The pairing popover and every "new iPad" path leave this page.
- **Removed:**
  - Time Tracking → Devices and its route (D8). Health stays, and its terminal rows link to the tablet on Tablets for org admins;
  - the PIN card in Ski Swap → Config and in Time Tracking → Settings (D5).
- **Smoke** (in the browser):
  - an org admin adds a tablet and sees its code;
  - a Ski Swap admin who isn't an org admin doesn't see Tablets, and can assign that tablet to a station;
  - a staff member sees neither.

### Phase 3: iPad app (`patrolkit_ios`, its own plan)

- **Choosing a mode:**
  - `DeviceModule` comes from the stored mode when the role is `org.tablet`. Legacy roles route as they do today.
  - First launch after pairing asks for the mode.
  - Admin Settings gains **Mode** (Ski Swap / Time Clock, enabled modules only, D3). Ski Swap's existing sub-modes stay under it.
- **Switching** stops one sync engine and starts the other, refused while the current queue has unsent work (D10).
- **Sends and reads:** sends `X-App-Mode` on `/devices/me` (D4), and reads the settings PIN from `tabletPin` (D5).
- **Time Clock mode** with no resort opens on the existing not-ready screen, where the resort is chosen (D8).

### Phase 4: Convert the fleet

- **Install** the Phase 3 build on every iPad. The Tablets tab's build column confirms it.
- **Run the D11 data migration** (for the user's OK first). Spot-check that a converted iPad still syncs its station and can switch to Time Clock.
- **Then:** provisioning stops offering the legacy roles. They stay accepted by the guards, so a forgotten iPad still works; a later plan removes them once none are left.

## Interplay

- **Plan 55** (built 2026-10-23):
  - **Health:** Time Tracking → Health lists terminals with their resort, last seen and app version. Phase 1 widens its query to tablets. Phase 2 links each row to Tablets for org admins rather than repeating the status logic.
  - **The iPad build:** the Phase 3 build must include Plan 55's iOS handoff (`docs/plan/55_time_tracking_hardening/IOS_HANDOFF.md`): paged `walk=true` sync, `syncedAt` cursors, and dropping shifts sent with `deletedAt`. The converted iPads have only ever run Ski Swap, so their first time-clock sync will be on that build, and no tablet will ever read the bare-array responses.
  - **Retiring the bare arrays:** Plan 55 waits until every terminal reports a build that walks. After Phase 4, the Tablets tab's build column answers that for the whole fleet.
- **Token reach:** a tablet's token reaches both modules' device routes, the union of what the two kinds of iPad reach today. Review device-token scope before Phase 4.

## Out of scope

- Setting an iPad's mode or resort from the web (D3, D8).
- Moving print bridges, scanners or signage displays to Tablets.
- Battery, storage or MDM-style reporting from the iPad.
