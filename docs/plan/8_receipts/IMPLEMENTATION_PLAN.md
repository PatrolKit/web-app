# Receipt Printing — Web Implementation Plan

Replaces the existing "Receipt" button on the SkiSwap sellers page (which currently only prints a seller QR label) with a full receipt: one header label followed by one or more item-list labels, matching the iOS output exactly.

---

## Reference

- **iOS label generator:** `patrolkit_ios/PatrolKit/Printing/LabelGenerator.swift` — `generateReceiptHeaderLabel` / `generateReceiptItemLabels`
- **Existing web printer service:** `server/apps/web/src/lib/printing/PhomemoPrinterService.ts`
- **Printer context:** `server/apps/web/src/contexts/PrinterContext.tsx`
- **Sellers page:** `server/apps/web/src/pages/ski-swap/SellersPage.tsx`
- **Current modal (to be replaced):** `server/apps/web/src/pages/ski-swap/SellerQrModal.tsx`

---

## What Changes

| File | Change |
|---|---|
| `PhomemoPrinterService.ts` | Add `generateReceiptHeaderLabel`, `generateReceiptItemLabels`, and their preview variants |
| `PrinterContext.tsx` | Add `pendingPreviews: string[]` to the context interface; add `printReceipt(seller, items, orgLogoUrl?)` method |
| `SellersPage.tsx` | Wire "Receipt" button to new modal instead of `SellerQrModal` |
| `SellerQrModal.tsx` | Replaced by `PrintReceiptModal.tsx` |
| `PrintReceiptModal.tsx` | New file — fetches items and org logo, shows summary, triggers print |

The seller QR label (`generateQrLabel`) is unaffected; the receipt header embeds the QR code directly.

---

## 1. Label Layouts

### 1.1 Header Label

Single 30 mm label.

```
┌──────────────────────────────────────┬────┐
│  [logo 64×64]   date (right-aligned) │    │
│                 seller name (bold)   │ B  │
│                 phone                │ R  │
├──────────────────────────────────────┤ A  │
│  Scan to track  │  [QR code ~96px]   │ N  │
│  your items:    │                    │ D  │
└─────────────────┴────────────────────┴────┘
```

**Top half:**
- Left: org logo bitmap (64×64 dots), vertically centered. Omitted if no `orgLogoUrl`. Logo is fetched, composited on white, and thresholded at luminance < 200; SVGs are skipped.
- Right: date → seller name (bold) → phone, right-aligned to the content area's right edge, block vertically centered.

**Divider:** Full-width line at `halfH`.

**Bottom half:**
- Right: QR code, `min(96, bottomAvail - 8)` dots, right-anchored 8 dots from content right edge, vertically centered.
- Left: "Scan to track" / "your items:" (14 px bold), vertically centered in the space left of the QR.

**QR URL:** `${SELLER_SITE_URL}/s/${seller.id}`

**Font sizes (all bold):** Date 16 px · Seller name 18 px · Phone 16 px · "Scan to track…" 14 px

### 1.2 Item Labels

One or more 30 mm labels; items packed greedily per page.

```
┌─────────────────────────────────────────┬────┐
│ Your Items:  (first page only, centred) │    │
├─────────────────────────────────────────┤    │
│ Item Name             $12.00            │ BR │
│   SS-A-0001                             │ AN │
├─────────────────────────────────────────┤ D  │
│ Another Item          $8.50             │    │
│   SS-A-0002                             │    │
└─────────────────────────────────────────┴────┘
```

**Per-item row:**
- Line 1: name (18 px bold, left-aligned) + price (18 px bold, right-aligned), same baseline.
- Line 2: SKU (14 px bold), indented 4 dots from left margin.
- Gap: 2 dots between lines 1 and 2; 4 dots between items.

**Header:** "Your Items:" (16 px bold, centred) on first page only, 6 dots above the first item.

**Row height** is measured at runtime from sample text, not hardcoded.

---

## 2. `PhomemoPrinterService.ts` Changes

### 2.1 New internal draw functions

Following the same pattern as all existing `_draw*` functions — they receive content-area dimensions `(ctx, W, H, ...data)` and draw into that space; the compositor handles margins and the branding strip.

```ts
async function _drawReceiptHeader(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  orgLogoUrl: string | null,
  date: string,
  sellerName: string,
  phone: string,
  qrUrl: string,
): Promise<void>

function _drawReceiptItems(
  ctx: CanvasRenderingContext2D,
  W: number, H: number,
  items: { name: string; sku: string; priceCents: number }[],
  showHeader: boolean,
): { rowsDrawn: number }
```

`_drawReceiptItems` returns how many items it drew; the public paginator calls it repeatedly with `items.slice(offset)` until all items are placed.

`_drawReceiptHeader` is wired through `_composeAsync` / `_composePreviewAsync` (async, due to the org logo fetch and QR render). `_drawReceiptItems` uses `_compose` / `_composePreview` (sync).

**QR code:** `QRCode.toCanvas(offscreenCanvas, qrUrl, { width, margin: 0, color })` → `ctx.drawImage(...)`, following the same pattern as `_drawQrLabel`.

**Org logo:** `fetch(orgLogoUrl)` → `createImageBitmap` → draw onto an offscreen canvas at 64×64 → apply luminance threshold (`< 200`). Skip silently if the fetch fails or the content type is `image/svg+xml`.

**Right-alignment helper:** Add `drawTextRightAligned(ctx, text, rightX, y)` — draws at `rightX - ctx.measureText(text).width`.

**Font strings:** Set inline as `ctx.font = \`bold Npx ${SANS}\`` where `const SANS = '"Helvetica Neue", Helvetica, Arial, sans-serif'` is defined at the top of each draw function, matching the existing pattern.

### 2.2 New public functions

```ts
export async function generateReceiptHeaderLabel(
  orgLogoUrl: string | null,
  date: string,
  sellerName: string,
  phone: string,
  qrUrl: string,
  paperSize: PaperSize,
  margins: PrinterMargins,
): Promise<boolean[][]>

export function generateReceiptItemLabels(
  items: { name: string; sku: string; priceCents: number }[],
  paperSize: PaperSize,
  margins: PrinterMargins,
): boolean[][][]

export async function previewReceiptHeaderLabel(
  orgLogoUrl: string | null,
  date: string,
  sellerName: string,
  phone: string,
  qrUrl: string,
  paperSize: PaperSize,
  margins: PrinterMargins,
): Promise<string>

export function previewReceiptItemLabels(
  items: { name: string; sku: string; priceCents: number }[],
  paperSize: PaperSize,
  margins: PrinterMargins,
): string[]
```

---

## 3. `PrinterContext.tsx` Changes

### 3.1 Extend the context interface

The existing `pendingPreview: string | null` is a single slot, insufficient for a multi-page receipt. Add a parallel array:

```ts
pendingPreviews: string[];
setPendingPreviews(pages: string[]): void;
clearPendingPreviews(): void;
```

### 3.2 New `printReceipt` method

```ts
printReceipt: (
  seller: SellerResponse,
  items: { name: string; sku: string; priceCents: number }[],
  orgLogoUrl: string | null,
) => Promise<void>
```

Implementation:

1. Resolve preferred printer (same guard as existing print methods — early return if none connected).
2. Get `paperSize` and margins via the existing `marginsFromRecord(preferredPrinter)` helper.
3. Build `date` as `new Date()` formatted `"MMM D, YYYY"`.
4. Build `qrUrl` as `` `${SELLER_SITE_URL}/s/${seller.id}` `` (import from `../../lib/sellerSiteUrl`).
5. **Print path:** `await generateReceiptHeaderLabel(...)` → `conn.print(headerRows)`; then `generateReceiptItemLabels(...)` → for each page: `conn.print(pageRows)`.
6. **Preview path:** `await previewReceiptHeaderLabel(...)` and `previewReceiptItemLabels(...)` → `setPendingPreviews([headerDataUrl, ...pageDataUrls])`.

---

## 4. `PrintReceiptModal.tsx` (new file)

**Props:** `seller: SellerResponse | null`, `swapId: string | null`, `onClose: () => void`

`orgId` comes from `useOutletContext<SkiSwapContext>()`.

**Behaviour:**
1. When `seller` becomes non-null, run two parallel queries (both `enabled: !!seller`):
   - Items: `api.skiSwap.listItems(orgId, swapId, { sellerId: seller.id })`
   - Org logo: `api.orgs.get(orgId)` — `AppShell` already populates this cache entry, so it is a cache hit in normal use.
2. Show a loading spinner while either query is pending.
3. On success, display a summary: seller name, item count, total value.
4. "Print Receipt" button calls `printReceipt(seller, items, org.logoUrl)` from `PrinterContext`.
5. Disable the button while printing; show a spinner.
6. On completion, close the modal.
7. Error state: show inline error with a retry button.

No print preview in the modal itself — the existing preview mode in `PrinterContext` handles that globally.

---

## 5. `SellersPage.tsx` Changes

- Replace `qrSeller` state + `SellerQrModal` with `receiptSeller` state + `PrintReceiptModal`.
- Also destructure `selectedSwap` from the outlet context (currently only `orgId` and `perms` are pulled).
- `SellerQrModal` import is removed.

```tsx
// Before
const { orgId, perms } = useOutletContext<SkiSwapContext>();
const [qrSeller, setQrSeller] = useState<SellerResponse | null>(null);
<button onClick={() => setQrSeller(s)}>Receipt</button>
<SellerQrModal seller={qrSeller} onClose={() => setQrSeller(null)} />

// After
const { orgId, perms, selectedSwap } = useOutletContext<SkiSwapContext>();
const [receiptSeller, setReceiptSeller] = useState<SellerResponse | null>(null);
<button onClick={() => setReceiptSeller(s)}>Receipt</button>
<PrintReceiptModal seller={receiptSeller} swapId={selectedSwap?.id ?? null} onClose={() => setReceiptSeller(null)} />
```

---

## 6. Implementation Order

1. **`PhomemoPrinterService.ts`** — add `_drawReceiptHeader`, `_drawReceiptItems`, and the four public functions. Test in preview mode before touching any UI.
2. **`PrinterContext.tsx`** — add `pendingPreviews` to the interface and state, then add `printReceipt`. Verify preview mode shows header + item pages.
3. **`PrintReceiptModal.tsx`** — build the modal with fetch + summary + print button.
4. **`SellersPage.tsx`** — swap the state/modal pair; smoke-test the full flow.

---

## 7. Out of Scope

- Printing seller QR labels separately (that flow is already accessible via the printer management screen).
- PDF/email receipt generation.
- Receipt history or reprint tracking.
