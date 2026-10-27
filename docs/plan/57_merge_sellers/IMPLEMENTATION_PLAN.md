# Plan 57: Merge sellers

## Goal

An admin merges two seller records that are one seller, from the Sellers page, without anyone touching the database.

It happens. During Ski Swap 2026, "Tom McCarthy" was imported as a person on Sep 9 (12 items, paid by Venmo) and created again as a business on Oct 8 (60 items, paid by check, no contact details). Paid as two sellers, he'd get two payments and two payout records. Plan 10 left merging out ("until merge exists the answer is manual DB surgery").

This merges **sellers in one org**. It doesn't merge the people behind them: sign-in, verified contacts and other orgs' records stay as they are.

## What a seller record holds

| | Keyed by | On merge |
|---|---|---|
| Items (and through them sales, Sales check decisions, comps, exchanges, pickups, tickets) | `SwapItem.sellerId` | Move to the kept seller. SKUs, Square and every item-keyed record follow unchanged. |
| Receipts sent | `Receipt.sellerId` | Move. They're the seller's history. |
| Print jobs | `PrintJob.sellerId` | Move. Diagnostics only. |
| A printer assigned to the seller | `SwapPrinter.assignedSellerId` | Move. |
| Payout lines | `PayoutLine.sellerId` | See D4. |
| Name, contacts, sign-in, payout details, address | the seller's `User` | The kept seller's stay. Address and payout details can be taken from the other (D3). |
| Business name | `SellerProfile.businessName` | Choose (D3). |

## Decisions

| # | Decision |
|---|---|
| D1 | **One seller is kept, one is retired.** The admin chooses which, defaulting to the one with verified or more complete contact details. The retired record is soft-deleted (`deletedAt`) and records `mergedIntoId`, `mergedAt` and `mergedBy` (additive migration). Nothing is hard-deleted. |
| D2 | **Ski Swap admins only** (`ski_swap:admin`), like other changes that can't be undone from the screen. Removing a seller stays `ski_swap:manage`. |
| D3 | **What carries over is chosen, not guessed.** The kept seller keeps their own name, contacts and sign-in. The admin may take from the retired seller: <br>• **Address**: keep this one's, or use the other's. <br>• **Payout**: keep this one's, or use the other's when it's a check (address) or a scanned Venmo handle (the scan is the proof and moves with it). A PayPal email can't move: it's proven by the other person's verified email. <br>• **Business name**: keep, take the other's, or none. |
| D4 | **Money already moving refuses the merge.** If the retired seller has a payout line that is frozen, sending, sent, unclaimed, on hold or exported, the merge is refused: their items were paid, or are being paid, under that record, and moving them would pay them twice. The answer is to settle by hand. A **pending or approved** line of the retired seller is removed from its open run. A **failed or cancelled** one paid nothing and stays with the retired record as history. The kept seller's approved lines go back to **pending**, because their total changed and someone should look again. If the kept seller was already paid for a swap, the moved items appear as **Changed since paid**, the existing settle-by-hand flow. |
| D5 | **The retired id keeps working.** Writes naming a merged seller go to the kept one: `SellerService.findOrThrow` follows `mergedIntoId`, one hop, chains collapsed at merge time. An iPad's offline queue of items for the old record lands on the new one instead of failing. The public seller page (`/public/sellers/:id`, linked from receipts already sent) shows the kept seller. Reads that list sellers never show a retired one. |
| D6 | **The iPads learn by syncing.** Moved items get a new `updatedAt`, so they arrive in the item delta. The retired seller's membership is touched, so its tombstone arrives in the seller delta. Nothing new for the app. |
| D7 | **A preview before anything changes.** `GET …/sellers/:keepId/merge-preview?other=:retireId` returns both records side by side: counts of what moves per row of the table above, the payout lines and what happens to each (D4), the choices D3 offers, and any reason it's refused. The merge (`POST …/sellers/:keepId/merge`) sends the choices and the counts the preview showed. If anything changed in between, it's refused and asks the admin to look again (Payouts' `expectedLineCount`). |
| D8 | **One transaction, one audit row.** Everything moves in one database transaction. `ski_swap.seller.merged` records both ids, the choices, and the ids of every item, receipt and payout line moved or changed, so a merge can be reversed by hand if one is ever done wrong. There's no Undo button. |

## Phases

Each phase ships alone.

### Phase 1: Server

- Migration (needs the user's OK): `SellerProfile.mergedIntoId`, `mergedAt`, `mergedBy`, plus an index on `mergedIntoId`.
- `SellerMergeService`:
  - `preview(orgId, keepId, retireId)` and `merge(orgId, keepId, retireId, choices, expected, actorId)`.
  - It refuses: the same seller twice, a seller in another org, an already-merged or removed seller, and D4's paid lines.
- `SellerService.findOrThrow` follows `mergedIntoId` (D5), and so does `PublicSellerService.getById`.
- Contracts: `SellerMergePreviewResponse` and `MergeSellersSchema` (strict).
- Tests:
  - every table in the matrix moves;
  - D4's refusals and line handling;
  - stale counts are refused;
  - a merged id resolves on item create;
  - the public page follows the merge;
  - the audit row lists what moved.
- Smoke `smoke-merge-sellers.mjs` in `patrolkit-smoke`:
  - two sellers with items, a receipt, and a pending line in a check run;
  - merge, then check every row, the run, the tombstone in the seller delta, and an item created for the old id.

### Phase 2: Web

- **Merge…** on a seller's Edit dialog, for admins.
- The dialog:
  1. **Choose the other seller.** A search over this org's sellers, like the seller picker elsewhere.
  2. **Which one stays.** Two cards side by side: name, contacts and whether they're verified, payout, address, item counts by swap, payout lines. The suggested one is preselected.
  3. **What carries over.** D3's three choices, each showing both values.
  4. **What happens.** The preview's counts in plain words ("60 items, 1 pending check-run line removed…"), and any refusal in red.
  5. **Merge into {name}.** A red button; the confirm names both sellers.
- After a merge, the Sellers list refreshes and the kept seller's Edit dialog opens.

## Out of scope

- Merging people (`User` rows): sign-in, verified contacts, other orgs.
- Undo from the screen (D8 leaves enough to reverse by hand).
- Merging more than two at once: merge twice.
- Suggesting duplicates automatically.
