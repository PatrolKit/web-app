# To the iPad: receipt settings per swap

**From:** the server (Plan 36). **When:** once the server deploys with the new
swap fields. Until the iPad updates, it keeps printing receipts as it does
today.

## Why

Each swap now decides what a seller's receipt is:

- **Itemized:** a line per item, with toggles for SKU, name and price, plus an
  optional link to one of the swap's status pages.
- **Status page only:** no items, just the link.
- **None:** no receipt at all.

**Allow printing** decides whether receipts may be printed, and on which paper:
62 × 100 or 50 × 30. When it's off, receipts are still emailed and texted, but
never printed.

The server applies all of this wherever it makes a receipt. The iPad prints
its own, so it has to apply it too.

**Fine print** is an optional rich-text section that appears only in the email
and on the receipt page. The swap carries `receiptFinePrintEnabled` and
`receiptFinePrint`, and the iPad can ignore both.

## On the wire

### Swaps (`GET …/ski-swap/swaps`, `APISwap`)

**New fields:**

| Field | Values |
|---|---|
| `receiptMode` | `"ITEMIZED"`, `"STATUS_ONLY"`, `"NONE"` |
| `receiptShowSku` | Bool |
| `receiptShowName` | Bool |
| `receiptShowPrice` | Bool |
| `receiptLink` | `"NONE"`, `"SKU_LOOKUP"`, `"SELLER_STATUS"`, `"SELLER_LOGIN"` |
| `receiptPrintEnabled` | Bool |
| `receiptPaperSize` | `"62x100"`, `"50x30"` |

**Already there since Plan 33,** and needed here: `slug`, `skuLookupEnabled`,
`sellerLookupEnabled`, `sellerLoginEnabled`.

**Absent (an older server) should read as:** `ITEMIZED`, all three toggles
true, link `NONE`, printing allowed, and no paper requirement.

### Receipts (`POST …/sellers/:id/receipts`, `APIReceipt`)

**The response gains `layout`,** the server's decision for this receipt:

```jsonc
"layout": {
  "mode": "ITEMIZED",                // or "STATUS_ONLY"
  "show": { "sku": true, "name": true, "price": false },
  "link": { "url": "https://skiswap.patrolkit.io/bmbwavsp/ss26/status", "kind": "SKU_LOOKUP" },  // or null
  "print": { "paperSize": "62x100" } // or null: printing not allowed
}
```

- **Draw from `layout` whenever you have it.** It already accounts for a status
  page that's been turned off: `link` is null then.
- **`trackUrl`** is still sent, for builds that read it. Prefer `layout.link`.

### Refusals

All `409`:

| Code | When | Refused on |
|---|---|---|
| `RECEIPTS_OFF` | The swap's mode is `NONE`. | Create, send, and a drawn `receipt` sent to a station. |
| `RECEIPT_PRINT_OFF` | The swap doesn't print receipts. | A drawn `receipt`. |
| `RECEIPT_PAPER` | The station's printer has other stock. The message names both sizes. | A drawn `receipt`. |

## What the iPad needs

Paths are `patrolkit_ios/PatrolKit/…`.

1. **Carry the settings:** the seven new fields, plus the four Plan 33 fields
   if you don't already store them.
   - `APISwap` (`Services/SkiSwapAPIClient.swift:37-59`).
   - `SwapRecord` (`Services/PatrolKitStore+SkiSwap.swift:9-22`), with a GRDB
     migration after `v23-venmo-scanned` (`Services/PatrolKitStore.swift:594`).
   - Sync (`swapRecord(from:)`, `Services/SkiSwapSyncModule.swift:488-494`).
   - `SkiSwapContext` (`App/AppState.swift:78-107`, `:328-350`).
2. **None:** hide the seller page's Receipt menu
   (`Features/SkiSwap/SellerDetail/SellerDetailView.swift:245`, `:255-330`).
   Drop a queued `receipt/create` or `receipt/send` that comes back
   `RECEIPTS_OFF`: it will never succeed
   (`Services/SkiSwapSyncModule.swift:293-312`).
3. **Printing:**
   - **`receiptPrintEnabled` false:** hide **Print** in the Receipt menu
     (`SellerDetailView.swift:303-330`) and anywhere else a receipt is
     printed. Email and Text stay.
   - **`receiptPrintEnabled` true:** print only to a printer whose paper is
     `receiptPaperSize`, whether a bridge's or the iPad's own Bluetooth printer
     (`Printing/StationPrinter.swift:350-357`, `Printing/PrintRoute.swift`).
     Otherwise say why rather than print in the other layout: "This swap prints
     receipts on 62 × 100 mm labels; this printer has 50 × 30."
   - **Queued drawn receipts:** drop one that comes back `RECEIPT_PRINT_OFF` or
     `RECEIPT_PAPER`, and tell the user.
4. **Draw from the layout** (`Services/PrinterService.swift:128-157`,
   `Printing/ReceiptTemplates.swift`, `Printing/LabelRenderer.swift:59-110`):
   - **Columns:** drop SKU, name or price per `layout.show`. With price off,
     also drop the total foot and the "Total of priced items" line
     (`ReceiptTemplates.swift:204-212`).
   - **Status page only:** the compact tier prints the masthead label alone;
     the tall tier prints the masthead with no "YOUR ITEMS" and no total.
   - **Masthead QR** (`ReceiptTemplates.swift:46-99`, `:229-282`, `:263`):
     encode `layout.link.url`, captioned by `kind`:
     - `SKU_LOOKUP`: "Scan to check an item"
     - `SELLER_STATUS`: "Scan to track your items"
     - `SELLER_LOGIN`: "Scan to sign in and see your items"

     With no link, there's no QR and no caption.
5. **Offline** (the create misses its 2-second deadline and you print from
   local items): build the layout from `SwapRecord`.
   - **`SELLER_STATUS`,** with its page on: the `/s/<id>` URL you build today
     (`SellerDetailView.swift:735-736`).
   - **`SKU_LOOKUP`,** with its page on:
     `<sellerSiteBaseURL>/<org slug>/<swap slug>/status`. The org slug is the
     active membership's `orgSlug`.
   - **`SELLER_LOGIN`:** no QR. That link needs the receipt's token, which only
     the server has.
   - **A page that's off:** no link.
   - **Printing:** from `receiptPrintEnabled` and `receiptPaperSize`.
6. **Tests:** receipt rendering for each mode, toggle and link, the printing
   gates, and offline layout building.

## How we'll know

- **None:** the swap shows no Receipt menu on the iPad.
- **Status page only:** prints the masthead and its QR, and nothing else.
- **Price off:** an itemized receipt prints no prices and no total.
- **Link off:** a link whose page was turned off prints no QR.
- **Printing off:** the iPad offers no receipt Print. Email and Text remain.
- **Wrong paper:** a printer loaded with 50 × 30, on a swap that requires
  62 × 100, refuses to print a receipt and says why.
