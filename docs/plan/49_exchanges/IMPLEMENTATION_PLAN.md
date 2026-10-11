# Plan 49: Exchanges

**Status:** built 2026-10-10, tested locally against the Square stand-in. Not yet deployed: the migration (one new table) waits for a yes.

## Goal

An **Exchanges** tab in the ski swap, beside Payouts and Reports. It is the home for a customer handing back an item they bought and leaving with another. An admin records the exchange at the counter as it happens. The tab lists every exchange so far, and an admin can cancel one.

Once an exchange is recorded, PatrolKit counts the sale on the item that left the building, and Square's stock matches what's on the floor:

- **The item that came back** is for sale again, and its seller isn't paid for it.
- **The item that went out** is sold, and its seller is paid its ticket price, whatever the customer paid.

Square's own sale record isn't changed, because Square can't do that without Square Plus. PatrolKit keeps the exchange alongside it.

## Why

On 2026-10-09 a customer bought Little Mountain's 87344 (Leki 100cm poles, $19.00) on receipt #Gq00. They came back for 87339, a different size at the same price. Square only allows exchanges with Square Plus, and a refund plus a new sale would need the customer's card again. Today that leaves three problems:

- **Square and PatrolKit both say the wrong ticket sold.** 87344 shows as sold although it's back on the floor. 87339 shows as for sale although it left with the customer.
- **The register could sell 87339 again.** If that happens, the payouts safeguard holds the second sale, and its seller isn't paid until someone works out why.
- **The fix depends on someone remembering.** Nothing records the exchange until it shows up in the books, if it ever does.

Exchanges between items at different prices happen too (D6).

## What's already here

- **Which item a sale counts for:**
  - Every reader goes through the same chain. It starts with Square's sale lines (`listSales`, with refunds subtracted). Then Sales check's decisions apply (`applyDecisions`): a `CREDIT` moves a line onto one of our items, and a `NOT_SWAP` drops it.
  - The readers are:
    - the dashboard (`ItemBreakdownService.sales`);
    - payouts (`payout-run.service.ts`);
    - Sales check (`classify`, `oversold`);
    - Catalog check's stock check (`soldUnits`).
  - `applyDecisions` only moves lines that aren't already on one of our items. An exchange is the case it can't handle: a sale on one of our items that belongs to another.
- **Sold or for sale:** the Items page, seller pages, the public status page and the register all read Square's stock. Sales don't decide it.
- **Stock writes:** `getInventoryCounts` and `setInventoryPhysicalCount`. Since `91c9e01`, an item edit moves stock by the change only, reading the count and then setting it. This plan does the same.
- **Payouts:**
  - A run pays each sold item's **listed price** (`build-run.ts`). It carries what the register took for reporting only.
  - Since `19d9801` a run pays a ticket for at most its checked-in units and holds the rest.
  - The discount report (`discountsOf`) lists any line where the listed price is above what was collected.
- **Receipt numbers** are the first four characters of a payment id (`receiptOf`, `cf050b5`). Staff search for these at the register.
- **Every ticket is one item** (quantity 1), so an exchange is always one unit.
- **Permissions:** `ski_swap:report` (read), `ski_swap:manage` (edit items), `ski_swap:admin`.

## Decisions

| | Decision |
|---|---|
| D1 | A new **Exchanges** tab, scoped to a swap like Payouts. Anyone with `ski_swap:report` can see it. Only an admin (`ski_swap:admin`) can record, edit or cancel an exchange. |
| D2 | Exchanges are recorded **at the counter, on the web**. The staff iPad app keeps working without changes. |
| D3 | An exchange belongs to **one Square sale line** for one of our items, the item coming back. The admin finds it by **receipt number** or by **the ticket coming back**. |
| D4 | From then on, every reader counts that sale on **the item going out**. Square's sale record is untouched. |
| D5 | **Square's stock moves when the exchange is recorded:** the item coming back goes up by 1, and the item going out goes down by 1. |
| D6 | **Different prices are allowed, and no money changes hands.** The seller of the item going out is paid its listed price. The seller of the item coming back is paid nothing for it. The patrol absorbs the difference, or keeps it. When the difference is big, staff don't record an exchange: they refund the sale and ring up the new item in Square. |
| D7 | **An unpriced item going out gets a price when the exchange is recorded**, because its seller has to be paid something. |
| D8 | **Different sellers are allowed, with a warning**, because the sale and its payout move to the other seller. |
| D9 | **An exchange is accepted only when both items check out.** The sale line must count the item coming back as sold. The item going out must be for sale: in this swap, live, unsold and in stock. Both are checked again against Square when the exchange is saved. |
| D10 | **A second exchange of the same sale chains onto the first.** It supersedes the first, and cancelling it brings the first back. |
| D11 | **Cancelling keeps the record.** The exchange is marked cancelled with who, when and why, and its stock move is reversed. Cancelling is refused if the item that came back has sold again since. Nothing is ever hard-deleted. |
| D12 | **Payouts follow the exchange from the next run built.** A closed run that already paid for the item coming back isn't changed. Recording the exchange warns about it, and the difference is settled by hand. No run has been built yet this swap. |
| D13 | **Sellers see nothing new.** Their pages already follow Square's stock, so the item that came back shows as for sale and the item that went out shows as sold. |

### D3: Finding the sale

The admin types either the receipt number as printed (**Gq00**) or the ticket coming back (**87344**):

- **By receipt:** the tab lists every line of that sale that PatrolKit counts for one of this swap's items. That count comes after Sales check's decisions and any earlier exchanges.
- **By ticket:** the tab lists every sale counted on that ticket. Usually there's one, but tickets in the "Scanned twice" and "sold more than once" cases have more.

The admin picks the line, so a six-item sale like Gq00 needs no guessing. A line that was already exchanged shows what it was exchanged for, and picking it starts a chained exchange (D10).

### D4: How the sale moves

A new step, `applyExchanges(lines, exchanges)`, runs after `applyDecisions`:

- A line with a live exchange gets the variation of the item going out.
- A chain resolves to its latest live link.

Every reader goes through one function, `attributeSales(lines, decisions, exchanges, …)`, so no reader can skip a step.

### D5: Stock

Stock moves the same way as in item edits: read Square's count, then set it one higher or lower, never below 0.

The exchange is saved first and the stock moves after:

- **If Square can't be written to,** the exchange is kept and flagged "Square's stock not updated", with **Retry** on its card. The books are right either way; only the register and the for-sale state are waiting.
- **Catalog check's stock check** catches anything left behind, because its expected stock goes through `attributeSales` too.

### D6: Prices

- **The record** keeps both listed prices as they were when the exchange was recorded. Nothing is collected or refunded, so there's no receipt for the difference.
- **Payouts** pay the listed price of the item going out, as for any sale. When the item going out costs more, the line shows a gap between listed and collected. The discount report labels those lines "Exchange" so they aren't listed as discounts.
- **The tab** totals what the patrol absorbed (items going out that cost more) and kept (items going out that cost less).
- **The form**, when prices differ, shows the difference and says the patrol absorbs or keeps it. It also reminds the admin that a big difference belongs in Square as a refund and a new sale.

### D10: Chains

Say the customer brings 87339 back for 87341. The admin looks up receipt Gq00 or ticket 87339 and picks the same line. That records a new exchange from 87339 to 87341, which supersedes the first.

- **The sale line** has one live exchange at a time (`liveKey`), now the second.
- **The first exchange** shows as "superseded by …".
- **Stock:** 87339 goes up by 1 and 87341 goes down by 1.
- **Cancelling:** only the latest link in a chain can be cancelled. Cancelling the second exchange makes the first live again, and reverses only the second exchange's stock move.

## Data

One new table, added without changing anything else:

```
SwapExchange
  id, swapId, orgId
  orderId, lineUid            -- the Square sale line exchanged
  paymentId                   -- for the receipt number and links
  returnedItemId              -- the item coming back
  replacementItemId           -- the item going out
  returnedPriceCents          -- listed prices when recorded (null = unpriced)
  replacementPriceCents
  note
  stockSynced  Boolean        -- D5: false until both stock moves land
  supersedesId                -- D10: the exchange this one replaced
  recordedBy, recordedAt
  cancelledBy, cancelledAt, cancelReason
  liveKey                     -- orderId:lineUid while live; null once superseded or cancelled
  @@unique([swapId, liveKey])
```

## Server

**`exchanges.service.ts`**, with a controller under `orgs/:orgId/ski-swap/swaps/:swapId/exchanges`:

| Route | Permission | What it does |
|---|---|---|
| `GET /` | report | Lists every exchange, live or not, with its items, sellers, receipt and links. |
| `GET /lookup?receipt=Gq00` or `?ticket=87344` | admin | Lists the sale lines found (D3), each with its current item and any live exchange. |
| `POST /` | admin | Records an exchange, with an idempotency key. It checks D9 against a fresh read of Square and prices an unpriced item going out through the item edit (D7). Then it saves, moves stock (D5) and writes the audit entry. |
| `PATCH /:id` | admin | Edits the note. To change anything else, cancel the exchange and record it again. |
| `POST /:id/cancel` | admin | Cancels (D11): refuses if the item that came back has sold since, reverses the stock, and makes the superseded exchange live again. |
| `POST /:id/retry-stock` | admin | Tries the stock moves again (D5). |

**Changes elsewhere:**

- **`sales-check.ts`:** adds `attributeSales` and `applyExchanges`. `ItemBreakdownService.sales`, `PayoutRunService`, Sales check and Catalog check call `attributeSales`, and each clears its cached sales after an exchange changes.
- **`build-run.ts`:** `discountsOf` labels exchange lines (D6).
- **Audit actions:** `ski_swap.exchange.recorded`, `ski_swap.exchange.cancelled`, `ski_swap.exchange.stock_retried`.

**Refusal messages:**

- "87339 is sold already: pick an item that's for sale."
- "That sale isn't counted on 87344 any more: look it up again."
- "87344 has sold again since the exchange, so cancelling would put two on the floor."

## Web

**Exchanges tab** (`ExchangesPage.tsx`) opens with a note: "Exchanges in Square are preferred, but they need Square Plus and the Square for Retail POS app. Record an exchange here when Square can't." Below the note, the tab has two parts.

1. **Record an exchange**, one panel, top to bottom:
   - **Find the sale:** one box for "Receipt # or the ticket coming back". Below it, a short list of the sale lines found (ticket, name, seller, price, receipt, time). The admin picks one.
   - **Pick the item going out:** an item search limited to items for sale. The card reuses Sales check's two-sided `ReportCard` layout, with **Coming back** on the left and **Going out** on the right.
   - **Warnings, shown inline:**
     - different seller: "The sale and its payout move from Little Mountain to {other seller}.";
     - different price: "The patrol absorbs $12.00. For a big difference, refund and re-ring it in Square instead.";
     - unpriced item going out: asks for its price;
     - a closed payout run already paid for the item coming back (D12).
   - **Note**, then **Record exchange**. The card turns into a green tombstone: "Recorded: 87344 back for sale; 87339 sold on receipt #Gq00."
2. **Exchanges so far:** cards, newest first, searchable by ticket, receipt or seller.
   - **Each card** shows when, the receipt, coming back → going out, sellers, prices, the difference absorbed or kept, who recorded it, and the note.
   - **Status** is one of: live, superseded, cancelled, or "Square's stock not updated" with **Retry**.
   - **Cancel…** asks for a reason.
   - **Totals** show the difference the patrol absorbed and kept.

**Who sees what:** anyone with `ski_swap:report` sees the list. Only an admin sees "Record an exchange", the note's **Edit**, **Cancel…** and **Retry**.

**Items page:** for an admin, a sold item's row gets **Exchange…**, which opens the tab with that ticket filled in.

**Dashboard:** no change on the page; its numbers follow `attributeSales`.

## Tests

- **`applyExchanges`:**
  - moves one line;
  - follows a chain to its latest live link;
  - ignores cancelled and superseded exchanges;
  - leaves other lines on the same receipt alone.
- **Every reader, from one fixture of the 87344 → 87339 case:**
  - **Dashboard and payouts:** the sale counts for 87339.
  - **Sales check:** shows no repeat sale.
  - **Catalog check:** expects 87344 at 1 and 87339 at 0.
- **Recording:**
  - refuses an item going out that isn't for sale;
  - refuses a line that has moved since the lookup;
  - prices an unpriced item going out;
  - moves stock by one each way;
  - sets `stockSynced` false when Square refuses a write, and Retry fixes it;
  - is idempotent.
- **Prices:**
  - when the item going out costs more, payouts pay its listed price and the discount report labels the line "Exchange";
  - the tab's absorbed and kept totals add up.
- **Different sellers:** the payout moves to the other seller.
- **Cancelling:**
  - reverses stock;
  - is refused when the item that came back has sold again;
  - cancelling a chain link makes the one it superseded live again.
- **Routes:**
  - `GET /` needs `report`, and changes nothing;
  - every change (record, edit the note, cancel, retry) needs `ski_swap:admin`.
- **Web:**
  - the lookup list;
  - the warnings for each case;
  - the two-sided card;
  - the list's states;
  - the note about Square exchanges.

## Rollout

1. Build and test against the local Square stand-in, including a six-line receipt like Gq00.
2. Ask before deploying. The migration adds one table and changes nothing else.
3. Record the first real exchange through the tab: receipt #Gq00, 87344 → 87339. Then check that:
   - Square shows 87344 at 1 and 87339 at 0;
   - Sales check and Catalog check show nothing for either ticket;
   - a payout preview pays Little Mountain $19.00 for 87339.

## Out of scope

- **Recording from the staff iPad app.** It can come later.
- **Collecting or refunding a difference.** That's a refund and a new sale in Square (D6).
- **Changing a closed payout run** that already paid for the item coming back. That's settled by hand (D12).
- **Exchanging part of a ticket.** Every ticket is one item.
- **Turning existing Sales check issues into exchanges.** The "Scanned twice" and "sold more than once" cards don't offer it, and "Move to another ticket" stays on hold.
