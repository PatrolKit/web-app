# Plan 12 — One Station Concept, and Modules That Own Their Hardware

> **Status:** Draft — for review.
> **Depends on:** [Plan 11](../11_self_service_checkin/IMPLEMENTATION_PLAN.md), which built
> `CheckinStation`, the print queue, and the ESP-32 bridge contract.
> **Constraint:** Still pre-production. No devices are deployed, the database holds one org
> with one station and one bridge, and destructive migrations are acceptable.
> **Out of scope:** The bridge's BLE and HTTP contracts. Neither changes.

---

## 1. What this is

Two changes that turn out to be the same change.

**A check-in station is one concept with two ways to drive a printer.** Today a *self-service*
station is a first-class row — a code, a bridge, a printer — while a *staffed* station is an
iPad with a code, picking a printer from a pool at runtime, related to nothing. They already
share the org's 32-character SKU namespace, because a SKU's namespace character has to
identify exactly one minting endpoint. They are the same thing. Only one of them is modelled.

**Modules own their hardware.** Printers and stations live under a `Devices` nav item that
ski-swap admins cannot open, gated on a permission they do not hold. Devices retires; Ski
Swap and Time Tracking each take their own.

And `Ski Swap - Bulk Seller` goes, because nothing has ever done anything with it.

## 2. What is wrong today

Five things, in the order they cost someone time.

**A ski-swap admin cannot reach printers or stations.** `swap-admin@example.com` holds
`ski_swap:report/manage/admin` and no `devices:read` — and the Devices nav item is gated on
`devices:read` ([`AppShell.tsx:113`](../../../apps/web/src/components/AppShell.tsx)). The tabs
themselves only ever required ski-swap permissions. The person whose job is configuring
printers for a swap cannot open printer configuration. This is a live bug, and it is the
argument for the whole reorganisation: the permission model already says where these belong.

**Two of the three Devices tabs hide themselves.** Printers and Check-in stations are gated
on the `ski_swap` module. A page that conceals two-thirds of itself depending on a module is
organised on the wrong axis.

**A staffed station is not a thing.** It is an iPad that picks a printer each session. Nothing
records which printer belongs at which counter, so nothing can be said about whether that
counter is working — the status work in Plan 11 covers self-service stations only.

**Bridges consume SKU codes they never use.** `SKI_SWAP_ROLES` includes the printer adapter,
so provisioning one allocates a character from the 32-code pool
([`devices.service.ts:56`](../../../apps/api/src/devices/devices.service.ts)). A bridge never
mints a SKU; its station's code does. Every bridge silently costs a code that could have been
a station.

**`Ski Swap - Bulk Seller` does nothing.** It appears in five `@RequireDeviceRole` lists,
always paired identically with `Ski Swap - Check-In` and never alone, so it grants exactly the
same access. iOS routes on `hasPrefix("Ski Swap")`, so it lands in the same coordinator. It has
had no distinct behaviour since it was introduced in `9ecf5f7` when a free-form role string
became an enum.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **`CheckinStation` covers both kinds.** A station is a code, a printer, and the hardware at that counter — a staff iPad, a print bridge, or both. | They already share the SKU namespace, which is the domain saying they are one thing. Modelling them separately is what leaves a staffed counter unobservable while a self-service one reports its printer link. |
| **D2** | **Kind is derived from whether an attendant is bound, not stored.** An iPad at the counter means staffed; no iPad means self-service. | A stored `kind` can contradict the hardware attached to it. Deriving it means the two can never disagree. A station with neither is simply "not set up", which is already a state the UI renders. |
| **D3** | **Only self-service stations get a QR code.** | The QR exists so a seller can point their own phone at a station. Staff already have the iPad in their hands; a QR there is a control nobody uses and a support question nobody needs. |
| **D4** | **The station owns the SKU code. `Device.skiSwapDeviceCode` becomes a mirror of it.** | One pool, one owner. The field stays on the device *response* so iOS keeps reading the code where it already looks — it just gets served the station's value once bound. |
| **D5** | **Bridges stop consuming codes.** Only stations do. | A bridge does not mint SKUs. Reclaiming this roughly doubles the usable pool at a venue running mixed hardware. |
| **D6** | **Business sellers keep their own path.** A printer assigned to them, no station, no code, no QR, no bridge. | A business seller is not a counter. They enter stock from wherever they are, and their SKUs come from the server-minted sequence — that already works and has no station-shaped problem to solve. |
| **D7** | **Roles are renamed inside the `Ski Swap - ` prefix.** `Ski Swap - Check-In` → `Ski Swap - Staff Check-In`; `Ski Swap - Network Printer Adapter` → `Ski Swap - Print Bridge`. | "Network Printer Adapter" is not what anyone calls it — the code, the UI, the runbook and the firmware docs all say *bridge*. Keeping the prefix is not cosmetic: iOS routes on `hasPrefix("Ski Swap")`, so staying inside it means the rename itself costs no iOS release. |
| **D8** | **`Ski Swap - Bulk Seller` is deleted outright.** | It grants nothing the check-in role does not. Leaving it costs a SKU code per device and offers a third option in a dropdown that misleads — the current UI hint describes a behaviour that was never built. |
| **D9** | **The Devices nav item retires.** Ski Swap takes printers and stations; Time Tracking takes time-clock devices. | The permission model already assigns them that way. See §7 for what is lost with it, which is real. |
| **D10** | **A staff station's bridge is optional, and when bound it owns printing.** The iPad saves an item, the server renders, the station's bridge prints — exactly as self-service does. | A bridge holds its printer's BLE link continuously, reconnecting forever because the unit is unattended, so an iPad cannot share that printer while a bridge owns it. One of them drives it. Optional means a counter can start as an iPad and a printer and gain a bridge later without being re-modelled. |
| **D11** | **The Bluetooth override is always available — it is not a fallback the app switches into.** Staff can pick any known printer and print directly, whenever they want. | No mode detection, no "is the network down" heuristic, no automatic switching to get wrong. It also needs no spare hardware: a printer held by a live bridge refuses the connection, and unplugging that bridge is what frees it — which is both the remedy when the bridge has failed and the way to deliberately take a printer over. The printers offered come from the iPad's last sync, so the list survives the outage that prompted the override. |
| **D12** | **An override print must not produce a second tag when the item syncs.** The item arrives already marked printed, and the server skips the enqueue rather than queueing a tag the bridge prints later. | The iPad holds items locally when offline and syncs them when the network returns — by which time the tag is already on the ski. Auto-enqueueing on arrival would put a duplicate through the bridge for every item checked in during the outage, discovered as a pile of orphan tags. |
| **D13** | **The station's code applies however the tag was printed.** | The code records *where an item was checked in*, not how the paper came out. A tag printed over Bluetooth because the bridge was down still belongs to that counter, and a SKU whose namespace depended on the print path would be useless for tracing. |
| **D14** | **Module admins provision their own hardware.** `ski_swap:admin` may create, rotate and revoke ski-swap devices; `time_tracking:manage` the same for time clocks. | Retiring Devices without this reproduces the bug it is meant to fix, one page over. A module admin who can already configure a station is not meaningfully restrained by being unable to create the box that serves it. |

## 4. The model

```prisma
model CheckinStation {
  id    String @id @default(cuid())
  orgId String
  name  String
  /// One character, unique per org. The SKU namespace for everything checked in
  /// here, staffed or self-service, however the tag was printed (D13). Now the
  /// *only* consumer of the pool.
  code  String @db.VarChar(1)

  /// The staff iPad stationed at this counter. Its presence is what makes the
  /// station staffed rather than self-service (D2).
  attendantDeviceId String? @unique
  /// The bridge that prints for this station. Required for self-service — a
  /// seller has no other way to get a tag — and optional for staffed, where the
  /// iPad can print over Bluetooth instead (D10, D11).
  bridgeDeviceId    String? @unique
  /// The printer at this counter, whoever ends up driving it.
  printerId         String?

  deletedAt DateTime?
  ...
}

model SwapPrinter {
  ...
  /// Dropped. The station already records which bridge and which printer belong
  /// together; two places saying it is one place too many to disagree.
  - bridgeDeviceId String? @unique
}

model Device {
  ...
  /// Dropped. The station owns the code now (D4); `GET /devices/me` serves the
  /// bound station's value under the same name so iOS needs no change.
  - skiSwapDeviceCode String? @db.VarChar(1)
}
```

`CheckinStation.deviceId` becomes `bridgeDeviceId` — same column, a name that says
which of the two devices it holds.

`SwapPrinter.assignedSellerId` is unchanged: it still pins a printer to a business seller (D6).

**Migration is destructive and that is fine.** The deployed database holds one org, one
station, one bridge and no check-in iPads. Wipe and reseed rather than writing a data
migration for rows that do not exist.

## 5. Roles

| Before | After |
|---|---|
| `Ski Swap - Check-In` | `Ski Swap - Staff Check-In` |
| `Ski Swap - Bulk Seller` | *deleted* |
| `Ski Swap - Network Printer Adapter` | `Ski Swap - Print Bridge` |
| `Time Clock` | unchanged |

Every `@RequireDeviceRole` list that names the two ski-swap roles keeps naming both under
their new names. The parity test added in Plan 11 —
[`devices.contracts.spec.ts`](../../../apps/api/src/contracts/devices.contracts.spec.ts) —
already asserts the web's role list matches `DeviceRoleSchema`, so a rename that misses one
side fails there rather than in a dropdown.

## 6. Navigation

```
Ski Swap
  Dashboard · Items · Sellers · Swaps · Check-in · Printers · Administration

Time Tracking
  On Shift · Shifts · Hours · Roster · Devices · Settings
```

**Check-in** lists every station, staffed and self-service, with the rolled-up status from
Plan 11. Both kinds show a driver, a printer, a queue and a status; only self-service ones
offer a QR. Provisioning a driver happens here — "add a station" then "provision its iPad" or
"provision its bridge", creating the credential and binding it in one step, rather than
sending someone to another page to make a device and come back.

**Printers** is unchanged in content: Phomemo configuration, paper size, margins, seller
assignment.

**Time Tracking → Devices** takes the time-clock half of the old page: provision, rotate,
revoke, last seen.

Two pieces of cleanup fall out of touching this nav. `SkiSwapLayout` still gates on
`business_seller` ([line 110](../../../apps/web/src/pages/ski-swap/SkiSwapLayout.tsx)), a
permission retired in Plan 10 — the same bug already fixed in `App.tsx` and `AppShell` still
carries it too. And the `devices:read` / `devices:provision` / `devices:revoke` permissions
survive as the authority for credential operations; they simply no longer gate a page of
their own.

## 7. What retiring Devices costs

**There is no longer one list of everything holding a credential to the org.** That view
matters most in the moment you least want to hunt for it: something is compromised and you
need to revoke it now, without first working out which module owns it.

Two mitigations, in order of preference:

- **Platform Admin grows a device registry** — every device across every org, read-only, with
  revoke. It is the natural home: cross-cutting, administrative, and already permission-gated
  away from module admins.
- **Accept it for now** and rely on each module's list. Defensible at current scale — one org,
  a handful of devices — and reversible.

This plan takes the second and notes the first as the follow-up. Retiring the nav item is not
the same as retiring the capability, and the capability should come back before the product
has more than a few orgs in it.

## 8. iOS

**Phases 1–3 need no iOS release.** Three things could have forced one, and none do:

- **Role routing** matches `hasPrefix("Ski Swap")`. Both renamed roles keep the prefix (D7).
- **The SKU code** arrives as `skiSwapDeviceCode` on `GET /devices/me`. The field stays; it is
  served from the bound station instead of the device row (D4). The iPad mints SKUs offline
  from that value and is indifferent to where it came from.
- **Printer selection** keeps working exactly as it does now.

**Phase 5 does need a release**, because the print path is the part iOS owns:

- **Enqueue when bound.** An item saved at a station whose bridge is bound goes to the queue
  rather than to a printer the app holds. This is new — the app prints today and posts a
  client-minted `sku`.
- **Keep the Bluetooth override always reachable** (D11), not behind an error state. It is the
  answer to a bridge that has failed, a network that is down, and "I want to use that other
  printer", and the app should not try to work out which.
- **Mark an override print as printed** so the server skips the enqueue when the item syncs
  (D12). Without this, every item checked in during an outage prints a second tag once the
  bridge is back.
- **Say when there is no station.** An unbound iPad has no code and cannot mint SKUs offline.
  Today every device gets a code at creation; after this a `Ski Swap - Staff Check-In` gets one
  when it is bound. "This iPad is not assigned to a station yet" beats failing on the first
  item.

The server side of Phase 5 is small — accept a `stationId` and an already-printed flag on the
staff item-create path, and skip the enqueue when the flag is set — so the server can land
first and wait.

## 9. Phases

**Phase 1 — Roles.** Drop `Ski Swap - Bulk Seller`, rename the other two, update every
`@RequireDeviceRole` list and the web role list. The parity test proves both halves agree.
Independent of everything else and safe to land alone.

**Phase 2 — The station model.** Allow a staff check-in device as a station driver, derive
kind from the driver's role, move the SKU code onto the station, stop allocating codes to
bridges, and serve the station's code through `GET /devices/me`. Wipe and reseed.

**Phase 3 — Navigation.** Move Printers and Check-in under Ski Swap, move time-clock devices
under Time Tracking, retire the Devices nav item and route. Inline driver provisioning on the
Check-in tab. Fix the two `business_seller` gates while in here.

**Phase 4 — Check-in tab.** One list, both kinds, rolled-up status, QR only where it means
something. Provision-and-bind in one step. A staffed station shows its printer whether or not
a bridge drives it.

**Phase 5 — The staff print path.** Server accepts `stationId` and an already-printed flag
from the iPad; iOS enqueues when bound, keeps the Bluetooth override always available, and
reports an override print as printed. The only phase needing an iOS release, and the only one
that can be deferred without leaving something half-built — until it ships, a staff iPad
prints over Bluetooth exactly as it does today.

## 10. Verification

The smoke scripts from Plan 11 cover the parts a unit test cannot honestly reach, and three of
them touch this work:

- `smoke-print-queue.mjs` — claim, ack, nack, expiry, the attempt cap, role refusal. The role
  rename must not break the refusal assertion, which names a role string directly.
- `smoke-checkin.mjs` — the whole self-service walk, including SKUs carrying the station code.
- `smoke-sku-concurrency.mjs` — the 32-code pool and the 13-character barcode ceiling.

Add to that: a staffed station mints SKUs under its own station code; an unbound iPad is told
it has no station rather than minting under a null one; and an item arriving already marked
printed does not queue a tag (D12) — the duplicate that check exists to prevent is invisible
until a bridge comes back and prints a pile of orphans.
