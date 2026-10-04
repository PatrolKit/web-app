# Plan 36: Receipt settings per swap

## Goal

The swap settings dialog gains a **Receipts** tab that decides, per swap, what a
seller's receipt is:

- **Itemized:** a line per item, with toggles for **SKU**, **Description** (the
  item's name) and **Price**, plus an optional **Link to status page**.
- **Status page only:** no items, just the **Link to status page**.
- **None:** no receipt at all.

The link offers the swap's status pages that are switched on (Plan 33), plus
None. It's disabled when no status page is on.

Two more settings on the tab apply to Itemized and Status page only:

- **Allow printing:** whether receipts are printed at all. When it's on, a
  **Paper size** dropdown names the stock receipts must print on: 62 × 100 mm
  (tall) or 50 × 30 mm (compact). When it's off, no receipt printing is offered
  anywhere, the iPad included. Receipts are still emailed, texted and shown at
  `/r/`.
- **Fine print:** an optional short rich-text section, in a callout above the
  separator before "A copy of this receipt lives at", in the email and on the
  receipt page.

Every place a receipt appears follows these settings:
- the email and text sent at check-in;
- the public receipt page (`/r/<token>`);
- receipts the station bridge prints;
- receipts the web prints over Bluetooth;
- receipts the iPad prints.

The iPad's part is in [IPAD_HANDOFF.md](IPAD_HANDOFF.md).

## Decisions

| # | Decision |
|---|---|
| D1 | **"Description" is the item's name**, the line's main text today, not the notes field. |
| D2 | **A status-page link resolves when the receipt is shown, never when it's made.** If the chosen page has since been turned off, the receipt shows no link rather than a dead one. A status-only receipt then says the swap's status page isn't available. |
| D3 | **Where each link goes:** |
| | • **SKU Lookup:** `skiswap.patrolkit.io/<org>/<slug>/status`. |
| | • **Seller Status:** straight to the seller's own `/s/<sellerId>`, as receipts link today. It's their receipt, so there's no email + last-4 step. |
| | • **Authenticated Seller Status:** the sign-in page with their email ready, `patrolkit.io/app/auth/login?r=<receipt token>`. The page shows "Sign in as d•••@example.com" and one button, which emails a sign-in link to the seller's verified email as usual; they land on My Items. |
| | The email is never in the URL, because a receipt link is printed as a QR code and forwarded. Nor is the token a credential: it can only *send* a sign-in link to the seller's own inbox, never sign anyone in. |
| D4 | **None means no receipt anywhere:** |
| | • nothing is printed, emailed or texted; |
| | • check-in skips its receipt step; |
| | • staff aren't offered a Receipt button; |
| | • creating or sending one is refused with `RECEIPTS_OFF`. |
| D5 | **Pages follow the current setting.** A `/r/<token>` page already handed out shows what the swap's settings say now: fewer columns, another link, or "Receipt not available" under None. The `Receipt` row keeps its frozen items, and the settings apply at render time. |
| D6 | **Status page only needs a link.** The option is disabled until a status page is on, and the server refuses it with link None, because a receipt with nothing on it is no receipt. |
| D7 | **An itemized line needs something to name it:** SKU, name, or both. Price off removes prices and totals everywhere, including "Total" and "N with price to come". |
| D8 | **The payout line ("Payment goes to …") stays** on Itemized and Status page only receipts. It's about the seller, not the items. |
| D9 | **Defaults:** |
| | • **A new swap:** Itemized, all three toggles on, link None, printing allowed on 62 × 100 mm, and fine print off. No status page is on by default. |
| | • **Existing swaps:** the same, except the link is Seller Status where that page is on, because receipts link to `/s/` today. BMBWAV's swap has Seller Status off, so its link becomes None. |
| D10 | **Allow printing governs receipts only.** Item tags and helper labels stay with the Tickets settings, and the seller QR label is unchanged. With it off, every receipt-printing option is hidden and refused: check-in's printed receipt, the staff Print button, and the iPad's Print. |
| D11 | **The paper size is required, not preferred.** Only the two receipt stocks are offered; 25 × 67 helper stock can't carry a receipt. A receipt sent to a printer with other stock is refused, saying why: "This swap prints receipts on 62 × 100 mm labels; this printer has 50 × 30." At self check-in, nothing prints and the seller is told their receipt couldn't print there; it's still emailed. |
| D12 | **Fine print appears only in the email and on the receipt page.** It's left out of the text message, and off paper: formatting and links can't print, and a compact receipt has no room. It shows only while its toggle is on. Turning the toggle off keeps the text, so turning it back on restores it. |
| D13 | **Fine print is a small, safe subset of HTML:** paragraphs, line breaks, bold, italic, links (`http`, `https` and `mailto` only), and bulleted and numbered lists. It's sanitized on save and again when rendered, so nothing else can reach an email or the page. It holds at most 2,000 characters of text. |

## Server

### Schema (migration `…_receipt_settings`)

**`SkiSwap` gains:**

| Column | Type and default | Values |
|---|---|---|
| `receiptMode` | `String @default("ITEMIZED")` | `ITEMIZED`, `STATUS_ONLY`, `NONE` |
| `receiptShowSku` | `Boolean @default(true)` | |
| `receiptShowName` | `Boolean @default(true)` | |
| `receiptShowPrice` | `Boolean @default(true)` | |
| `receiptLink` | `String @default("NONE")` | `NONE`, `SKU_LOOKUP`, `SELLER_STATUS`, `SELLER_LOGIN` |
| `receiptPrintEnabled` | `Boolean @default(true)` | |
| `receiptPaperSize` | `String @default("62x100")` | `62x100`, `50x30` |
| `receiptFinePrintEnabled` | `Boolean @default(false)` | |
| `receiptFinePrint` | `String? @db.Text` | sanitized HTML |

**Backfill (D9):** `receiptLink = 'SELLER_STATUS'` where `sellerLookupEnabled`.

### Contracts and the swap service

- **Schemas:** `CreateSwapSchema`, `PatchSwapSchema` and `SwapResponseSchema`
  gain the nine fields.
- **Refused on save:**
  - `STATUS_ONLY` with link `NONE` (D6);
  - `ITEMIZED` with SKU and name both off (D7);
  - a paper size other than `62x100` or `50x30` (D11);
  - fine print turned on with no text, or over 2,000 characters (D13).
- **Allowed on save:** a link to a page that's off. D2 covers it at render,
  and the dialog warns.
- **Fine print** is sanitized with an allowlist (`sanitize-html`): `p`, `br`,
  `strong`, `em`, `a[href]` (`http`, `https` and `mailto`), `ul`, `ol` and
  `li`.

### One resolver (`receipt-layout.ts`, new)

**`receiptLayout(swap, receipt)`** decides everything a renderer needs, so no
channel decides for itself:

```ts
{ mode: 'ITEMIZED' | 'STATUS_ONLY' | 'NONE',
  show: { sku, name, price },
  link: { url: string, kind: 'SKU_LOOKUP' | 'SELLER_STATUS' | 'SELLER_LOGIN' } | null,
  print: { paperSize: '62x100' | '50x30' } | null,   // null: printing off, or NONE
  finePrint: string | null }                         // sanitized HTML; null when off
```

- **`link`** is null for link `NONE` and for a page that's off (D2).
- **URLs** are built per D3 from `sellerSiteUrl`, `appUrl`, the org and swap
  slugs, the seller id and the receipt token.

### Receipts (`receipt.service.ts`, `receipt-templates.ts`, `receipt.controller.ts`)

- **`createFor`, `currentFor` and `send`:** refused under `NONE` with
  `409 RECEIPTS_OFF`, "This swap doesn't give receipts."
- **`view()` / `byToken`:**
  - The response carries the layout, and `link` takes the place of `trackUrl`.
  - Under `NONE`, `byToken` is the same 404 as a revoked receipt (D5).
  - `PublicReceiptResponse` declares the layout. That also closes the gap
    where `trackUrl` was returned but not declared.
- **`receiptEmail`:**
  - **Itemized:** columns follow the toggles. Price off also drops the total
    row.
  - **Status page only:** no table, just "Your items are checked in." and the
    link button.
  - **Link button:** labeled by kind: "Check an item", "Track your items", or
    "Sign in to see your items". There's no button without a link.
  - **Fine print:** a callout, tinted like the payout panel in light and dark,
    above the separator before "A copy of this receipt lives at".
    - It's sanitized again on render and given inline styles, since mail
      clients strip `<style>`.
    - The plain-text part carries it, through `plainText`.
- **`receiptSms`:**
  - **Itemized:** links to `/r/` as now, without the total when price is off.
  - **Status page only:** carries the status link instead, e.g. "<org>: your
    <swap> items are checked in. Track them: <link>".

### Check-in finish (`checkin.service.ts`)

- **Under `NONE`:** no snapshot, no print jobs and no auto-email. The response
  says `receipt: 'none'`.
- **Otherwise:** it works as now, through the layout. The response says
  `receiptPrinted: false` with the reason's code (`RECEIPT_PRINT_OFF` or
  `RECEIPT_PAPER`) when printing is off or the station's paper doesn't match
  (D10, D11), and `receiptLink`, the layout's link, for the finish screen.
- **The station's public context** gains `receiptPrints`, so the items step can
  say "print my receipt" only when one will.
- **The auto-email's idempotency key** includes the layout, so a setting
  changed between two finishes sends the new receipt.

### Printing (`print-queue.service.ts`, `print-recipe.service.ts`, `label-templates.ts`)

**Gates:** a receipt prints only when the mode isn't `NONE`, printing is
allowed, and the printer's paper is the swap's `receiptPaperSize`.
- **`enqueueReceipt`** (check-in finish, staff printing through a station)
  queues nothing otherwise.
- **`printDrawn`:** a drawn `receipt` is refused with `RECEIPTS_OFF`,
  `RECEIPT_PRINT_OFF` or `RECEIPT_PAPER`, beside `TAGS_OFF`. The paper message
  names both sizes.
- **The render endpoint** (`printers/:id/labels`, used by the web's Bluetooth
  print): `receipt_header` and `receipt_items` are refused the same way,
  against that printer's paper.
- **A queued job** whose swap has since stopped allowing it is settled
  unprinted at claim.

**Layout:**
- **`receipt_header`** takes a `swapId`. The web sends only `sellerId` today,
  so the recipe can't read the swap's settings.
- **Masthead QR:** encodes `layout.link.url`, captioned per kind ("Scan to
  check an item", "Scan to track your items"). There's no QR without a link.
- **Items:** lines drop SKU, name or price per the layout. With price off, the
  tall tier has no total foot.
- **Status page only:** the compact tier prints the header label alone; the
  tall tier prints one masthead page without "YOUR ITEMS" or a total.
- **The seller QR label** (`qr` recipe) is unchanged.

### Sellers (`seller.service.ts`)

- **`receiptSwapsFor`** lists only swaps whose mode isn't `NONE`, so the staff
  Receipt button and its swap picker follow D4. Each carries `printPaperSize`,
  null when that swap doesn't print receipts, for the staff Print button.

### Signing in from a receipt (D3)

- **`GET public/receipts/:token/sign-in`** answers `{ emailHint }`, e.g.
  `d•••@example.com`, when all of these hold:
  - the swap's link is `SELLER_LOGIN`;
  - Authenticated Seller Status is on;
  - the seller has a verified email.

  Otherwise it's a 404. It's limited by `public.reads`.
- **`POST auth/login { receiptToken }`** sends a sign-in link to that seller's
  verified email.
  - It's subject to the sign-in policy (Plan 33) and the usual send limits.
  - It answers like any login request, decoy included.
  - It never reveals the address beyond the hint.

## Web

### Receipts tab (`SwapSettingsModal.tsx`, `swapSettingsForm.ts`)

**Placement:** a fourth tab, after Status Page, on create and edit:
- **Itemized** (radio), with SKU, Description and Price toggles and the link
  dropdown.
- **Status page only** (radio), with the link dropdown.
- **None** (radio).
- **Allow printing** (toggle), with a **Paper size** dropdown when it's on:
  "62 × 100 mm (tall)" or "50 × 30 mm (compact)". Shown for Itemized and Status
  page only.
- **Fine print** (toggle), with a rich-text editor when it's on. Shown for
  Itemized and Status page only.

**Link dropdown:** one setting, shown under whichever radio is chosen.
- **Options:** the status pages switched on, plus None. It follows the Status
  Page tab's toggles in the same dialog as they change.
- **When no status page is on:** disabled, with "Turn on a status page to link
  to it".
- **A stored choice whose page is now off:** "That page is off, so receipts show
  no link" (D2).

**Fine print editor:** Tiptap, limited to D13's marks and nodes, so it can't
produce anything the server would strip.
- **Toolbar:** bold, italic, link, bulleted list and numbered list.
- **Count:** characters, against the 2,000 limit.
- **Preview:** a link showing the callout as it will look on the receipt page.
- It loads only with the dialog.

**Rules shown before saving:**
- Status page only is disabled until a status page is on (D6).
- Itemized with SKU and name both off says so (D7).

**Save:** the dialog's one save, with `changes()` covering the nine fields.

### Other web surfaces

- **`ReceiptPage.tsx`:**
  - **Layout:** columns per toggle, no table for status-only, and the link
    labeled by kind.
  - **Fine print:** in a callout above the "A copy of this receipt" foot,
    rendered from the server's sanitized HTML.
  - **Under `NONE`:** "Receipt not available".
- **`LoginPage.tsx`,** given `?r=<token>`:
  - It asks `public/receipts/:token/sign-in`.
  - **With a hint:** "Sign in as d•••@example.com" and one button, which posts
    `{ receiptToken }` and then shows "Check your email", as for any sign-in.
  - **With a 404:** the ordinary sign-in form.
- **Self check-in:**
  - **`ItemsStep`:** the button says "I'm done — print my receipt" only when a
    receipt will print; otherwise "I'm done".
  - **`FinishStep`:**
    - **Under `NONE`:** no receipt copy and no Email or Text buttons.
    - **Printed:** "printing at this station" only when it did. "Your receipt
      couldn't print here" when the paper didn't match; the email still goes.
    - **Status link:** follows the layout, replacing the hard-wired `/s/` at
      `:157`.
- **`PrintReceiptModal` / `PrinterContext.printReceipt`:**
  - It sends `swapId` with `receipt_header`.
  - It's unreachable under `NONE`, through `receiptSwaps`.
  - **Printing off:** Email and Text only, no Print.
  - **Printer on other stock:** Print is disabled, with D11's reason.

## Rollout

1. **Migration:** nine additive columns and one backfill. Every swap gets
   printing on, 62 × 100 mm. Ask "migrate in place" at deploy, per the go-live
   rule.
2. **What changes at deploy:**
   - **Links:** receipts look as they do today, apart from these. Under D9, a
     swap with Seller Status off, BMBWAV's included, gives receipts with no link
     or QR, instead of a QR to a page that's off.
   - **Paper:** receipts print only on 62 × 100 stock. A printer loaded with
     50 × 30 stops printing BMBWAV's receipts until the size is changed in the
     dialog.
   - **iPad:** an iPad on today's build keeps printing its own way until it
     updates.
3. **Verify on production** with `smoke-receipt-settings.mjs`, in the smoke org
   only:
   - **Each mode:** create, send (email suppressed), `/r/`, and check-in finish.
   - **Rendering:** `receipt_header` and `receipt_items` per mode through the
     render endpoint. They're refused with printing off and on the other paper.
   - **Links:** each kind's URL, and D2 after turning a page off.
   - **Receipt sign-in:** the hint, and its 404 when not applicable.

## Tests

- **`receiptLayout`:** every mode × link × page on and off.
- **Save rules:** D6, D7, D11 and D13.
- **Fine print sanitizing:** allowed tags kept; scripts, styles, attributes,
  `javascript:` links and other tags stripped.
- **`receiptEmail` / `receiptSms`:** each mode, toggle and link kind. Fine print
  appears in the email and not the text.
- **`byToken`:** follows the current setting, and is a 404 under `NONE`.
- **Check-in finish:**
  - under `NONE`: no jobs, no email;
  - printing off or the wrong paper: the reason it didn't print.
- **Printing gates:** `enqueueReceipt`, `printDrawn` and the render endpoint
  each refuse `NONE`, printing off, and mismatched paper.
- **Recipes:** the masthead QR per link, and status-only on both tiers.
- **Receipt sign-in:** the hint's conditions, and `auth/login { receiptToken }`
  sending only to the verified email and answering like any login.
- **Web:** the Receipts tab's rules, and the link dropdown following the Status
  Page toggles.
