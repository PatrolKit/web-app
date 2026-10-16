# Plan 52: Payout runs, built by hand

## Goal

Rework the payout run (Plan 25) so that a person builds it:

- A run is **either checks or PayPal Payouts**, and it **starts empty**.
- Staff **add sellers** to it, one at a time or several at once, from the sellers that run can pay.
- For a given swap, **a seller is in one run at a time**, and in a second only if PayPal didn't pay them in the first.
- Each seller's card shows everything they sold:
  - each item with when it sold, its **receipt number** and a **"View in Square"** link;
  - the item count and subtotal;
  - the patrol's take, as a percentage and in dollars;
  - the total.
- The list **sorts** by name, amount owed or number of items.
- It **flags** any seller with an issue, and **every flag blocks payment** until it's resolved.

Today a run reads every sale in a date window and builds a line for every seller at once, and later runs pay only what earlier runs didn't. That goes. Nothing has been paid on production, so the existing runs are deleted and the payout tables are reshaped, with unused columns dropped. This was approved on 2026-10-14 as an exception to additive-only migrations, for these tables only.

## Decisions

| # | Decision |
|---|---|
| D1 | **A run has a kind:** `CHECK` or `PAYPAL`, chosen when it's created and never changed. A check run pays sellers whose payout method is Check. A PayPal run pays sellers whose method is PayPal or Venmo, both sent through PayPal Payouts. A seller who chose Donate is in neither (D11). |
| D2 | **A run starts empty**, with no date window: a seller's sales are all their sales in the swap, whenever made. |
| D3 | **Adding sellers.** "Add sellers" opens a picker that lists only the sellers this run can pay:<br>• **the right method:** their payout method matches the run's kind (D1), so a PayPal run never shows check sellers, and a check run never shows PayPal or Venmo ones;<br>• **complete details:** their payout details are complete for that method by `payoutGaps` (D8), meaning a verified PayPal email or a scanned Venmo handle for a PayPal run, and a complete mailing address for a check run;<br>• **owed and free:** something is owed, and they're in no run of this swap, apart from runs where PayPal didn't pay them (D4, D19).<br>Each row shows the amount owed, the item count and any flag (D8). The picker has search, checkboxes and "select all shown". Sellers with incomplete details aren't offered; "Before you pay" lists them to fix first (D16). |
| D4 | **One run per seller, per swap, until PayPal doesn't pay them.** A payment that ends without paying them (failed, returned or cancelled, D19) is final in its run and frees them, and adding them to another run is the only way to pay them again. The database enforces it: `PayoutLine.activeKey` is `swapId:sellerId` while the line counts and null once its payment didn't pay them, under a unique index, so two people adding the same seller at once can't both succeed. |
| D5 | **Removing a seller** is possible until their money moves (D6). The line is deleted, and the seller can be added to any run again. |
| D6 | **Amounts are live until money moves.** While a seller's line is open, its items and totals are worked out whenever they're shown, from the swap's sales (after Sales check credits and exchanges), current prices, and the patrol's share as it's set now. When the money moves, the line is frozen, items included, and never changes again. For a PayPal run that's Send; for a check run, closing and exporting it. |
| D7 | **Checked fresh when money moves, all or nothing.**<br>• **Approval:** every seller is approved by hand, one at a time, before any money moves; there's no bulk approve. Approving records the total the approver saw.<br>• **The re-check:** the screens use the dashboard's shared sales read, refreshed every two minutes. Sending a PayPal run, or closing a check run, reads Square afresh and computes every approved seller again.<br>• **If any approved seller's total differs from what was approved, nothing in the run is paid:** no batch is sent, and a check run isn't closed.<br>• **What changes:** the changed sellers' approvals are cleared, each saying "Changed since approved: was $A, now $B. Review again". The run says "Not sent: N sellers changed since approval" ("Not closed: …" for a check run). The others stay approved, and once the changed ones are approved again, the run can go. |
| D8 | **Flags, every one blocking.** A flagged seller can't be approved, sent or exported. The card and the picker say what's wrong and where to fix it. The flags:<br>• **Payout details incomplete**, by `payoutGaps`, the rule behind the Sellers page's "can't be paid" filter. Such a seller isn't offered in the picker (D3), but one already in a run can lose a detail afterwards, for example by changing to an email that isn't verified yet.<br>• **Wrong run:** the seller's payout method changed since they were added and no longer matches the run's kind. Remove them and add them to the right run.<br>• **Unpriced sale:** a ticket sold with no price in PatrolKit and none typed at the register.<br>• **Counted as sold twice:** a ticket rung up more times than it was checked in (Plan 48's held sales).<br>• **Sold for a different price:** an open Sales check "Sold for a different price" issue on one of their items. It clears when PatrolKit's price is kept or set from the sale.<br>• **Open Sales check sale on their ticket:** any other open Sales check issue naming one of their tickets (another copy, scanned twice, sold twice).<br>• **Nothing owed:** everything was refunded since they were added. |
| D9 | **After money moves, a change is flagged and settled by hand.** If a frozen seller's live total later differs from what they were paid, for example after a late Sales check credit or a refund, their card says "Owed $X more since paid" or "Paid $X more than now owed". It also shows in the run's header and on the Payouts page. Nothing is sent or rebuilt: staff settle it outside PatrolKit, then mark it settled with a note, which is audited. |
| D10 | **The card.**<br>• **Header:** the seller's name, their method and destination (or address, for a check), the item count, the total owed, the status, and flag badges. The total, status and buttons sit in fixed columns, so they line up from card to card.<br>• **Expanded:** one row per sold item, with SKU, name, sold date and time (in the swap's time zone), receipt number with "View in Square", the listed price, and what the register collected when it differs. Donated items show at $0 with "donated".<br>• **Footer:** "N items · Subtotal $X", "Patrol take (20%) −$Y", "Total $Z". |
| D11 | **Donate sellers aren't paid and aren't in runs.** The Payouts page lists them under "Donated to the patrol", with their totals, for the record. |
| D12 | **Sorting and filtering.** Sort by name (A–Z), amount owed (highest first) or number of items (most first); the choice is remembered per browser. Filter chips: All, Needs review, Approved, Paid (Exported, for a check run) and Flagged, plus "Unclaimed" and "Not paid" on a sent PayPal run, each shown only when there are any (D18). |
| D13 | **The run header.**<br>• **PayPal run:** the "can PayPal cover it" line (D17) and Send, under the server's lock. Send stays disabled until every seller is approved, with "N still to approve" beside it.<br>• **Check run:** "Checks to write: N, $X", and "Close and export", disabled the same way. PatrolKit doesn't record check numbers: closing freezes every seller (D6, D7), and the closed run offers "Download checks (CSV)", one row per check (payee, mailing address, amount, memo, date), in plain columns for whatever program the patrol writes checks with.<br>• **Both:** counts of flagged sellers, of sellers changed since approval (D7), and of sellers changed since paid (D9). |
| D14 | **Before you pay.** One box at the top of the Payouts page holds everything to fix before paying, and disappears when there's nothing:<br>• sellers missing payout details (D16);<br>• Sales check issues: each seller's open issues, and sales that matched no ticket, which nobody is paid for until settled;<br>• sellers PayPal didn't pay who aren't in another run yet (D19).<br>Discounts (sales below their listed price, paid to sellers at the listed price) are a separate section lower down, for the record. |
| D15 | **Closing happens by itself.** There's no "Close run" button, so no unpaid seller can be stranded in a closed run.<br>• **A PayPal run** closes once every payment in it is final: paid, failed, returned or cancelled (D19). One still sending, unclaimed or on hold keeps it open.<br>• **A check run** closes with "Close and export" (D13).<br>• **A closed run** takes no more sellers, and nothing in it can be added, removed or approved. A bar across the top of the run page says "Closed Oct 16, 10:08 AM"; an open run's bar says since when, and what's left to do.<br>• **An empty run** (created by mistake) can be deleted. A run with sellers in it can't be. |
| D16 | **Sellers missing payout details**, the first part of "Before you pay" (D14).<br>• **The summary:** how many, then a bulleted count by what's missing, for example "2 need a PayPal or Venmo destination", "1 needs a mailing address", "1 hasn't chosen how to be paid".<br>• **Expanded:** each seller with the problem and fix from `payoutGaps`, linking to Edit Seller (`/sellers?edit=<id>`), plus "Show all on the Sellers page" (`?show=unpayable`).<br>• **What it counts:** only sellers with sales in this swap, and only the gaps that stop their own payout method; an address isn't needed to pay through PayPal.<br>• **Why it's needed:** these sellers aren't offered to any run until fixed (D3). Most predate Plan 35; since then PatrolKit saves PayPal only with a verified email, and Venmo only with a scanned handle. |
| D17 | **Can PayPal cover the run? One line, yes or no.**<br>• **The line:** "✓ PayPal covers this run: $270.10 needed, $500.00 available", or "✗ PayPal is $193.50 short: $693.50 needed, $500.00 available". Without the balance: "? Make sure PayPal has $270.10. PatrolKit can't read the balance."<br>• **Needed** is what the sellers get plus PayPal's fee on each payment. Hovering the amount shows the split ("$269.60 to sellers + about $0.50 in PayPal fees").<br>• **The fee is an estimate** at PayPal's published US rate for payouts sent through the Payouts API, as PatrolKit sends them: a flat $0.25 a payment, the same for Venmo. (Payouts sent other ways are 2%, at most $1.00.) An account can be on other terms, so the rate is a setting in Administration → PayPal: a flat amount per payment, plus an optional percentage up to a cap. It defaults to $0.25, 0% and no cap.<br>• **What was actually charged:** PayPal's answer to a batch reports its fees (`batch_header.fees`). They're recorded on the run, so a wrong rate is noticed and corrected.<br>• **The balance** needs the PayPal app's permission for PayPal's reporting API, which BMBWAV's app doesn't have yet.<br>• **Send waits for the money:** while the balance is known and short of what the approved payments need, Send is disabled, and says why on hover. |
| D18 | **One run is one PayPal batch, and what PayPal reports is shown on it.**<br>• **One batch:** a PayPal run is sent once, and once sent it takes no more sellers. The only repeat is "Send again" after a Send PayPal refused outright or never answered (D19), which isn't a second batch.<br>• **The batch:** the run shows its payout batch ID with "View in PayPal", PayPal's batch status in plain words ("Waiting on PayPal", "Processed", "Refused by PayPal"), the fees it charged (D17), and a count: "7 paid · 1 waiting · 1 not paid, of 9".<br>• **Each payment:** the seller's status becomes PayPal's, in plain words: Sending, Paid, Unclaimed ("Waiting for them to claim it. PayPal returns it after 30 days if they don't."), On hold ("PayPal is reviewing it"), Failed (with PayPal's reason), Returned or Cancelled. A paid card shows when it was paid and PayPal's **transaction ID**, the code the seller sees in their own PayPal or Venmo, plus the PayPal item ID.<br>• **Kept up to date** by PayPal's webhooks, with the sweep reading the batch as a backstop, as now. |
| D19 | **When PayPal doesn't pay someone.** Nothing is retried inside a run. A payment that ends without paying them is final there, the run says so, and they're paid by adding them to another run (D4). Their amount is live again until that run's money moves (D6).<br>• **Failed** (PayPal's FAILED or BLOCKED): marked Failed, with PayPal's reason.<br>• **Not accepted (unclaimed):** "Remind them" sends the existing email and text reminders. "Cancel payment" cancels it at PayPal; the money comes back to the PayPal account, and they're marked Cancelled. Left alone, PayPal returns it after 30 days, and it's marked Returned, as are PayPal's RETURNED, REFUNDED and REVERSED.<br>• **On hold:** nothing to do. PayPal releases it or fails it.<br>• **The whole batch denied after it was accepted** (batch status DENIED or CANCELED): the whole run failed. Everyone in it is marked Failed, and the run shows PayPal's reason. Today's code doesn't handle this: it reads only each payment's status, so these lines could sit in Sending for good.<br>• **The whole batch refused at Send** (for example INSUFFICIENT_FUNDS, or a request PayPal rejects): nothing was queued and nothing moved. Everyone stays approved, the run shows PayPal's reason ("Not sent: … Nothing was paid."), and once the cause is fixed, Send again; the D7 re-check applies.<br>• **No answer at Send** (a timeout, or PayPal down): PayPal may or may not have it. Everyone stays Sending, the run explains, and "Send again" re-posts the same `sender_batch_id`, which PayPal won't pay twice; the sweep looks too. This is today's behaviour, kept.<br>• **Paying them again:** "Before you pay" lists them with the run and PayPal's reason (D14). The picker offers them with "PayPal didn't pay them in an earlier run. Check their details are right.", and their card in the new run says "Earlier: not paid in the PayPal run of Oct 16 (failed: …)".<br>• **The server's lock** refuses Send and Cancel payment before anything moves, as now. |

## Server

### Before the migration: delete the existing runs

A script lists production's payout runs, then deletes them with their lines, line items and notices (which cascade). It refuses if any line was ever handed to PayPal (`payoutBatchId` or `sentAt`) or had a check marked sent (`checkSentAt`); none has. It's run only with the go-ahead, and audited. The migration then starts from empty tables.

### Schema (migration `…_payout_runs_by_hand`, reshaping the payout tables)

- **`PayoutRun`:**
  - **Add** `kind VarChar(8)`: `CHECK` | `PAYPAL`.
  - **Add**, for the run's one PayPal batch (D18): `payoutBatchId String?`, `batchStatus VarChar(12)?`, `paypalFeeCents Int?` (D17) and `batchReason Text?`, PayPal's reason for a refused or denied batch (D19).
  - **Drop:**
    - `salesFrom` and `salesTo` (no window, D2);
    - `commissionBasisPoints` (frozen per line instead, D6);
    - `unmatchedSales` and `heldSales`, now worked out live (unmatched in "Before you pay", D14; held units as a seller flag, D8).
  - `status` becomes `OPEN` | `CLOSED`, replacing `DRAFT` and `REVIEW`.
  - `sendAttempt`, `closedAt` and `closedBy` stay.
- **`PayoutLine`:**
  - **Add:**
    - `swapId`, and `activeKey VarChar(80)?` (`swapId:sellerId` while the line counts, null once PayPal didn't pay them) under a unique index (D4);
    - `frozenAt DateTime?`;
    - `commissionBasisPoints Int?`, frozen with the line;
    - `approvedNetCents Int?`, the total the approver saw (D7);
    - `settledAt`, `settledBy` and `settledNote` (D9);
    - `transactionId VarChar(64)?`, PayPal's transaction ID once paid (D18); when it was paid stays in `sentAt`.
  - `status` is `PENDING` (needs review), `APPROVED`, `SENDING`, `SENT`, `UNCLAIMED`, `ONHOLD`, `FAILED`, `RETURNED`, `CANCELLED` (an unclaimed payment cancelled at PayPal, D19) or `EXPORTED` (a closed check run, D13).
  - **Nullable until frozen,** since they're stored only once money moves and the seller's current details are shown before then (D6):
    - `grossCents`, `commissionCents` and `netCents`;
    - `method`, `destination` and `destinationType`.
  - `sellerName` stays, and is refreshed when the line is frozen. `payoutBatchId` stays.
  - **Drop** `checkNumber` and `checkSentAt`: check numbers live in whatever program writes the checks (D13). For a check, the mailing address is frozen as `destination`, so the spreadsheet shows where each check went.
- **`PayoutLineItem`:** add `paymentId VarChar(64)?` and `lineUid VarChar(64)?`, so a frozen item keeps its receipt and Square link.
- `PayoutNotice` is unchanged.
- **`SkiSwapSettings`:** add `paypalFeeFlatCents Int @default(25)`, `paypalFeeBps Int @default(0)` and `paypalFeeCapCents Int @default(0)`, the fee estimate's rate (D17).

### What a seller is owed (pure)

`build-run.ts` keeps its name; `buildRun` now works out what each seller is owed, live:

- `buildRun(items, sellers, sales, opts)` returns each seller's items, their gross, the commission and the net. Each item carries `soldAt`, `orderId`, `paymentId`, `lineUid`, the price owed on, and what was collected.
- It keeps today's rules:
  - the listed price;
  - a typed price for an unpriced ticket;
  - refunds subtracted;
  - never more units than were checked in, with the rest held.
- The same pass reports unpriced sales and held units. The service adds the flags that need the database or Sales check.
- `countsAsPaid` and `paidBefore`, which let a later run pay only what earlier runs didn't, are removed: one run per seller replaces them.

### Service and routes (`payout-run.service.ts`, `payout-run.controller.ts`)

**Runs**
- `POST swaps/:swapId/payout-runs { kind }` creates an empty run.
- `DELETE payout-runs/:runId` deletes a run with no sellers in it, and is refused otherwise (D15).
- `GET payout-runs/:runId` returns the run, its batch (D18), its lines (live or frozen, D6), each line's flags (D8), PayPal status (D18) and changes since paid (D9), the totals, and the funding (D17).

**Sellers**
- `GET swaps/:swapId/payout-sellers?kind=` lists the sellers a run of that kind can take (D3), with amount owed, item count, flags, and whether PayPal didn't pay them before (D19).
- `POST payout-runs/:runId/sellers { sellerIds }` adds sellers, and is refused once the run has been sent (D18). It answers per seller: added, already in another run, wrong method, incomplete details, or nothing owed.
- `DELETE payout-runs/:runId/sellers/:sellerId` removes one (D5).

**Paying**
- `POST payout-runs/:runId/lines/:lineId/approve { approved }` approves or unapproves one seller (D7), records `approvedNetCents`, and refuses flagged sellers.
- `POST payout-runs/:runId/send` (PayPal run, under the server's lock) is refused while any seller is unapproved (D13), and while PayPal's balance is known and short of the approved payments plus their estimated fees (D17). It reads Square afresh and checks every approved seller's total against what was approved. If any differs, it sends nothing and clears only the changed sellers' approvals (D7). Otherwise it freezes every line with its items and sends the run's one batch (D18). If PayPal refuses it (4xx), it records `batchReason` and leaves everyone approved; if PayPal doesn't answer, everyone stays Sending for "Send again", which re-posts the same `sender_batch_id`, as now (D19).
- `POST payout-runs/:runId/lines/:lineId/cancel-payment` (unclaimed payment, under the server's lock) cancels it at PayPal, as `cancelUnclaimed` does now, and marks the line Cancelled (D19). Unlike today, it doesn't send the line back for another try in the same run.
- "Remind them" is today's nudge (`PayoutNudgeService`), unchanged.
- `POST payout-runs/:runId/close-checks` (check run) is refused while any seller is unapproved (D13). It runs the same all-or-nothing check (D7); if nothing changed, it freezes every line and closes the run.
- `GET payout-runs/:runId/checks.csv` (closed check run) is the checks spreadsheet (D13).
- `POST payout-runs/:runId/lines/:lineId/settle { note }` marks a change since payment as settled (D9).

**PayPal's answer** (send, webhook, sweep)
- Each item's `transaction_status`, `transaction_id` and time, and the batch's status and fees, are stored (D17, D18).
- A batch reported DENIED or CANCELED marks everyone in it Failed (D19).
- A line that ends Failed, Returned or Cancelled has its `activeKey` cleared in the same write, so the seller can join another run (D4).
- The run closes once every payment is final (D15).

**Payouts page**
- `GET swaps/:swapId/payouts-summary` returns:
  - the runs;
  - "Before you pay" (D14): sellers whose payout details stop them being paid, each with its `payoutGaps` problem and fix (D16); open Sales check issues by seller, and unmatched sales; and sellers PayPal didn't pay who aren't in another run (D19);
  - the sellers changed since paid (D9);
  - the discount report (D14);
  - the donated sellers (D11).

**Reading sales**
- The screens use the shared read (`ItemBreakdownService.rawSales`).
- Sending, and closing a check run, call `forgetSales` and read afresh (D7).

**Flags (D8)** are worked out in the service from four sources:
- the seller's payout details;
- the live pass (unpriced sales, held units);
- the run's kind;
- Sales check's open issues, read through `SalesCheckService.list` and matched to the seller's items by ticket and item (`paid.sku`, `suggestion.sku`, `oversold.sku`, `ticket`).

## Web

- **Payouts page:**
  - "Before you pay" at the top (D14, D16, D19), gone when there's nothing to fix;
  - "New run", a dialog asking for the kind ("Pay through PayPal" or "Pay by check"), which opens the empty run;
  - the runs, with kind, seller count, total, and Open or Closed;
  - sellers changed since paid (D9), discounts (D14) and the donated sellers (D11).
- **Run page:**
  - the bar across the top (D15);
  - the header (D13), and for a sent PayPal run, the batch (D18);
  - "Add sellers", which opens the picker (D3), until the run is sent;
  - the sort control and the filter chips (D12);
  - the seller cards (D10), each with flag badges and a "how to fix" line (D8), Approve or Unapprove, Remove, and once sent, PayPal's status for the payment, with "Remind them" and "Cancel payment" while it's unclaimed (D18, D19).
- **Pure helpers, with tests:** sorting, the card footer's arithmetic, flag wording, PayPal status wording, and the picker's selection.

## Tests

- **Pure:**
  - `buildRun` keeps every case it covers now, less the ones about earlier runs;
  - each item carries its time, receipt and sale line;
  - the commission is rounded once per seller.
- **Service** (in-memory doubles):
  - a seller can't be added to a second run, and the database index refuses a race;
  - removing a seller frees them;
  - live totals follow a new Sales check credit until money moves, then freeze;
  - each flag blocks approving, sending and exporting;
  - a total that changed between approval and send stops the whole run: nothing is sent or closed, only the changed sellers' approvals are cleared, and the others stay approved;
  - a frozen line that later falls out of step is flagged, then settled.
- **Smoke** (`smoke-payouts.mjs`, stubbed PayPal):
  - create a PayPal run and a check run;
  - add sellers by kind, and a duplicate add is refused;
  - approve, then send once (deduped on retry) and resolve by webhook and by sweep, storing each transaction ID;
  - a sent run refuses new sellers;
  - a failed, returned or cancelled payment is final in its run and frees the seller for another run, where they're paid;
  - an unclaimed payment keeps the run open until it's paid, returned or cancelled;
  - a batch refused at Send leaves everyone approved for Send again; a denied batch marks everyone Failed and closes the run;
  - close a check run and download its spreadsheet;
  - add a late credit and see "Owed $X more since paid".
- **Production stays locked** (`PAYPAL_PAYOUTS_ENABLED`) throughout; this plan doesn't change the lock.

## Not in this plan

- Paying part of what a seller is owed, or paying one seller across two runs. A second run is only for someone PayPal didn't pay (D19); a change after payment is settled by hand (D9).
- Refund clawback beyond the D9 flag.
