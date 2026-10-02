# Plan 31 — Printed labels beside legacy tickets

This season's swap runs almost entirely on legacy tickets. One small shop wants to
beta-test printed labels: it uploads its inventory as a spreadsheet and prints labels
from the web. Everything else, including the staff iPads at check-in, stays on tickets
exactly as it is now.

Today that combination is impossible in three places:
- **One swap setting** decides "tickets only" for both the counter and the web.
- **A business seller has either a printer or issued tickets,** never both. The server
  refuses the combination from either direction.
- **Every spreadsheet upload is a ticket upload:** each row must carry a ticket number
  from the seller's issued ranges.

This plan separates the setting, lets a seller have both, and lets an upload generate
SKUs for rows that have no ticket.

---

## 1. Decisions

| | |
|---|---|
| **Two settings** | "Legacy tickets only" becomes two: **Staff check-in** and **Web**. Staff check-in keeps the existing field, so the iPad needs no change. Web is new and starts **off** for every swap. §2 |
| **Ticket source** | A business seller can have issued tickets **and** a printer. §3 |
| **Seller screen** | The edit-seller screen picks a swap from a dropdown. It shows **Issued Tickets** when that swap takes legacy tickets, and **Printer** when that swap's Web setting is off. §4 |
| **Uploads** | With Web on, every row needs a ticket from the seller's ranges, as now. With Web off, a **"Generate SKUs as needed"** switch, default off, gives a generated SKU to rows without a ticket. The same rules apply to a seller uploading and to staff uploading for them. §5 |
| **Hand entry** | With Web off, the ticket number is optional: clearing it generates a SKU. With Web on, every hand-entered item is a ticket, and a seller with no ranges can't add one. §6 |
| **Printing** | An item with a generated SKU gets the web's Label/Reprint button; an item on a ticket doesn't. Per item, not per seller. No bulk print. §7 |

---

## 2. The swap settings

**Schema.** `SkiSwap` gains one column:

```prisma
/// Every item entered on the web — by a seller or by staff for one, by hand or
/// by upload — must be a legacy ticket (Plan 31). Off, a business seller may
/// also print labels with generated SKUs. Meaningless without
/// `legacyTicketsEnabled`, and cleared with it.
webLegacyTicketsOnly Boolean @default(false)
```

**The existing field keeps its meaning.** `legacyTicketsOnly` is the **Staff check-in**
setting. It's what the iPad reads (`TicketSource`), and what decides that an iPad-drawn
tag at a bridge is refused with `TAGS_OFF`. It also still gates
`printLegacyHelperLabels`. The column isn't renamed, so the iPad needs no change.

**Rules,** in `SwapService.update`, as for the existing pair:
- Turning `legacyTicketsEnabled` off clears both "only" settings.
- Turning on either "only" setting requires `legacyTicketsEnabled`.

**Migration.** The new column is additive, with every existing swap starting at false:
web uploads and hand entry behave as before until someone turns it on. Whether to migrate
in place or wipe is asked at deploy time.

**Web: Swaps page.** The settings nest, each level shown only while the one above is on:

- **Accept legacy tickets** (toggle)
  - **Legacy tickets only** (a heading, not a control)
    - **Staff Check-In** (toggle): `legacyTicketsOnly`
      - **Print helper labels** (toggle), as now; it applies to the staff iPad
    - **Web UI** (toggle): `webLegacyTicketsOnly`

Turning **Accept legacy tickets** off hides everything under it and clears both toggles,
matching the server's rule.

The swap list's badge says which applies: "Tickets only (check-in)", "Tickets only
(web)", or "Tickets only" when both are on.

**Contracts.** `SwapResponse`, `CreateSwap` and `UpdateSwap` gain
`webLegacyTicketsOnly`. The iPad ignores it.

---

## 3. A seller may have both

**Server.** Remove the exclusivity in both directions:
- `PrinterService.patch`: assigning a printer to a seller with ranges is no longer
  refused (`assertNoRanges`).
- `LegacyTicketService`: issuing a range to a seller with a printer is no longer refused
  ("This seller has a printer…").

Both helpers go, along with their tests, rewritten to assert the combination is allowed.

**No per-swap printer.** A printer stays assigned to a seller across swaps; the swap's Web
setting decides whether it's used (§6, §7). The server doesn't refuse an assignment
because of one swap's setting: a printer the shop owns is still theirs.

---

## 4. The edit-seller screen

`SellerTicketSource` stops being two tabs and becomes two sections, under a **swap
dropdown**.

**The dropdown.**
- Lists the org's swaps, newest first, starting on the swap selected in the Ski Swap
  layout.
- Ranges belong to a swap, so the Issued Tickets section follows it.
- The printer doesn't belong to a swap, but whether this swap lets the web use one does.

**Issued Tickets.**
- Shown when the chosen swap has `legacyTicketsEnabled`, or the seller already holds
  ranges in it. A block a shop holds paper for mustn't vanish when someone flips the
  setting.
- Otherwise the same as today's tickets tab: list, add and remove ranges.

**Printer.**
- Shown when the chosen swap's Web setting is off, or a printer is already assigned.
- Otherwise the same as today's printer tab: assign or unassign.
- When the Web setting is on and a printer is assigned, it's listed with a note:
  "Not used in *Swap*: the web takes legacy tickets only." A Remove button is offered,
  and no Assign.

**Copy.** The component's comment and help text drop "alternatives". A seller may now
have both: tickets for what they've tagged by hand, labels for the rest.

---

## 5. Uploads

Both upload paths share one rule set:
- the seller's own (`POST seller/me/items/import`);
- staff uploading for a seller (`POST …/items/import` for a seller, via
  `ProxyItemImportModal`).

**The request** gains `generateSkus: boolean`, defaulting to false.

| Web setting | `generateSkus` | A row with a ticket | A row without one |
|---|---|---|---|
| On | (refused if sent true) | must be in the seller's ranges, as now | error: "needs a ticket number" |
| Off | false | must be in the seller's ranges | error: "needs a ticket number, or turn on Generate SKUs as needed" |
| Off | true | must be in the seller's ranges | gets a generated SKU |

**Checked as today:** the whole file is checked before anything is written, and the file
is refused if any row fails, with every failing row listed.

- **A seller with no ranges and the switch off:** every row fails, with a single
  sentence saying why at the top.
- **A seller with no ranges and the switch on:** an upload of blank-ticket rows works.
- **A generated-SKU row** is created like a hand-entered item from that seller:
  - a SKU from the swap's sequence, without a station letter, e.g. `SS26-0042`;
  - `hasPrintedTag: false`;
  - waiting for staff to accept it (`awaitsConsignment`) when the seller uploaded it,
    and accepted at once when staff did, as for ticket rows today.
- **A ticket row** is unchanged: marked printed, and named verbatim.

**`LegacyTicketService.checkImportRows`** takes the seller's ranges, which may be empty,
and the `generateSkus` flag. It returns, per row, whether it's a ticket or a generated
SKU. `ItemService.importTicketItems`, renamed `importItems`, creates each row
accordingly.

**As built:**
- **The `sku` column is optional.** A file without it is all blank rows, so it
  imports with the switch on, and each row says it needs a ticket with the switch
  off.
- **A swap that doesn't accept legacy tickets** still refuses a staff upload
  without the switch, as it always did. With the switch on, its generated rows
  import and its ticket rows fail. A seller's own upload never checked
  acceptance, and still doesn't.
- **The seller's ticket state** (`GET seller/me/ticket-state`) reports the swap's
  Web setting as `webTicketsOnly`, so My Items knows it without a second request.

**Who can upload.**
- **The seller's own:** today only a seller with ranges sees "Import items from a file".
  Now any business seller sees it, unless the swap's Web setting is on and the seller has
  no ranges, when it couldn't succeed.
- **Staff for a seller:** `GET ticket-sellers` lists sellers with ranges in the swap. When
  the swap's Web setting is off it lists every business seller, and each entry says
  whether they hold ranges.

**The upload screen.**
- With the Web setting off, a switch: **Generate SKUs as needed**, default off. Under it:
  "Rows without a ticket number get a new SKU, and a label to print."
- The CSV template and help text say the ticket column may be left blank when the switch
  is on.

---

## 6. Hand entry on My Items

`SellerSelfService.createItem` and the add-item form.

**Web setting on.**
- Every item is a ticket.
- **Server:** a seller with no ranges is refused: "This swap takes legacy tickets only.
  Ask the organizer for a block of tickets." A seller with ranges works as today: a
  ticket number, or the next one suggested.
- **Form:** as today for a ticket seller. For a seller without ranges, the add button is
  replaced by that sentence.

**Web setting off.**
- **Seller without ranges:** as today; a generated SKU every time.
- **Seller with ranges:** the ticket field is filled with the next ticket as now, and
  may be cleared.
  - **Cleared:** the item gets a generated SKU and a label to print.
  - **Server:** the create gains `generateSku: true`, sent when the field is empty. It's
    needed because today an omitted `sku` means "take the next ticket", and that stays
    true for older clients.
  - `generateSku: true` is refused when the Web setting is on.
  - **Form hint:** "Leave blank to print a label instead."

**`ItemService.create` / SKU minting** is unchanged; this only decides whether a ticket
is used.

---

## 7. Printing labels

**The items list** (`SwapItemsPanel`, on My Items and the staff Items page) decides per
item:
- **`item.legacyTicket` true:** no Label or Reprint button, as for every ticket today.
- **Otherwise:** Label, or Reprint once `hasPrintedTag`.

Today the button is also hidden for every item of a seller on tickets (`tickets ||
item.legacyTicket`). That `tickets ||` goes, so a mixed seller's generated items can be
printed.

**What isn't needed:**
- The print path itself: `printItem`, the server's renderer, `hasPrintedTag` after
  printing.
- The M221 / 62 × 100 path, which now works.

**The seller's printer** is the one assigned to them (§4), found by the web's printer
pool as now.

---

## 8. The iPad

Nothing changes for the iPad: it reads `legacyTicketsOnly`, which keeps its meaning.

A short note to the iOS side says:
- `webLegacyTicketsOnly` exists, and is the web's;
- a business seller may now hold ranges and a printer;
- generated-SKU items can belong to a seller with ranges. At the counter they scan as
  ordinary Code-128 tags.

**Worth testing on hardware before the beta:** an iPad in a check-in-tickets-only swap
accepting the shop's generated-SKU items by scanning their labels.

---

## 9. Not in this plan

- **Bulk "print all unprinted"** (decided against). Labels print one at a time.
- **A per-swap printer assignment.** The printer stays the seller's.
- **Generated SKUs at the staff counter** while check-in is tickets-only. That's the
  iPad's setting, and unchanged.
- **Changing an item between ticket and generated SKU** after it's created.

---

## 10. Testing

**Unit:**
- **Swap settings:**
  - Web defaults off;
  - clearing `legacyTicketsEnabled` clears both "only" settings;
  - turning either on without acceptance is refused;
  - helper labels follow the Staff check-in setting only.
- **Exclusivity removed:**
  - a seller with ranges is assigned a printer;
  - a seller with a printer is issued a range.
- **Upload rules,** every row of §5's table, for both paths:
  - with ranges and without;
  - a mixed file;
  - the whole file refused on one bad row;
  - a generated row's SKU, `hasPrintedTag: false`, and consignment;
  - `generateSkus` refused with Web on.
- **Hand entry:**
  - with Web on, a seller without ranges is refused, and `generateSku` is refused;
  - with Web off, a ticket seller's `generateSku` gets a generated SKU, and an omitted
    `sku` still takes the next ticket.
- **Staff upload's seller list** follows the Web setting.

**Web:** checked in the browser.
- **Swaps page:** the nested toggles, each shown only under its parent, and the badge.
- **Edit seller:** the swap dropdown switches both sections, the printer note shows with
  Web on, and both sections show at once.
- **Upload:** the switch shows only with Web off; a file of blank tickets fails without
  it and imports with it.
- **My Items:** a cleared ticket field makes a printable item; the Label button shows on
  generated items and not on tickets.

**Smoke** (`smoke-mixed-tickets.mjs`), over real HTTP:
- a swap with check-in tickets-only on and Web off;
- a shop with a range and a printer;
- an upload with two ticket rows and two blank rows, refused with the switch off,
  accepted with it on: two tickets marked printed, two generated SKUs not;
- a hand-entered item with a cleared ticket gets a generated SKU;
- turning Web on refuses `generateSkus`, `generateSku`, and a no-range seller's hand
  entry;
- the iPad's `/swaps` still shows `legacyTicketsOnly: true`.

**By hand, before the beta:**
- Upload the shop's real spreadsheet with the switch on.
- Print its labels from the web on the M221.
- Accept a few at the counter by scanning them on an iPad.

---

## 11. Order

1. `webLegacyTicketsOnly`: schema, swap rules, contracts, Swaps page (§2).
2. Exclusivity removed, and the edit-seller screen with its swap dropdown (§3, §4).
3. Upload rules and the switch, for both paths (§5).
4. Hand entry (§6), and the per-item Label button (§7).
5. The iOS note (§8).

Steps 1–4 ship together: each relies on the Web setting existing, and step 2 alone would
let a seller hold both with nothing yet using it.

---

## 12. Open questions

- **The badge wording** on the Swaps list (§2).
