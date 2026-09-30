# Plan 27 — One print bridge for several staffed stations

Today a bridge serves exactly one check-in station: `CheckinStation.bridgeDeviceId`
is unique. A staffed counter whose iPad has no printer of its own needs a bridge of
its own to get tags out. This plan lets one bridge, driving one printer, print for
any number of staffed counters, so a swap can run several iPads against a single
print table.

Scope is the server and the web, plus one change to the iPad's tag template so the
tags it prints still match the bridge's (§7). No firmware change is needed (§8).

---

## 1. Decisions

| | |
|---|---|
| **What a shared bridge drives** | One printer and one scanner, as now. Every station it serves prints there. |
| **Who may share** | Staffed stations only. A bridge serves either one self-service station, or any number of staffed ones. §3 |
| **Order at the printer** | First queued, first printed, with each batch kept together. §4 |
| **Telling whose tags are whose** | Every item tag shows its station's letter, read from the SKU. §6 |
| **Firmware** | Unchanged. The claim still carries a `stationId`; a new `stationIds` lists them all. §8 |

---

## 2. What is there today

- **Binding:** `CheckinStation.bridgeDeviceId` is `@unique`, and `Device` has a
  single `bridgedStation`. `StationService.assertDeviceFree` refuses a bridge that
  already serves another station.
- **The claim** (`PrintQueueService.claim`) looks up *the* station for the bridge,
  then works only with that station:
  - it takes jobs for that station;
  - it sweeps that station's expired claims;
  - it checks that station for jobs still owed an ack;
  - it holds an empty claim on that station's wake-up;
  - it answers `stationId`.
- **Printing target:** a job is rendered for the station's bridge's printer.
- **Job ownership** (ack, nack, raster) is checked through
  `station: { bridgeDeviceId }`. A relation filter, so it already works with any
  number of stations.
- **What stations show about a bridge:** device lists, printer and scanner rows,
  `/devices/me` and the telemetry tab each name the bridge's one station.
  - The iPad shows that name as "Driven by the bridge at …".
  - The firmware shows the claim's `stationId` in its debug console, and uses it
    for nothing else.
- **Tags don't say where they came from.** An item tag carries the name, the price
  and the SKU. The SKU does include the station letter when the server or the iPad
  minted it (`SS26-A-0001`), but only as a small character in the middle of a
  number.

---

## 3. The binding

**Schema:**
- Drop the unique index on `CheckinStation.bridgeDeviceId` and keep a plain
  index.
- `Device.bridgedStation` becomes `bridgedStations CheckinStation[]`.

MySQL won't drop an index a foreign key relies on until another index covers the
column, so the migration creates the plain index first. The migration removes a
constraint and changes no data.

**The rule:** a bridge serves either **exactly one self-service station** or **one
or more staffed stations**, never a mix. It's checked in `StationService`, in three
places:

- **Binding a bridge to a station.** This is allowed if the bridge is free.
  - It's also allowed if the station is staffed and every station the bridge
    already serves is staffed.
  - Otherwise it's refused. The message names what's in the way, for example:
    *"That bridge serves the self-service station 'Lodge QR'. A self-service
    station keeps its bridge to itself."*
- **Removing a station's attendant iPad**, which makes the station self-service.
  This is refused while the station shares its bridge: *"Station 3 shares its
  bridge with Station 1 and 2. Give it its own bridge, or unbind it, before making
  it self-service."*
- **Binding an attendant.** This can only make a station staffed, so it needs no
  check.

The rule is why self-service tags always come out at the seller's own station: a
self-service seller is standing at the QR code with nobody to fetch tags from
elsewhere.

---

## 4. The claim

`PrintQueueService.claim` works with the bridge's stations as a set:

- **Station lookup:** all live stations whose `bridgeDeviceId` is this device.
  With none, the claim is `404` as now.
- **Take:** `WHERE stationId IN (…)`, ordered `createdAt, seq` rather than
  `seq, createdAt`.
  - Each batch is written by one `createMany`, and MySQL gives every row in one
    statement the same `NOW(3)`. So ordering by time first keeps each batch
    together and in its own order, and prints batches in the order they were
    queued.
  - The old order put every batch's first job ahead of any second job. That was
    harmless with one busy counter, but it would interleave several counters'
    tags.
- **Abandon sweep, outstanding-ack check:** across the same set.
- **Holding an empty claim:** the held request registers on every one of its
  stations' wake-ups (`waitForWork` takes a list), so an enqueue at any of them
  wakes it.
- **Render target:** the bridge's own printer (`device.bridgedPrinter`), rather
  than the printer reached through a single station. It's the same printer either
  way; this just stops the code implying there's one station.
- **Response:**
  - `stationIds` lists every station the bridge serves.
  - `stationId` stays, and is the first of them by name. It exists for firmware
    that shows it, and nothing reads it for behaviour.

Fairness across counters is first come, first served. One counter queuing forty
tags holds the printer for those forty. A round-robin between stations would
split batches, which is exactly what staff sorting tags by hand don't want.

---

## 5. Everywhere a bridge names its station

Each of these reads `bridgedStation` today. With several stations, each response
keeps its existing field, as a single string for older clients, and gains a list
beside it:

| Where | Existing field | Becomes | Added |
|---|---|---|---|
| Station list (`StationService`) | — | — | `bridgeSharedWith: string[]`: the other stations on the same bridge |
| Device list (`DevicesService`) | `stationName` | names joined, "Station 1, Station 2" | `stationNames` |
| `/devices/me` | `station` | the first station, for a bridge | `stations`, for a bridge |
| Printer and scanner rows | `stationName` | names joined | `stationNames` |
| Telemetry, print bridges | `station` | names joined | `stations` |

The iPad's "Driven by the bridge at …" line reads the joined string and needs no
change.

---

## 6. The station letter on every tag

Every item tag shows its station's letter, prominently, on the 50 × 30 and the
62 × 100 layouts alike.

**Read from the SKU, not from the job.**
- Server- and iPad-minted SKUs are `<prefix>-<code>-<counter>`, and `sku.util.ts`
  gains the inverse of `formatSku`, `stationCodeOf(sku)`, that returns the code or
  null.
- So the letter is the counter where the item was *checked in*.
  - It's the same on a first print and a reprint, from any bridge or iPad.
  - It needs no new column and no change to what a print job carries.
- **SKUs with no station part get no letter:**
  - web-entered items (`SS26-0001`);
  - legacy ticket numbers, which are pre-printed and not tags.

**Layout.**
- A filled square with the letter reversed out of it:
  - compact tier: in the lower half, beside the price;
  - tall tier: in the foot, beside the barcode's number.
- It must not narrow the barcode. The widest SKU (13 characters) already needs the
  full width at 2 dots per module.
- The exact size and position are to be settled on a printed sample of each
  stock. The renderer spec gains a golden-raster fixture for each once they are.

**Everywhere a tag is drawn:**
- the server renderer, which serves bridges and the web;
- the iPad's port (`ItemTagTemplate.swift`), so a tag from either still matches
  the other, row for row. That's a handoff to the iOS side (§7).

---

## 7. Web and iPad

**Web, Stations tab:**
- A staffed station's bridge picker also lists bridges that already serve other
  staffed stations, marked "also serves Station 1".
- A self-service station's picker lists only free bridges.
- Each station row says when its bridge is shared.

**Web, Printers and Hardware pages:** a bridge's row lists every station it serves.

**Web, station queue panel:** it keeps counting the station's own jobs, and adds a
line when the bridge is shared: *"Shares its printer with Station 1 and 2. Tags
print in the order they are queued."*

**iPad:** a handoff note asking for two things:
- the tag layout change in §6, to match the server's pixel for pixel;
- to read `stations` from `/devices/me` if it ever wants more than the first.

It needs nothing else: whether it prints itself or through its station's bridge
is unchanged.

---

## 8. Firmware

Nothing to change:
- The bridge still drives one printer and one scanner, told to it by the claim's
  `printer` and `scanner`.
- It shows the claim's `stationId` in its debug console and uses it for nothing
  else.
- Ack, nack, rasters and ranges are unchanged, because job ownership is already
  checked through the relation.

A short note to the firmware side says `stationIds` exists, in case the console
wants to show all of them.

---

## 9. Not in this plan

- **Several printers on one bridge.** That's a firmware change: several BLE links,
  and routing each job to a printer. Not needed for a shared print table.
- **Self-service stations sharing a bridge** (§3).
- **Priority between counters.** First come, first served (§4).
- **Storing the station on the item.** The SKU already carries it for every item a
  tag is printed for (§6).

---

## 10. Testing

**Unit:**
- Binding rules:
  - a free bridge binds;
  - a second staffed station shares the bridge;
  - a self-service station is refused a shared bridge;
  - a staffed station is refused a bridge that serves a self-service one;
  - removing the attendant from a station that shares its bridge is refused.
- Claim:
  - takes jobs from every station the bridge serves;
  - two batches queued a moment apart print whole, in queue order;
  - an enqueue at any station wakes a held claim;
  - the abandon sweep and the outstanding-ack check cover every station;
  - `stationIds` lists them all.
- `stationCodeOf`:
  - reads `SS26-A-0001` as `A`;
  - `SS26-0001` and `10042` give none;
  - it round-trips with `formatSku` for every code.
- Renderer:
  - the letter appears on both tiers;
  - a tag whose SKU has no code draws none;
  - the barcode's width is unchanged;
  - there's a golden fixture per stock.
- Responses: joined names, and the added lists, for a bridge with one station and
  one with several.

**Smoke** (`smoke-shared-bridge.mjs`), over real HTTP:
- two staffed stations bound to one bridge;
- a batch queued at each;
- one claim returns both, each batch whole, in order;
- acks settle both;
- binding a self-service station to that bridge is refused;
- removing an attendant while the bridge is shared is refused.

**By hand:** one bridge and printer, two iPads without printers of their own.
Save items at both counters in quick succession, and confirm the tags come out in
batches with the right letter on each.

---

## 11. Order

1. `stationCodeOf` and the tag letter (§6), server side. It stands on its own and
   is useful with one station per bridge too. Handoff to the iPad for the port.
2. The schema change and binding rules (§3), with the web Stations tab (§7).
3. The claim across stations (§4).
4. Everywhere a bridge names its station (§5), and the remaining web pages (§7).
5. Notes to the iPad and firmware sides.

Steps 2 and 3 ship together: a bridge bound to two stations before the claim
reads both would print for only one of them.

**Deploy:** the migration drops a unique index and changes no data.
patrolkit.io holds hand-set data, so whether to migrate in place or wipe is asked
at deploy time.

---

## 12. Open questions

- **The letter's size and position** on each stock (§6), to be settled on a
  printed sample.
- **`stationId` for a shared bridge:** it's the first by name (§4). If the
  firmware console should show something more useful, it can read `stationIds`.
