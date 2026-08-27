# Plan 12 — One Station Concept, and Modules That Own Their Hardware

> **Status:** Draft — for review.
> **Depends on:** [Plan 11](../11_self_service_checkin/IMPLEMENTATION_PLAN.md), which built
> `CheckinStation`, the print queue, and the ESP-32 bridge contract.
> **Constraint:** Still pre-production. No devices are deployed, the database holds one org
> with one station and one bridge, and destructive migrations are acceptable.
> **Out of scope:** The bridge's BLE and HTTP contracts. Neither changes.
> **The iOS app is being rewritten**, so nothing here is shaped to keep the existing one
> working. Where the current app is described it is as evidence about the domain, never as a
> constraint. §8 states what the new app has to implement.

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
same access. The outgoing iOS app routed every ski-swap role into one coordinator, so it made
no distinction there either. The role has had no distinct behaviour anywhere since it was
introduced in `9ecf5f7`, when a free-form role string became an enum.

## 3. Decisions

| # | Decision | Rationale |
|---|---|---|
| **D1** | **`CheckinStation` covers both kinds.** A station is a code, a printer, and the hardware at that counter — a staff iPad, a print bridge, or both. | They already share the SKU namespace, which is the domain saying they are one thing. Modelling them separately is what leaves a staffed counter unobservable while a self-service one reports its printer link. |
| **D2** | **Kind is derived from whether an attendant is bound, not stored.** An iPad at the counter means staffed; no iPad means self-service. | A stored `kind` can contradict the hardware attached to it. Deriving it means the two can never disagree. A station with neither is simply "not set up", which is already a state the UI renders. |
| **D3** | **Only self-service stations get a QR code.** | The QR exists so a seller can point their own phone at a station. Staff already have the iPad in their hands; a QR there is a control nobody uses and a support question nobody needs. |
| **D4** | **The station owns the SKU code.** `Device.skiSwapDeviceCode` is dropped; a device's own record reports the station it is bound to, code included. | One pool, one owner, and a code that follows the counter rather than the box sitting on it. Swapping a failed iPad keeps the namespace; today it would change. Whether a client needs the code at all depends on whether it mints SKUs offline — see §8. |
| **D5** | **Bridges stop consuming codes.** Only stations do. | A bridge does not mint SKUs. Reclaiming this roughly doubles the usable pool at a venue running mixed hardware. |
| **D6** | **Business sellers keep their own path.** A printer assigned to them, no station, no code, no QR, no bridge. | A business seller is not a counter. They enter stock from wherever they are, and their SKUs come from the server-minted sequence — that already works and has no station-shaped problem to solve. |
| **D7** | **A role is an identifier with a separate display label.** `ski_swap.staff_check_in`, `ski_swap.print_bridge`, `time_clock.terminal`, rendered as "Staff Check-In Station", "Print Bridge" and "Time Clock". | Today a role is both at once — a prose string that the UI prints *and* that clients match on — which is precisely why renaming one was ever entangled with client routing. Split, a label can be reworded without touching anything, and a client derives the module from the segment before the dot rather than string-matching English. "Network Printer Adapter" also goes: the code, the UI, the runbook and the firmware docs all say *bridge*. |
| **D8** | **`Ski Swap - Bulk Seller` is deleted outright.** | It grants nothing the check-in role does not. Leaving it costs a SKU code per device and offers a third option in a dropdown that misleads — the current UI hint describes a behaviour that was never built. |
| **D9** | **The Devices nav item retires.** Ski Swap takes printers and stations; Time Tracking takes time-clock devices. | The permission model already assigns them that way. See §7 for what is lost with it, which is real. |
| **D10** | **A staff station's bridge is optional, and when bound it owns printing.** The iPad saves an item, the server renders, the station's bridge prints — exactly as self-service does. | A bridge holds its printer's BLE link continuously, reconnecting forever because the unit is unattended, so an iPad cannot share that printer while a bridge owns it. One of them drives it. Optional means a counter can start as an iPad and a printer and gain a bridge later without being re-modelled. |
| **D11** | **The Bluetooth override is always available — it is not a fallback the app switches into.** Staff can pick any known printer and print directly, whenever they want. | No mode detection, no "is the network down" heuristic, no automatic switching to get wrong. It also needs no spare hardware: a printer held by a live bridge refuses the connection, and unplugging that bridge is what frees it — which is both the remedy when the bridge has failed and the way to deliberately take a printer over. One requirement falls out of this: the list of printers has to be readable without the network. Fetched on demand, the override is unavailable in exactly the case it exists for. |
| **D12** | **An override print must not also enqueue.** An item whose tag was printed over Bluetooth arrives marked printed, and the server skips the enqueue. | The tag is already on the ski by the time the server hears about the item — immediately if the app was online, later if it was not. Enqueueing anyway puts a second tag through the bridge, and if it happened during an outage it happens for every item checked in during it, discovered as a pile of orphan tags nobody can place. |
| **D13** | **The station's code applies however the tag was printed.** | The code records *where an item was checked in*, not how the paper came out. A tag printed over Bluetooth because the bridge was down still belongs to that counter, and a SKU whose namespace depended on the print path would be useless for tracing. |
| **D14** | **Module admins provision their own hardware.** `ski_swap:admin` may create, rotate and revoke ski-swap devices; `time_tracking:manage` the same for time clocks. **`devices:read`, `devices:provision` and `devices:revoke` retire with the page.** | Retiring Devices without this reproduces the bug it is meant to fix, one page over. A module admin who can already configure a station is not meaningfully restrained by being unable to create the box that serves it. Keeping `devices:*` as a second axis would mean a ski-swap admin could provision a time clock, or — as today — configure a station they cannot supply hardware for. |
| **D15** | **A printer serves exactly one thing.** One station at most, or one business seller at most, never both and never two of either. | A printer is a single BLE peripheral: whoever holds the link owns it. Two stations sharing one means two bridges fighting for it — the contention D10 exists to avoid, arrived at from a different direction. A station and a business seller sharing one is the same failure with a worse symptom: the bridge wins, and the seller's printing stops with nothing on screen to explain why. `CheckinStation.printerId` becomes unique, which covers station-to-station; the seller case is a cross-table rule and has to be enforced on both write paths. |

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
  /// The printer at this counter, whoever ends up driving it. Unique: a printer
  /// serves one station at most (D15). MySQL permits many NULLs in a unique
  /// index, so any number of stations may have no printer yet — the same trick
  /// `SkiSwap.activeSkuPrefix` uses.
  printerId         String? @unique

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
  /// Dropped. The station owns the code now (D4), and a device reports the
  /// station it is bound to rather than carrying a code of its own.
  - skiSwapDeviceCode String? @db.VarChar(1)
}
```

`CheckinStation.deviceId` becomes `bridgeDeviceId` — same column, a name that says
which of the two devices it holds.

`SwapPrinter.assignedSellerId` is unchanged in shape: it still pins a printer to a business
seller (D6). What changes is that it and `CheckinStation.printerId` are now mutually exclusive
(D15). No schema can express that across two tables, so it is enforced on both write paths and
reflected in both pickers:

- Binding a printer to a station refuses one that is assigned to a seller.
- Assigning a printer to a seller refuses one that is bound to a station.
- The station's printer dropdown offers only unassigned printers; the seller's offers only
  unbound ones. The guard is the server's, but a control that cannot express the mistake is
  worth more than an error message after it.

**Soft delete has to release the printer**, as it already releases the bridge — a retired
station holding a unique `printerId` would keep that printer out of circulation for good.

**Migration is destructive and that is fine.** The deployed database holds one org, one
station, one bridge and no check-in iPads. Wipe and reseed rather than writing a data
migration for rows that do not exist.

## 5. Roles

| Identifier | Label |
|---|---|
| `ski_swap.staff_check_in` | Staff Check-In Station |
| `ski_swap.print_bridge` | Print Bridge |
| `time_clock.terminal` | Time Clock |

`Ski Swap - Bulk Seller` has no successor (D8). The module a device belongs to is the segment
before the dot, so nothing has to match on prose.

Every `@RequireDeviceRole` list that names the two ski-swap roles keeps naming both, under the
new identifiers. The parity test added in Plan 11 —
[`devices.contracts.spec.ts`](../../../apps/api/src/contracts/devices.contracts.spec.ts) —
already asserts the web's role list matches `DeviceRoleSchema`, so a rename that misses one
side fails there rather than in a dropdown. It should grow a second assertion: every role has
a label, since an identifier leaking into the UI is now a visible bug rather than merely ugly.

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

### Permissions and the seed

`devices:read`, `devices:provision` and `devices:revoke` retire with the page (D14). Module
hardware is authorised by the module's own admin permission:

| Operation | Authorised by |
|---|---|
| Provision, rotate, revoke a `ski_swap.*` device | `ski_swap:admin` |
| Provision, rotate, revoke a `time_clock.*` device | `time_tracking:manage` |
| Bind a station's bridge, iPad or printer | `ski_swap:admin` |
| View station status, queue depth, send a test print | `ski_swap:report` |

**The seed has to move with this**, or the plan fixes the bug on paper and leaves it in place.
`swap-admin@example.com` holds the three ski-swap permissions and nothing else — which is the
right grant once `ski_swap:admin` authorises ski-swap hardware, and the wrong one today. The
three retired permissions come out of the permission table, the seeded grants, and every role
that references them.

Worth checking against a real org before this lands: the seed is a fixture, and if anyone out
there holds `devices:*` without a module admin permission, they lose access rather than gain
it. At one org with one super admin that is theoretical, but it is the kind of thing that is
theoretical right up until it is not.

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

## 8. What the iOS rewrite has to implement

The app is being rebuilt, so this is a contract rather than a migration. Nothing above is
shaped to keep the outgoing app working.

**Identity.** A device authenticates with its client id and secret and reads its own record.
That record names the station it is bound to — id, name, and the station's SKU code — or says
it is bound to none. **An unbound iPad cannot check anything in**, and should say so rather
than failing at the first item.

**SKUs.** Whether the app needs the station's code at all is a decision for the rewrite:

- **If it mints SKUs offline**, it needs the code, and it must use the station's — not one of
  its own. That is what keeps a swapped iPad from changing the namespace mid-swap.
- **If it does not**, the server mints on create and the code is informational. Simpler, and
  it removes a whole class of offline collision, at the cost of not being able to produce a
  tag with no network.

The server supports both; the plan does not assume either.

**Printing.** Two paths, and the app chooses per print rather than per session:

- **Bound station, reachable server** — save the item and let the station's bridge print it.
  The app does not touch Bluetooth.
- **The Bluetooth override, always available** (D11) — pick any known printer and print
  directly. Not an error state, not a mode: the answer to a failed bridge, a dead network, and
  "use that other printer", without the app having to work out which. A printer held by a live
  bridge will refuse the connection; unplugging that bridge frees it.

**An override print reports itself printed** (D12), so the server skips the enqueue when the
item arrives. Without it, every item checked in during an outage prints a second tag once the
bridge is back — discovered as a pile of orphan tags nobody can place.

## 9. Phases

**Phase 1 — Roles.** Drop `Ski Swap - Bulk Seller`, rename the other two, update every
`@RequireDeviceRole` list and the web role list. The parity test proves both halves agree.
Independent of everything else and safe to land alone.

**Phase 2 — The station model.** Add the attendant slot, rename `deviceId` to
`bridgeDeviceId`, derive kind from the attendant, move the SKU code onto the station, stop
allocating codes to bridges, make `printerId` unique and release it on soft delete, and
enforce the printer/seller exclusion on both write paths (D15). A device's own record reports
the station it is bound to. Wipe and reseed.

**Phase 3 — Navigation and permissions.** Move Printers and Check-in under Ski Swap, move
time-clock devices under Time Tracking, retire the Devices nav item and route, retire the
three `devices:*` permissions, and reseed the roles so a module admin can supply their own
hardware. Inline driver provisioning on the
Check-in tab. Fix the two `business_seller` gates while in here.

**Phase 4 — Check-in tab.** One list, both kinds, rolled-up status, QR only where it means
something. Provision-and-bind in one step. A staffed station shows its printer whether or not
a bridge drives it.

**Phase 5 — The staff print path, server side.** Accept `stationId` and an already-printed
flag on the staff item-create path, and skip the enqueue when the flag is set. Small, and it
lands before the app needs it — §8 is the contract the rewrite builds against.

## 10. Verification

The smoke scripts from Plan 11 cover the parts a unit test cannot honestly reach, and three of
them touch this work:

- `smoke-print-queue.mjs` — claim, ack, nack, expiry, the attempt cap, role refusal. The role
  rename must not break the refusal assertion, which names a role string directly.
- `smoke-checkin.mjs` — the whole self-service walk, including SKUs carrying the station code.
- `smoke-sku-concurrency.mjs` — the 32-code pool and the 13-character barcode ceiling.

Add to that: a printer cannot be bound to two stations, nor to a station and a seller at once,
from either direction (D15); a retired station releases its printer; a staffed station mints
SKUs under its own station code; an unbound iPad is told
it has no station rather than minting under a null one; and an item arriving already marked
printed does not queue a tag (D12) — the duplicate that check exists to prevent is invisible
until a bridge comes back and prints a pile of orphans.
