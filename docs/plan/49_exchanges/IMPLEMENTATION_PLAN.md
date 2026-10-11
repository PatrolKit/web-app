# Plan 49: Exchanges

**Status:** planned 2026-10-10. Not started.

## Goal

An **Exchanges** tab in the ski swap, beside Payouts and Reports: the home for a customer handing back an item they bought and leaving with another. Staff record an exchange at the counter as it happens, and the tab lists every exchange so far, which staff can cancel.

Once recorded, PatrolKit counts the sale on the item that left the building, and Square's stock matches what's on the floor:

- **The item that came back** is for sale again. Its seller isn't paid for it.
- **The item that went out** is sold. Its seller is paid its ticket price, whatever the customer paid.

Square's own sale record isn't changed, since Square can't do that without Square Plus. The exchange is recorded alongside it.

## Why

On 2026-10-09 a customer bought Little Mountain's 87344 (Leki 100cm poles, $19.00) on receipt #Gq00, and came back for 87339, a different size at the same price. Square only allows exchanges with Square Plus. A refund and a new sale would need the customer's card again. So today:

- **Square and PatrolKit both say the wrong ticket sold.** 87344 shows as sold although it's back on the floor, and 87339 is for sale although it left with the customer.
- **The register could sell 87339 again.** If it does, the payouts safeguard holds the second sale, and its seller isn't paid until someone works out why.
- **The fix depends on someone remembering.** Nothing records the exchange until it shows up in the books, if it ever does.

Exchanges at different prices happen too. No money changes hands in an exchange: the seller whose item went out is owed its ticket price, and the patrol absorbs the difference (or keeps it, when the item going out costs less). A difference big enough to matter isn't recorded as an exchange; staff refund the sale and ring up the new item in Square instead.

## What's already here

- **Sales and who they count for:**
  - Every reader goes through the same chain: Square sale lines (`listSales`, refunds subtracted), then Sales check's decisions (`applyDecisions`: a `CREDIT` re-points a line onto one of our items, a `NOT_SWAP` drops it).
  - The readers are the dashboard (`ItemBreakdownService.sales`), payouts (`payout-run.service.ts`), Sales check (`classify`, `oversold`) and Catalog check's stock check (`soldUnits`).
  - `applyDecisions` only re-points lines that aren't already on one of our items. An exchange is exactly that case: a sale on one of our items that belongs to another.
- **Sold or for sale:** the Items page, seller pages, the public status page and the register read Square's stock. Sales don't decide it.
- **Stock writes:** `getInventoryCounts` and `setInventoryPhysicalCount`. Since `91c9e01`, an item edit moves stock by the change only; this plan follows the same read-then-set pattern.
- **Payouts:**
  - A run pays each sold item's **listed price** (`build-run.ts`). What the register took is carried for reporting only.
  - Since `19d9801` a run pays a ticket at most its checked-in units, and holds the rest.
  - The discount report (`discountsOf`) lists any line where the listed price is above what was collected.
- **Receipt numbers** are a payment id's first four characters (`receiptOf`, `cf050b5`). They're what staff search for at the register.
- **Every ticket is one item** (quantity 1). This plan exchanges one unit at a time.
- **Permissions:** `ski_swap:report` (read), `ski_swap:manage` (edit items), `ski_swap:admin`.

## Decisions

| | Decision |
|---|---|
| D1 | A new **Exchanges** tab, swap-scoped like Payouts. Anyone with `ski_swap:report` sees it; only a ski swap admin (`ski_swap:admin`) can record, edit or cancel an exchange. |
| D2 | Recorded **at the counter, on the web** (any browser). The staff iPad app comes later and needs nothing from this plan to keep working. |
| D3 | An exchange belongs to **one Square sale line** of one of our items (the item coming back), found by **receipt number** or by **the ticket coming back**. One unit. |
| D4 | From then on, every reader counts that sale on **the item going out**. Square's sale record is untouched. |
| D5 | **Square's stock moves when the exchange is recorded:** the item coming back goes up by 1, and the item going out goes down by 1. |
| D6 | **Different prices are allowed, and no money changes hands.** The seller of the item going out is paid its listed price; the seller of the item coming back is paid nothing for it. The patrol absorbs or keeps the difference. A big difference is handled in Square instead, as a refund and a new sale, not as an exchange. |
| D7 | **An unpriced item going out is priced when the exchange is recorded,** since its seller has to be paid something. |
| D8 | **Different sellers are allowed, with a warning:** the sale, and the payout, move to the other seller. |
| D9 | **Only a sound exchange is accepted.** The item coming back must be counted as sold by that sale line, and the item going out must be for sale (this swap's, live, unsold, in stock). Both are re-checked against Square when the exchange is saved. |
| D10 | **A second exchange of the same sale chains onto the first.** It supersedes the earlier one, and cancelling it brings the earlier one back. |
| D11 | **Cancelling keeps the record.** It's marked cancelled, with who, when and why, and the stock move is reversed. It's refused if the item that came back has sold again since. Nothing is ever hard-deleted. |
| D12 | **Payouts follow the exchange from the next run built.** A closed run that already paid the item coming back isn't changed: recording the exchange warns, and the difference is settled by hand. No run has been built yet this swap. |
| D13 | **Sellers see nothing new.** Their pages follow Square's stock as now: the item that came back is for sale again, and the item that went out is sold. |

### D3: Finding the sale

Staff type either the receipt number (**Gq00**, as printed) or the ticket coming back (**87344**):

- **By receipt:** every line of that sale that PatrolKit counts for one of this swap's items, after Sales check's decisions and earlier exchanges.
- **By ticket:** every sale that ticket is counted on. Normally there's one; the "Scanned twice" and "sold more than once" cases have more.

Staff pick the line, so a six-item sale like Gq00 needs no guessing. A line already exchanged shows what it was exchanged for, and picking it starts a chained exchange (D10).

### D4: How the sale moves

A new step goes after `applyDecisions`: `applyExchanges(lines, exchanges)`.
- A line with a live exchange gets the variation of the item going out.
- A chain resolves to the latest live link.

Every reader (dashboard, payouts, Sales check, Catalog check) goes through one function, `attributeSales(lines, decisions, exchanges, …)`, so no reader can skip a step.

### D5: Stock

The same pattern as the item edit fix: read Square's count, set it to count ± 1, never below 0.
- **Returned item:** +1, back on the floor.
- **Item going out:** −1, sold.

The exchange is saved first and the stock moved after:
- **If Square can't be written:** the exchange is kept and flagged "Square's stock not updated", with **Retry** on its row. The books are right either way; only the register and the for-sale state wait.
- **Catalog check:** its stock check covers anything left behind, since its expected stock already goes through `attributeSales`.

### D6: Prices and the difference

- **The record:** it keeps both listed prices as they were at the time, and the difference. Nothing is collected or refunded, so there's no receipt for it.
- **Payouts:** the run pays the listed price of the item going out, as for any sale. A higher-priced exchange shows a gap between listed and collected, so the discount report labels those lines "Exchange" instead of listing them as discounts.
- **Exchanges tab:** totals what the patrol absorbed (items going out that cost more) and kept (cost less).
- **The form:** when prices differ, it shows the difference, says the patrol absorbs or keeps it, and reminds staff that a big difference belongs in Square as a refund and a new sale.

### D10: Chains

If the customer brings 87339 back for 87341, staff look up receipt Gq00 or ticket 87339 and pick the same line. That records a new exchange from 87339 to 87341 that supersedes the first.
- **The row:** the line has one live exchange (`liveKey`), now the second.
- **The first exchange:** it shows as "superseded by …".
- **Stock:** 87339 +1, 87341 −1.
- **Cancelling:** only the latest link in a chain can be cancelled. Cancelling the second makes the first live again and reverses only the second's stock move.

## Data

A new table, additive:

```
SwapExchange
  id, swapId, orgId
  orderId, lineUid            -- the sale line exchanged (Square's)
  paymentId                   -- for the receipt number and links
  returnedItemId              -- the item coming back
  replacementItemId           -- the item going out
  returnedPriceCents          -- listed prices when recorded (null = unpriced)
  replacementPriceCents
  note
  stockSynced  Boolean        -- D5: false until both stock moves landed
  supersedesId                -- D10: the exchange this one replaced
  recordedBy, recordedAt
  cancelledBy, cancelledAt, cancelReason
  liveKey                     -- orderId:lineUid while live (unique per swap); null once superseded or cancelled
  @@unique([swapId, liveKey])
```

## Server

**`exchanges.service.ts`** and a controller under `orgs/:orgId/ski-swap/swaps/:swapId/exchanges`:

| Route | Permission | Does |
|---|---|---|
| `GET /` | report | every exchange, live and not, with item, seller, receipt and links |
| `GET /lookup?receipt=Gq00` or `?ticket=87344` | admin | the sale lines found (D3), each with its current item and any live exchange |
| `POST /` | admin | records one, with an idempotency key: re-checks D9 against a fresh read of Square, prices an unpriced item going out (D7, through the item edit), saves, then moves stock (D5) and audits |
| `PATCH /:id` | admin | edits the note. Anything else about an exchange is changed by cancelling it and recording it again. |
| `POST /:id/cancel` | admin | D11: refuses if the item that came back has sold since; reverses the stock; re-lives the exchange it superseded |
| `POST /:id/retry-stock` | admin | D5: tries the stock moves again |

**Changes elsewhere:**
- **`sales-check.ts`:** `attributeSales` and `applyExchanges`. `ItemBreakdownService.sales`, `PayoutRunService`, Sales check and Catalog check use them, and each forgets its cached read after a change.
- **`build-run.ts`:** `discountsOf` labels exchange lines (D6).
- **Audit actions:** `ski_swap.exchange.recorded`, `…cancelled`, `…stock_retried`.

**Refusals, in plain words:**
- "87339 is sold already: pick an item that's for sale."
- "That sale isn't counted on 87344 any more: look it up again."
- "87344 has sold again since the exchange, so cancelling would put two on the floor."

## Web

**Exchanges tab** (`ExchangesPage.tsx`):

1. **Record an exchange:** one panel, top to bottom.
   - **Find the sale:** a single box for "Receipt # or the ticket coming back", then a short list of the sale lines found (ticket, name, seller, price, receipt, time). Pick one.
   - **Pick the item going out:** an item search limited to items for sale. The card reuses Sales check's two-sided layout (`ReportCard`): **Coming back** on the left, **Going out** on the right.
   - **Warnings, inline:**
     - different seller ("The sale and its payout move from Little Mountain to Karen Beckwith");
     - different price: "The patrol absorbs $12.00. For a big difference, refund and re-ring it in Square instead.";
     - an unpriced item going out asks for its price;
     - a closed payout run that already paid the item coming back (D12).
   - **Note**, then **Record exchange**. The card turns into a green tombstone: "Recorded: 87344 back for sale; 87339 sold on receipt #Gq00."
2. **Exchanges so far:** cards, newest first, searchable by ticket, receipt or seller.
   - **Each card:** when, receipt, coming back → going out, sellers, prices, the difference absorbed or kept, who recorded it, and its note.
   - **Status:** live, superseded, cancelled, or "Square's stock not updated" with **Retry**.
   - **Cancel…** asks for a reason.
   - **Totals:** the difference the patrol absorbed and kept.

**Items page:** for an admin, a sold item's row gets **Exchange…**, which opens the tab with that ticket filled in.

**Who sees what:** anyone with `ski_swap:report` sees the list. Only an admin sees "Record an exchange", the note's **Edit**, **Cancel…** and **Retry**.

**Dashboard:** nothing new. Its numbers follow `attributeSales`.

## Tests

- **`applyExchanges`:** re-points one line, follows chains to the latest live link, ignores cancelled and superseded exchanges, and leaves other lines on the same receipt alone.
- **Every reader, from one fixture of the 87344 → 87339 case:**
  - **Dashboard and payouts:** the sale counts for 87339.
  - **Sales check:** sees no repeat sale.
  - **Catalog check:** expects 87344 at 1 and 87339 at 0.
- **Recording:**
  - refuses an item going out that isn't for sale;
  - refuses a line that has moved since lookup;
  - prices an unpriced item going out;
  - moves stock by one each way;
  - flags `stockSynced` false when Square refuses a write, and Retry fixes it;
  - is idempotent.
- **Prices:**
  - **Higher:** payouts pay the higher listed price, and the discount report labels it "Exchange", not a discount.
  - **Totals:** the tab's absorbed and kept differences add up.
- **Different sellers:** the payout moves.
- **Cancelling:**
  - reverses stock;
  - is refused when the item that came back has sold again;
  - a cancelled chain link re-lives the one it superseded.
- **Routes:** reading is `report`; every change (record, edit the note, cancel, retry) needs `ski_swap:admin`; reading changes nothing.
- **Web:** the lookup list, the warnings for each case, the two-sided card, and the list's states.

## Rollout

1. Build and test against the local Square stand-in, including a 6-line receipt like Gq00.
2. Ask before deploying: the migration is additive (one new table).
3. Record the first real exchange through the tab: receipt #Gq00, 87344 → 87339. Check that:
   - Square shows 87344 at 1 and 87339 at 0;
   - Sales check and Catalog check show nothing for either ticket;
   - a payout preview pays Little Mountain $19.00 for 87339.

## Out of scope

- **The staff iPad app.** It keeps working unchanged, since it reads stock. Recording from it can come later.
- **Moving money:** an exchange never collects or refunds a difference. A difference worth collecting is a refund and a new sale in Square, not an exchange.
- **Changing a closed payout run** that already paid the item coming back (D12): settled by hand.
- **Exchanging part of a multi-unit ticket.** Every ticket is one item.
- **Turning existing problems into exchanges:** the "Scanned twice" and "sold more than once" cards don't offer it. "Move to another ticket" stays on hold.
