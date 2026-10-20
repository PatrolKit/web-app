# Plan 53: Comp an item

## Goal

Let an admin mark an item **sold** when Square has no trace of it selling, so its seller is paid. A comp is a deliberate, recorded exception:

- it says who comped the item, when and why;
- from then on the item counts as sold everywhere PatrolKit counts sales: stock, pickup, Items, reports, Payouts;
- the seller is paid the item's list price, less the patrol's share, like any sale;
- it can be undone until the seller is paid for it.

Today "sold" comes from Square only. Sales check can put a Square sale on the right item, but an item that sold with no Square sale at all (cash taken outside the register, a sale nobody can find, an item lost or damaged that the patrol makes good) has no way to be paid. The first five are tickets 75367, 73823, 75042, 74125 and 74255 from the fall 2026 swap.

## Decisions

| # | Decision |
|---|---|
| D1 | **A comp is a sale PatrolKit records itself.** One row per comped unit, read alongside Square's sales wherever sales are attributed to items, exactly as Sales check decisions and exchanges are today (Plan 48 D5, Plan 49 D12). Nothing reads it as Square's: it has no order, no payment and no receipt. |
| D2 | **Only an item with nothing to show for it.** An item can be comped while it's consigned, not deleted, not picked up, and has units that Square shows unsold. A two-unit item can have one unit comped. An item Square already shows sold is refused: put the sale on the right ticket in Sales check instead. |
| D3 | **What a comp records:** the item; its list price when comped; a reason, one of *Paid outside Square* (cash or check the register never saw), *Sold, no sale found* (the item left with a buyer and the sale can't be found), *Lost or damaged* (the patrol makes good), or *Other*; a note, required; who comped it and when. |
| D4 | **Always the list price.** A comp pays the item's list price, whatever the reason: there's no other amount to choose. An unpriced item is priced first, in the comp dialog, and that becomes its list price in PatrolKit and Square, as Sales check's "Accept with price" does. |
| D5 | **Square's stock goes to zero** with the comp, as a Sales check credit does (Plan 48 D6), so the register can't sell it again. If it is rung up anyway, the item is sold twice and Sales check flags it (D8). |
| D6 | **How it reads everywhere.** The comp is a sale line of the item, quantity 1, at its list price, with **nothing collected**, sold when it was comped:<br>• **Customers see "Sold"**, never "Comped": the public item status lookup and the seller's website show a comped item exactly as any sold one.<br>• **Patrol staff see "Comped"**: the Items page, Adjustments → Comps, Payouts and the staff iPad say so, with the reason to hand. Stock, pickup and Catalog check treat it as sold: its Square stock is 0 (D5).<br>• **Payouts:** owed like any sale (Plan 52). The seller's card shows the item with "Comp: reason" where a receipt would be, and no "View in Square". The comp freezes with the line when money moves.<br>• **Reports:** counted as sold; nothing collected; the dashboard's money totals don't count it.<br>• **Discounts and the paid-price check** leave comps out: nothing collected is the point, not a discount or a different price.<br>• **Exchanges** refuse a comped unit, either way. |
| D7 | **Undo**, by an admin, with a note: the comp stops counting at once, and Square's stock goes back to what's left unsold. Refused once the comped unit is in a payout line whose money moved (Plan 52 D6): a change after payment is settled by hand there (Plan 52 D9). |
| D8 | **A comped item rung up in Square later** is sold twice, which Sales check already flags (scanned twice, or sold twice across sales), with the comp listed among its sales. Undoing the comp settles it, and the Square sale stands. |
| D9 | **Where it's done:** "+ Comp Item" on Adjustments → Comps (D11), **Ski Swap admins only** (`ski_swap:admin`). A dialog: a price for an unpriced item (D4), the reason, a note, and a confirmation naming the seller and what they'll be paid. "Undo comp…" on its row in Comps, for the same admins. |
| D10 | **Seen, for the record.** Adjustments → Comps lists the swap's comps (item, seller, list price, reason, note, who, when), with the total: money the patrol owes sellers that Square never took. Undone comps stay listed, marked undone, with who and why. The Payouts page links to it with one line ("4 comped items, $260.00"). Every comp and undo is audited. |
| D11 | **A new "Adjustments" tab** holds what changes how the swap's sales count, with two sub-tabs, as Reports has Sales check and Catalog check:<br>• **Exchanges:** today's Exchanges tab, moved here unchanged.<br>• **Comps:** D10.<br>The Ski Swap tabs start **Dashboard, Items, Adjustments, Reports, Payouts**, then the rest as they are. |

## Server

### Schema (migration `…_swap_comps`, additive)

**New `SwapComp`:**
- `id`, `orgId`, `swapId`, `itemId`;
- `units Int @default(1)`;
- `priceCents Int`: the item's list price when comped, per unit (D4), kept so the record says what was owed;
- `reason VarChar(12)`: `OUTSIDE` | `NOT_FOUND` | `LOST` | `OTHER`;
- `note Text`;
- `compedBy`, `compedAt`;
- `liveKey VarChar(80)? @unique`: the comp's id while it counts, null once undone, as decisions and exchanges do;
- `undoneBy`, `undoneAt`, `undoNote`;
- indexes on `(swapId, liveKey)` and `(itemId)`.

### Reading sales (`sales-check.ts`)

- `attributeSales(lines, decisions, exchanges, ours, variationOfItem, comps = [])` adds each live comp as a sale line:
  - `orderId` `comp:<id>`, `lineUid` `comp`;
  - the item's variation;
  - `quantity` = units, `unitPriceCents` = the list price, `collectedCents` 0, `refundedQuantity` 0;
  - `soldAt` = when comped, `paymentId` null, `name` "Comp".
- `isComp(line)` says so, for the places that treat it differently (D6).
- One loader, `salesAdjustments(prisma, swapId)`, reads the live decisions, exchanges and comps together. The nine callers of `attributeSales` use it, so none of them can forget comps:
  - `ItemBreakdownService.sales`;
  - Payouts;
  - Sales check (list, credit, paid prices);
  - Exchanges;
  - item export;
  - `classify` and `oversoldOf`.
- `paidPriceCheck` and `discountsOf` skip comp lines (D6).

### Service and routes (`swap-comp.service.ts`, on the item controller)

- `POST swaps/:swapId/items/:itemId/comp { priceCents?, units?, reason, note }` (`ski_swap:admin`):
  - checks D2 against a fresh read of Square;
  - `priceCents` only for an unpriced item, which is priced through the item edit first (D4); refused for a priced one;
  - writes the comp, sets Square's stock (D5), audits, and drops the cached sales read.
- `POST swaps/:swapId/comps/:compId/undo { note }` (`ski_swap:admin`):
  - refused once paid (D7);
  - restores Square's stock, audits, and drops the cached read.
- `GET swaps/:swapId/comps`: the live comps, for the Payouts page (D10), each with item, seller, list price, reason and who.
- **Staff** item responses (web and iPad) gain `comp: { id, priceCents, reason, note, compedAt, compedBy } | null` for a live comp, so they can say "Comped".
- **Public** responses (the item status lookup, the seller's website) carry no `comp`: a comped item is sold, as any other (D6). A test pins it.

### Payouts (Plan 52)

- A frozen line item from a comp keeps `squareOrderId` `comp:<id>` with no payment.
- The run's item view returns `comp: { reason, note }` instead of a receipt and sale link.
- The payouts summary gains `comps`.

## Web

- **Navigation (D11):**
  - `AdjustmentsLayout`, like `ReportsLayout`: sub-tabs **Exchanges** (index) and **Comps**, under `ski-swap/adjustments`;
  - `ExchangesPage` moves under it as is, at `ski-swap/adjustments/exchanges`; the old address goes;
  - the tab order becomes Dashboard, Items, Adjustments, Reports, Payouts, with seller-only tabs and the rest after the divider unchanged; the disabled placeholders shown before a swap is chosen follow the same order.
- **Adjustments → Comps:** the comps table (D10) with the total, "Comp an item…" (an item search, then the comp dialog), and "Undo comp…" per row.
- **Items page:** no comp actions; comping and undoing are on Adjustments → Comps only (D9). A "Comped" status, with its reason and note on hover.
- **Comp dialog:**
  - the list price, shown; for an unpriced item, a price to enter, which becomes its list price;
  - the reason, as four choices;
  - the note, required;
  - the confirmation: "Comp 74125 for $60.00? Mary Carocci will be paid $48.00 for it. Square's stock goes to 0."
- **The iPad (sibling repo):** a "Comped" state wherever staff see an item's status, from the item contract's new `comp` field. A handoff once the server is live.
- **Payouts:**
  - "Comped" in the seller card's receipt column;
  - one line on the Payouts page, "N comped items, $X", linking to Adjustments → Comps (D10).

## Tests

- **Pure (`attributeSales`):**
  - a comp reads as a sale of its item, with nothing collected;
  - an undone comp doesn't count;
  - a comp and a Square sale of the same one-unit ticket are sold twice;
  - comps stay out of discounts and the paid-price check.
- **Service:**
  - refused for an item Square shows sold, a picked-up or deleted item, or more units than are unsold;
  - refused for anyone but a Ski Swap admin;
  - always the list price: a price is refused for a priced item, and an unpriced item is priced first;
  - public responses say sold and nothing more;
  - undo is refused once paid.
- **Web:** the tab order.
- **Smoke** (stubbed Square):
  - comp an item, then see it sold on Items, gone from pickup, and owed in a payout run with "Comp" on the card;
  - undo, and it's back.

## Rollout

- Additive migration; deploy as usual.
- The five tickets are comped by staff from Adjustments → Comps once it's live, each with its reason and note. 74125, 75042 and 75367 may turn out to have a Square sale under another ticket (the extra $60, $10 and $7 lines). If so, those are put on the right ticket in Sales check instead, and comps are only for what has no sale.

## Not in this plan

- A Sales check action to move a sale line from one ticket to another (the extra lines on scanned-twice tickets): a separate plan.
- Comping from the iPad.
- Comping several items at once.
