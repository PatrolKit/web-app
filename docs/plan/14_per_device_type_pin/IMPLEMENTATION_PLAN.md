# Plan 14 — The device PIN moves to the web

> **Status:** Implemented.
> **Touches:** `server` (api + web), `patrolkit_ios`.
>
> Built as written, with three departures worth recording:
>
> - **The PIN contracts live in `devices.contracts.ts`**, not duplicated into
>   each module's file. Both modules' PINs are the same thing — a gate on a
>   screen, on a piece of hardware — and only the answer differs.
> - **`UpdateSkiSwapSettingsSchema` keeps its single required field.** §4.1
>   proposed making it partial with a `refine`, which with one field is an
>   elaborate way of writing "required" and leaves the service holding a
>   `number | undefined` it has to assert away. The route still became a
>   `PATCH` (D9); it is the method that was the lie, not the field.
> - **The `waiting` state's Retry button now calls `refresh()`**, the same one
>   the unbound state uses. It used to call `reload()`, which existed only to
>   raise the PIN stage; with that gone it would have synced without rebuilding
>   the context, leaving the screen up after the server had answered.

## 1. The gap

Two iOS device types gate their settings screen behind a PIN, and neither PIN is
something an administrator can see or change.

| Device | Role | Today |
|---|---|---|
| Ski Swap staff iPad | `ski_swap.staff_check_in` | `private let pinCode = "1938"`, compiled into `AdminSettingsView`. Changing it is a release. |
| Time Clock terminal | `time_clock.terminal` | Set on the iPad at first run, stored in the keychain under `timeClockPin`. Different on every iPad, known only to whoever typed it, unrecoverable. |

Both are the same gate — keep a bystander out of the screen with "delete all
local data" and "change which resort this is" on it — and neither is answerable
from a computer. A hardcoded PIN is the same PIN at every org in the fleet. A
keychain PIN means "what's the PIN on the iPad in the lodge?" has no answer
short of walking there.

This plan makes the PIN one value per org per module, set on the web, cached on
the device, and checked offline.

Most of the plumbing exists. Both modules already have an org-scoped settings
row, an endpoint the device is already authorised to call, and a local table the
sync engine writes on every pass:

| Where | What |
|---|---|
| `SkiSwapSettings` / `TimeClockSettings` | One row per org. Already carries `labelsPerItem` / auto-close policy. |
| `GET …/ski-swap/settings`, `GET …/time-clock/settings` | Already reachable by both a user and the module's device role. |
| `ski_swap_settings` / `tc_settings` (GRDB) | Already cached on the iPad and read offline. |
| `SkiSwapSyncEngine` / `TimeClockSyncEngine` | Already fetch settings each pass and write them through. |
| Ski Swap → Administration, Time Tracking → Settings | Both pages exist and are already `:admin`-gated. |

Two nullable columns, one new sub-resource per module, one shared React card,
and a rewire on the iPad. No new page, no new table, no new device round trip
that isn't paid for by the pass already running.

---

## 2. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **One PIN per org per module**, on the existing settings row — not per device. | The PIN answers "may this person open settings", and that answer does not differ between two iPads at the same mountain. Per-device would reintroduce exactly the problem this plan removes: an answer that can only be found by walking to the hardware. |
| **D2** | **Exactly four digits.** | Both keypads are already numeric, and the Ski Swap pad auto-submits at four. A variable length costs a submit button on a pad that does not have one and a variable-width dot display, to buy strength that four extra digits do not meaningfully add to a gate anyone can stand in front of. |
| **D3** | **Null means no gate: settings open straight through.** | Matches what Time Clock does today when no PIN was ever set. It also gives the device a safe answer for the case it cannot distinguish anyway — a fresh iPad that has never synced has no cached PIN, and locking it out would brick the one screen that can diagnose a broken sync. Consequence in §7: on the day this ships, the Ski Swap settings sheet is open on every org until an admin sets a PIN. |
| **D4** | **Stored and returned in plaintext, revealable in the web UI.** | An admin's first question is "what is the PIN", not "let me set a new one", and a four-digit hash is brute-forced in the time it takes to write the loop. This is a gate against a passer-by, not a credential; treating it as one would buy nothing and cost the lookup that is the point of the feature. |
| **D5** | **The PIN gets its own sub-resource** — `…/ski-swap/settings/device-pin`, `…/time-clock/settings/device-pin` — rather than a field on the settings response. | The settings `GET` is read at `:report` level (`SkiSwapLayout` fetches it for `labelsPerItem` on every ski-swap page), and the PIN should not ride along to every reader. The alternative — one response whose shape depends on the caller's permissions — makes `devicePin` absent, null, and set into three states for two facts, in a type every client shares. A separate route puts the rule in a decorator instead: `:admin` for people, the module's device role for the `GET`. |
| **D6** | **The device reads it as a second call in the sync pass it already runs.** | The cost of D5. A pass already makes several requests; one more is not the thing that makes a sync expensive. |
| **D7** | **A failed PIN fetch leaves the cached PIN alone.** Only a successful response writes. | The failure mode that matters: a request that times out must not be read as "the PIN was cleared", which would silently open the gate on every iPad the moment the network wobbles. |
| **D8** | **The on-device PIN setup and "Change PIN" are removed from Time Clock entirely**, along with the keychain entry behind them. | The web is the source of truth or it is not. Keeping a local override would mean an admin still cannot answer what the PIN on that iPad is, which is the whole complaint. |
| **D9** | **The Ski Swap settings endpoint becomes `PATCH`**, both fields optional, matching Time Clock's. | Not strictly required by this work, but the two settings endpoints sit side by side and disagree on method for no reason, and `PUT` with a partial body is a lie the moment the resource has two fields. One line in the web client, one decorator on the controller. |
| **D10** | **`AdminSettingsView` reads the PIN from the store, not from `SkiSwapContext`.** | `SkiSwapContext` is only built when an active swap exists and is reconstructed by hand in three places; threading a field through it to reach a view that already holds `appState` adds three edit sites and a nil case the store read does not have. |
| **D11** | **Clearing the PIN is an explicit action**, `devicePin: null`, distinct from omitting the field. | `undefined` leaves it alone, `null` removes the gate. A PATCH that could not express "remove" would leave a PIN unremovable once set. |

---

## 3. The model

Two columns, both nullable, both four characters:

```prisma
model SkiSwapSettings {
  // …
  /// The PIN that unlocks the admin sheet on a `ski_swap.staff_check_in` iPad.
  /// Four digits, plaintext: this gates a settings screen against someone
  /// standing at the table, and an admin's first question about it is what it
  /// is (D4). Null means no gate — the sheet opens straight through (D3).
  devicePin String? @db.VarChar(4)
}

model TimeClockSettings {
  // …
  /// The PIN that unlocks the settings sheet on a `time_clock.terminal`. Same
  /// shape and same rules as the ski-swap one; separate because they are
  /// separate answers — the swap tables and the patrol room are different
  /// rooms with different people in them.
  devicePin String? @db.VarChar(4)
}
```

Migration: `prisma migrate dev --name device_pin`. Two `ALTER TABLE`s, both
adding a nullable column; nothing backfills.

---

## 4. API

### 4.1 Contracts

`apps/api/src/contracts/ski-swap.contracts.ts`:

```ts
/** Four digits. See Plan 14 D2. */
export const DevicePinSchema = z.string().regex(/^\d{4}$/, 'Must be exactly 4 digits');

export const DevicePinResponseSchema = z.object({
  /// Null when no PIN is set, which means the gate is open (D3).
  devicePin: z.string().nullable(),
});

/// `null` clears the PIN; omitting the field is not a way to say that (D11).
export const UpdateDevicePinSchema = z
  .object({ devicePin: DevicePinSchema.nullable() })
  .strict();
```

`DevicePinSchema` / `DevicePinResponseSchema` / `UpdateDevicePinSchema` are
defined once and imported by `time-clock.contracts.ts` — the two modules'
answers differ, the shape does not.

Also per D9, in `ski-swap.contracts.ts`:

```ts
export const UpdateSkiSwapSettingsSchema = z
  .object({ labelsPerItem: z.number().int().min(1).max(3).optional() })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });
```

### 4.2 Routes

Four routes, two per module, all on the existing settings controllers:

| Method | Path | Users | Devices |
|---|---|---|---|
| `GET` | `/orgs/:orgId/ski-swap/settings/device-pin` | `ski_swap:admin` | `ski_swap.staff_check_in` |
| `PUT` | `/orgs/:orgId/ski-swap/settings/device-pin` | `ski_swap:admin` | refused |
| `GET` | `/orgs/:orgId/time-clock/settings/device-pin` | `time_tracking:admin` | `time_clock.terminal` |
| `PUT` | `/orgs/:orgId/time-clock/settings/device-pin` | `time_tracking:admin` | refused |

The device refusal on `PUT` needs no code. `@RequireDeviceRole` is currently
class-level on both settings controllers; moving it to the methods that want it
means `PermissionsGuard` hits its own `'This endpoint is not available to
devices'` branch for the rest. Concretely, on `SkiSwapSettingsController`:

```ts
@Controller('orgs/:orgId/ski-swap/settings')
@UseGuards(OrDeviceAuthGuard, OrgContextGuard, ModuleEnabledGuard, PermissionsGuard)
@RequireModule('ski_swap')
export class SkiSwapSettingsController {
  @Get()
  @RequireDeviceRole('ski_swap.staff_check_in')
  @RequirePermissions('ski_swap:report')
  get(@Param('orgId') orgId: string) { … }

  @Patch()                                    // D9
  @RequirePermissions('ski_swap:admin')
  update(…) { … }

  /**
   * Read by the iPad on every sync and by the Administration page. Plaintext,
   * deliberately (Plan 14 D4) — and therefore admin-only for people, which is
   * why it is not a field on the settings response every ski-swap page reads.
   */
  @Get('device-pin')
  @RequireDeviceRole('ski_swap.staff_check_in')
  @RequirePermissions('ski_swap:admin')
  getPin(@Param('orgId') orgId: string) { … }

  @Put('device-pin')
  @RequirePermissions('ski_swap:admin')
  setPin(@Param('orgId') orgId: string, @Body() body: UpdateDevicePinDto) { … }
}
```

`TimeClockSettingsController` gets the same treatment with its own role,
permissions, and `@Patch()` already in place.

> **Check during implementation:** moving `@RequireDeviceRole` off the class
> must not un-gate the existing `GET /settings` for devices. `PermissionsGuard`
> reads it with `getAllAndOverride([handler, class])`, so a method-level
> decorator is found; verify with the existing device-auth spec before
> relying on it.

### 4.3 Service

Two methods on each settings service, both trivial:

```ts
async getDevicePin(orgId: string): Promise<DevicePinResponse> {
  const row = await this.prisma.skiSwapSettings.findUnique({ where: { orgId } });
  return { devicePin: row?.devicePin ?? null };
}

async setDevicePin(orgId: string, devicePin: string | null): Promise<DevicePinResponse> {
  const row = await this.prisma.skiSwapSettings.upsert({
    where: { orgId },
    update: { devicePin },
    create: { orgId, devicePin },
  });
  return { devicePin: row.devicePin };
}
```

`TimeClockSettingsService` uses `this.get(orgId)` first, as its `update` already
does, since that row is created on first read rather than upserted.

**Audit.** Setting or clearing a PIN writes an `AuditLog` entry — who, when,
which module — recording that it changed and never the value. A PIN nobody can
account for is worse than one everybody knows.

---

## 5. Web

### 5.1 A shared card

`apps/web/src/components/DevicePinCard.tsx`, used by both pages, parameterised
by what it reads and writes rather than by module name:

```tsx
<DevicePinCard
  queryKey={['ski-swap/device-pin', orgId]}
  get={() => api.skiSwap.getDevicePin(orgId)}
  set={(devicePin) => api.skiSwap.setDevicePin(orgId, devicePin)}
  deviceLabel="check-in iPads"
/>
```

Behaviour:

- **Set:** four numeric inputs, or one `inputMode="numeric" maxLength={4}` field
  — one field, `type="password"` by default with an eye toggle to reveal, so the
  set and the look-up are the same control.
- **Current value:** masked as `••••` with the same reveal toggle. Revealed
  state is component-local and resets on navigation; it is never persisted.
- **No PIN set:** says so plainly, and says what it means — *"Anyone can open
  settings on a check-in iPad. Set a PIN to require one."*
- **Remove:** a link that sends `devicePin: null`, behind a `confirm()`. Its
  label is "Remove PIN", not "Clear", because what it removes is the gate.
- **Footer, both pages:** *"Takes effect the next time each iPad syncs."* This
  is the fact people will be surprised by — a changed PIN is not instant, and a
  lodge iPad with no signal keeps the old one until it has one.
- Validation is client-side too (`/^\d{4}$/`), so a typo does not cost a round
  trip.

### 5.2 Wiring

| File | Change |
|---|---|
| `lib/api.types.ts` | `DevicePinResponse { devicePin: string \| null }`. |
| `lib/api.ts` | `skiSwap.getDevicePin` / `setDevicePin`, `timeClock.getDevicePin` / `setDevicePin`. `skiSwap.updateSettings` switches `PUT` → `PATCH` (D9). |
| `pages/ski-swap/AdministrationPage.tsx` | `<DevicePinCard …/>` in a "Devices" section, above `LabelsPerItemSection`. The page is already behind `perms.has('ski_swap:admin')`. |
| `pages/time-tracking/SettingsPage.tsx` | `<DevicePinCard …/>` in a "Devices" section, above "Automatic clock-out". The tab is already `time_tracking:admin`-only in `TimeTrackingLayout`. |

Nothing else on either page moves.

---

## 6. iOS

### 6.1 Store

One migration, `v3-device-pin`, adding the column to both cache tables:

```swift
migrator.registerMigration("v3-device-pin") { db in
    try db.alter(table: "ski_swap_settings") { $0.add(column: "devicePin", .text) }
    try db.alter(table: "tc_settings")       { $0.add(column: "devicePin", .text) }
}
```

`SkiSwapSettingsRecord` and `TimeClockSettingsRecord` each gain
`var devicePin: String?`.

### 6.2 API clients

```swift
struct APIDevicePin: Codable { let devicePin: String? }

// SkiSwapAPIClient
func getDevicePin(orgId: String, token: String) async throws -> APIDevicePin

// TimeClockAPIClient
func getDevicePin(orgId: String, token: String) async throws -> APIDevicePin
```

Both follow the existing `get`/`decode(DataEnvelope<…>)` shape in their file.

### 6.3 Sync engines

In `SkiSwapSyncEngine` (around the existing `getSettings` block) and in
`TimeClockSyncEngine` (likewise), the PIN is fetched alongside and folded into
the record that is already being written:

```swift
// D7: only a successful fetch writes. A failed one leaves the cached PIN
// standing — reading a timeout as "the PIN was cleared" would open the gate on
// every iPad the moment the network wobbled.
var devicePin = (try? store.cachedSettings(orgId: orgId))?.devicePin
if let fetched = try? await apiClient.getDevicePin(orgId: orgId, token: token) {
    devicePin = fetched.devicePin
}
```

### 6.4 Ski Swap

`Features/SkiSwap/AdminSettings/AdminSettingsView.swift`:

- Delete `private let pinCode = "1938"`.
- Read the PIN from the store on appear (D10):
  ```swift
  @State private var requiredPin: String?
  // .onAppear: requiredPin = (try? appState.store?.cachedSettings(orgId: orgId))??.devicePin
  //            if requiredPin == nil { isUnlocked = true }   // D3
  ```
- `appendPinDigit` compares against `requiredPin` instead of the constant. The
  four-dot display and auto-submit are unchanged — the PIN is still four digits
  (D2).
- Add the line the Time Clock sheet will also carry: *"Set in PatrolKit under
  Ski Swap → Administration."* Someone who does not know the PIN needs to be
  told where it lives, not just refused.

`SkiSwapContext` is untouched.

### 6.5 Time Clock

The larger half, because there is behaviour to remove as well as add.

| File | Change |
|---|---|
| `Settings/TimeClockSettingsViewModel.swift` | `unlock()` compares against `store.timeClockSettings(orgId:)?.devicePin`, not `keychain.devicePin()`. Nil still unlocks (D3) — same line, different source. Delete `changePin(to:)`. |
| `Settings/TimeClockSettingsView.swift` | Delete `showChangePin`, `newPin`, the "Change PIN" row and `changePinSheet`. `NumericKeypad` on the gate goes `maxLength: 6` → `4` (D2). Add "Set in PatrolKit under Time Tracking → Settings." under the prompt. |
| `TimeClockCoordinator.swift` | The not-ready condition drops `\|\| !appState.keychain.hasDevicePin` and its comment. A terminal with a context is ready; the PIN is no longer something first run collects. |
| `NotReady/TimeClockNotReadyView.swift` | Delete the whole PIN stage: `pinStage`, `pin`, `pinConfirm`, `pinError`, `pinSetup`, `pinStageIsConfirming`, `handlePinStep`, and the `reload()` body that sets `pinStage`. The view reduces to `waiting` and `unbound`, and its doc comment loses the "the only thing first run still collects" sentence — first run now collects nothing. |
| `Services/KeychainService.swift` | Delete `saveDevicePin`, `devicePin()`, `hasDevicePin`. Keep `devicePinAccount` and its line in `delete()`, so an upgraded test device does not carry a dead keychain item forever; comment it as legacy. |

The three-strikes lockout in `TimeClockSettingsViewModel` stays as it is. Ski
Swap has no equivalent and does not gain one here — worth unifying, not worth
entangling with this change.

---

## 7. Deploying this

Per the standing pre-production practice, `patrolkit.io` is dropped and
reseeded rather than migrated, so the Prisma migration is generated for
correctness and never runs against data that matters.

Two consequences to be deliberate about:

1. **Every org starts with no PIN, and D3 means the gate is open.** Until an
   admin sets one, the Ski Swap admin sheet — which today asks for `1938` —
   opens straight through. That is a real, if brief, loosening on the day of
   deploy. Mitigated by seeding a PIN for the demo org in `prisma/seed.ts` and
   by the empty-state copy in §5.1 telling an admin exactly what the absence
   means.
2. **`1938` stops working**, on purpose, and is not seeded anywhere. It is in
   this repository's history and in every build shipped so far; carrying it
   forward as a default would make the fleet-wide known PIN permanent instead of
   ending it.

The iOS app must ship together with the API, since it stops reading the
keychain and starts reading a route that does not exist on an older server. An
old build against a new server keeps working — its keychain PIN is untouched —
so the ordering risk is only the other way round.

---

## 8. Tests

**API**

- `devicePin` accepts `"0000"` and `"1938"`; rejects `"123"`, `"12345"`,
  `"12a4"`, `""`; accepts `null`; rejects a missing field.
- `GET device-pin` returns `null` for an org that has never set one.
- `PUT` then `GET` round-trips; `PUT null` clears.
- A `:report`-only user is refused both `GET` and `PUT`.
- A device of the module's role is allowed `GET` and refused `PUT`.
- A device of the *other* module's role is refused both.
- The existing settings `GET` still admits the device after
  `@RequireDeviceRole` moves to the method (§4.2).

**Web**

- Card renders the empty state when `devicePin` is null, and masked-with-reveal
  when set.
- Submitting a non-four-digit value is blocked before the request.

**iOS** (`PatrolKitTests`)

- `PatrolKitStoreTimeClockTests`: the `v3` migration adds the column and an
  existing row survives it.
- `TimeClockAPIDecodingTests`: `{"devicePin": null}` and `{"devicePin":"1234"}`
  both decode.
- A new `DevicePinGateTests`: `unlock()` with a nil stored PIN unlocks; with a
  set PIN, the right entry unlocks and a wrong one counts a failure; three
  failures lock out.
- D7: a sync pass whose PIN fetch throws leaves the cached PIN unchanged.

---

## 9. Work order

1. **Model** — two columns, migration, seed a PIN for the demo org.
2. **Contracts** — shared PIN schemas; `UpdateSkiSwapSettingsSchema` to partial.
3. **API** — services, four routes, `@RequireDeviceRole` moved to methods,
   audit entries. Specs alongside.
4. **Web** — `api.types.ts`, `api.ts` (including the `PUT` → `PATCH` switch),
   `DevicePinCard`, both pages.
5. **iOS store** — `v3` migration, two record fields.
6. **iOS sync** — API clients, both engines, D7 behaviour.
7. **iOS Ski Swap** — `AdminSettingsView` reads the store, constant deleted.
8. **iOS Time Clock** — view model, settings view, coordinator, not-ready view,
   keychain. This is the step that removes the old mechanism, and it is last so
   that nothing is removed before its replacement is proven.
9. **End to end** — set a PIN on the web, sync both iPads, confirm each gate
   takes the new PIN and refuses the old; clear it and confirm both sheets open.
