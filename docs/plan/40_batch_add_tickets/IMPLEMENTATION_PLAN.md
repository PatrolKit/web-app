# Plan 40: Batch add tickets to a seller, from a scanner

## Goal

Staff take in a stack of tagged gear for one seller, maybe 100 items, each with
a legacy ticket on it. On the Items page they pick the seller, scan every
ticket with a Bluetooth scanner, and press Save. Each ticket becomes that
seller's item, on sale in Square with no price or description: the same result
as the iPad's batch check-in of legacy tickets. They're priced afterwards with
Fast Edit Tickets.

To make that possible, the web connects to a scanner the way it connects to a
printer: from the nav bar.

## What's already here

- **The web can read scans.** `InateckScannerService.ts` connects to an Inateck
  BCST-23 over Web Bluetooth and decodes its barcodes (`listenForScans`), with
  the same decoder as the bridge firmware and the iPad. Today only the scanner
  test on the Hardware page uses it.
- **Scanners are registered per org** on the Hardware page (`/ski-swap/scanners`),
  each with a `bluetoothName`. A scanner held by a bridge isn't advertising, so
  a browser can't reach it, the same rule as printers.
- **Printers already work this way.** `PrinterContext` keeps each browser's
  chosen printer, reconnects it, and `PrinterStatusBar` at the foot of the
  sidebar connects, switches and disconnects.
- **Plan 38 issues tickets as accepted items** in one transaction, and pushes
  them to Square in the background in batches. The push picks up any accepted
  ticket that isn't in Square, whoever the seller is. The Items page's
  **Put tickets in Square (N)** resumes a push that stopped.
- **The iPad's batch check-in rules** (`LegacyTicketRules.swift`): a scan is
  refused when it's one of our tags, isn't all digits, is already in the batch,
  or is already an item in the swap (naming whose).

## Decisions

| # | Decision |
|---|---|
| D1 | **A scanner entry in the nav bar,** under the printer's, for staff with `ski_swap:manage` in a browser with Web Bluetooth. It shows the chosen scanner and whether it's connected; its menu connects, switches to another of the org's scanners, disconnects, and shows the last code read, to test it. Scanners on a bridge aren't offered. The choice is remembered per browser, as the printer's is. |
| D2 | **A scanner context** holds the connection for the whole app, so it survives moving between pages. A screen that wants scans subscribes while it's open; scans with no screen listening only update "last read". |
| D3 | **"Batch add to seller" in the Items page's Actions,** with the same visibility as Fast Edit Tickets: the swap takes legacy tickets, and the user has `ski_swap:manage`. |
| D4 | **Any seller** (individuals and shops). A shop's issued tickets (Plan 38) already exist, so scanning one says whose it is. |
| D5 | **Step one: the seller.** The popover opens on a search box over the org's sellers (name, email or phone), and picking one starts the session. |
| D6 | **Step two: scanning.** <br>• **Disconnected:** a prominent red banner, "Scanner not connected", with **Connect scanner**. Scans can't be taken, but the list so far is kept. <br>• **Connected:** a prominent "Start scanning" with a scanner icon. <br>• **After the first scan:** the last ticket number, large; the count, large ("42 tickets"); and the list, newest first, each with a remove button for a mis-scan. <br>• **Below the list:** a small number box, for a ticket whose barcode won't read. Typed numbers go through the same checks. |
| D7 | **Each scan is checked at once, and a bad one is refused on the spot,** as on the iPad. It never enters the list. A prominent red message gives the headline and what to do, and a short error tone plays; a good scan is silent. Refused when: <br>• **one of our tags** (a minted SKU): "That's a PatrolKit tag, not a legacy ticket"; <br>• **not all digits:** "Not a ticket number"; <br>• **already in this batch:** "Already in this batch"; <br>• **already an item in this swap:** "Ticket 67169 belongs to Stowe Sports." The server answers this one (D9). |
| D8 | **Save or Abort.** **Save (42)** adds them all in one request. **Abort** with tickets scanned asks first ("Discard 42 scanned tickets?"), as does leaving the page. |
| D9 | **A light check per scan:** `GET …/items/ticket-check?sku=67169` answers free, or taken and by whom. It reads our rows only, with no Square call and no item payload. |
| D10 | **Saving creates them all at once,** as Plan 38's issuing does: <br>• each ticket becomes an item named `Item #<number>`, with no price, category or description; <br>• the chosen seller, quantity 1, its tag already on the goods (`hasPrintedTag`), and no tag printed; <br>• accepted by whoever saved, in one transaction; <br>• then put in Square by Plan 38's background batch push. |
| D11 | **The server checks again when saving,** and refuses the whole batch if any ticket was taken in the meantime, naming each ("Ticket 67169 belongs to Stowe Sports"). The popover marks those rows in red to remove, then Save works. An idempotency key makes a retried Save safe. |
| D12 | **After saving:** "Added 42 tickets to Dana Reyes", then Square's progress ("Putting tickets in Square: 30 of 42") until it's done, and **Done**. If the push stops, **Put tickets in Square** on the Items page finishes it. |

## Server

- **`IssuedTicketService`:** the part of `issue` that creates the items moves into
  `addTickets(orgId, swapId, sellerId, numbers, actorId)`. Issuing a range calls
  it, after its own checks (business seller, a range). Batch add calls it with
  any seller and the scanned numbers. Both start the background push.
- **`GET …/swaps/:swapId/items/ticket-check?sku=`** (`ski_swap:manage`):
  - answers `{ free: true }`, or `{ free: false, holder }`;
  - refuses a SKU that isn't a ticket number, with the same sentence the
    popover shows.
- **`POST …/swaps/:swapId/items/batch-tickets`** with `{ sellerId, tickets }` (`ski_swap:manage`):
  - **Refuses:** a swap that takes no legacy tickets; a seller not in the org;
    an empty list; a number that isn't a ticket; a repeat within the list; any
    ticket already an item (`409 TICKET_TAKEN`, listing each with its holder).
  - **Answers** `{ created }`.
  - **Takes** an `idempotency-key`.

## Web

- **`ScannerContext`**, beside `PrinterContext`:
  - the org's scanners, the chosen one per browser, connect, reconnect when the
    browser allows it, switch and disconnect;
  - `subscribe(onScan)`, and `lastScan`.
- **`ScannerStatusBar`** in `AppShell`, under `PrinterStatusBar`, with the same
  look and failure messages ("No scanner picked. If nothing was listed, the
  scanner is asleep, out of range, or held by a bridge").
- **`BatchAddTicketsModal`:**
  - the seller step;
  - the scanning step: banners, last ticket, count, list with remove, number
    box, Abort and Save;
  - the result and Square progress.
  - The error tone is a short Web Audio beep, made in the page, no file.
- **Items page:** the Actions entry (D3), and refreshing the list and counts
  after a save.
- **The scanner test** on the Hardware page moves onto `ScannerContext`, so the
  two don't fight over one connection.

## iPad

- No change.

## Rollout

- **No migration.**
- **Nothing deploys while a customer's swap is running** without the user's say-so.

## Tests

- **Server:**
  - `addTickets` writing the D10 fields, shared by issuing and batch add;
  - batch add's refusals (D11), including a ticket taken since it was scanned,
    and an individual seller allowed;
  - `ticket-check`'s answers, with no Square call;
  - an idempotent retry creating nothing twice.
- **Smoke** (`smoke-batch-tickets.mjs`, in the smoke org):
  - a batch of 100 for an individual seller: items with the right fields;
  - a repeat refused, a taken ticket refused naming its holder, and nothing created;
  - a retried Save with the same key.
- **Web:**
  - the scan checks in D7, in order;
  - the count, last ticket and list;
  - remove;
  - typed numbers;
  - Abort's confirmation;
  - the disconnected banner.
- **By hand, with a BCST-23:**
  - connect from the nav bar, switch, disconnect;
  - scan 100 tickets in a row at speed, checking none is lost or doubled;
  - pull the scanner's power mid-batch, then reconnect and carry on.
