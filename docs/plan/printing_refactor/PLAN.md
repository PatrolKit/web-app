# Printing Refactor — Margin Encapsulation

## Problem

Margin values (and the math that derives printable-area dimensions from them) leak into
application-level components. `SellerQrModal.tsx` and `DevicesPage.tsx` both:
- Assemble `PrinterMargins` objects by reading raw margin fields off a printer record
- Import and call `generate*` / `preview*` functions from `PhomemoPrinterService.ts` directly
- Duplicate the "extract margins from record or fall back to defaults" pattern

Margins are a printer hardware concern. Application code should not need to know about them.

---

## Target Architecture

### Principle

> Application components call a **print action** on the printer context.  
> The printer context owns margin extraction, paper size, preview-mode branching, and
> connection management.  
> `PhomemoPrinterService.ts` internal draw functions work in **printable-area coordinates**
> (origin at 0,0; canvas sized to the printable area). A compositor layer handles placement
> into the full raster.

### Printable-area canvas flow

```
app component
   │  calls printer.printItem(item) / printer.printQrLabel(name, url) / etc.
   ▼
PrinterContext
   │  resolves printer record → extracts margins + paperSize
   │  calls generate*(…) from PhomemoPrinterService
   ▼
PhomemoPrinterService._compose(drawFn, margins, paperSize)
   │  creates inner canvas (W_INNER × H_INNER)
   │  calls drawFn(innerCtx, W_INNER, H_INNER)   ← no margin knowledge needed here
   │  creates full canvas (320 × H)
   │  draws inner canvas at (marginLeft, marginTop)
   │  draws rotated branding in right margin
   │  returns rasterise(fullCtx, 320, H)
   ▼
ConnectedM110.print(rows)
```

### QR canvas ownership

`QRCode.toCanvas` is async and the correct canvas size depends on W_INNER (a margin-derived
value). Therefore the service owns QR canvas creation — `_drawQrLabel` receives a URL string
and calls `QRCode.toCanvas` internally with width = W_INNER. This makes `generateQrLabel`
(and `previewQrLabel`) async; all other generate/preview functions remain synchronous.

### Target printer vs. preferred printer

| Action | Printer source |
|---|---|
| Print item label | Preferred/connected printer (existing behaviour) |
| Print seller QR label | Preferred/connected printer |
| Print printer ID label | Specific `SwapPrinterRecord` passed as argument |
| Print calibration pattern | Specific `SwapPrinterRecord` passed as argument |

---

## Changes Required

### 1. `PhomemoPrinterService.ts`

**Internal draw functions — remove margins, work in printable-area coords**

| Current signature | New signature |
|---|---|
| `_drawPriceTagToCanvas(ctx, W, H, margins, item)` | `_drawPriceTag(ctx, W, H, item)` |
| `_drawPrinterLabelToCanvas(ctx, W, H, margins, name, org)` | `_drawPrinterLabel(ctx, W, H, name, org)` |
| `_drawQrLabelToCanvas(ctx, W, H, margins, name, qrCanvas)` | `_drawQrLabel(ctx, W, H, name, url)` (async; creates QR canvas internally) |

Inside each function: remove all references to `margins.*`; use `W` and `H` directly as the
printable dimensions. Remove any existing `_drawRotatedBranding` call — `_compose` handles it.

**New `_compose` function**

The single place where the full-canvas raster is assembled. Every label — price tag,
printer ID, seller QR — passes through here. Because `_compose` applies the rotated branding
automatically, **no draw function needs to call `_drawRotatedBranding`** (those calls are
removed as part of this refactor).

```ts
function _compose(
  drawFn: (ctx: CanvasRenderingContext2D, W: number, H: number) => void,
  margins: PrinterMargins,
  paperSize: PaperSize,
): boolean[][] {
  const fullW = HEAD_WIDTH_DOTS;
  const fullH = PAPER_SIZE_HEIGHT_DOTS[paperSize];
  const innerW = fullW - margins.marginLeft - margins.marginRight;
  const innerH = fullH - margins.marginTop - margins.marginBottom;

  // Draw label content into printable-area canvas
  const inner = document.createElement('canvas');
  inner.width = innerW; inner.height = innerH;
  drawFn(inner.getContext('2d')!, innerW, innerH);

  // Composite into full canvas
  const full = document.createElement('canvas');
  full.width = fullW; full.height = fullH;
  const ctx = full.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, fullW, fullH);
  ctx.drawImage(inner, margins.marginLeft, margins.marginTop);
  _drawRotatedBranding(ctx, fullW, fullH, margins); // applied once here for every label

  return rasterise(ctx, fullW, fullH);
}
```

An async variant `_composeAsync` handles the QR label (where the draw function is async).

**Updated public functions — internal use only (PrinterContext)**

```ts
// Synchronous (unchanged externally)
function generateLabel(item, paperSize, margins): boolean[][]
function generatePrinterLabel(printerName, orgName, paperSize, margins): boolean[][]
function previewLabel(item, paperSize, margins): string
function previewPrinterLabel(printerName, orgName, paperSize, margins): string
function generateCalibrationPattern(paperSize, margins): boolean[][]
function previewCalibrationPattern(paperSize, margins): string

// Async (QR canvas creation moves inside)
async function generateQrLabel(sellerName, url, paperSize, margins): Promise<boolean[][]>
async function previewQrLabel(sellerName, url, paperSize, margins): Promise<string>
```

These remain exported but are only imported by `PrinterContext.tsx`.

---

### 2. `PrinterContext.tsx`

**Helper: extract margins from a printer record**

```ts
function marginsFromRecord(p: SwapPrinterRecord): PrinterMargins {
  return { marginTop: p.marginTop, marginBottom: p.marginBottom,
           marginLeft: p.marginLeft, marginRight: p.marginRight };
}
```

**New context methods**

```ts
// Uses preferred/connected printer
printQrLabel(sellerName: string, url: string): Promise<void>

// Uses a specific printer record
printPrinterIdLabel(printer: SwapPrinterRecord, orgName: string): Promise<void>
printCalibration(printer: SwapPrinterRecord): Promise<void>
```

Each method:
1. Resolves the correct printer connection (same reconnect logic as `printItem`)
2. Extracts margins and paperSize from the printer record
3. Checks `previewMode` — if true, calls the corresponding `preview*` function and
   calls `setPendingPreview`; if false, generates the raster and calls `conn.print(rows)`

Add the three new method signatures to `PrinterContextValue`.

---

### 3. `SellerQrModal.tsx`

Remove:
- Import of `generateQrLabel`, `previewQrLabel`, `PrinterMargins`, `PaperSize` from
  `PhomemoPrinterService`
- Inline margin extraction
- Inline QR canvas creation

Replace `handlePrint` body with:
```ts
await printer.printQrLabel(seller.name, sellerUrl);
```

The modal retains its preview QR display (the `<canvas ref={canvasRef}>` used for the on-screen
QR preview is separate from the print path and stays as-is).

---

### 4. `DevicesPage.tsx`

Remove:
- Imports of `generatePrinterLabel`, `previewPrinterLabel`, `generateCalibrationPattern`,
  `previewCalibrationPattern`, `DEFAULT_PRINTER_MARGINS`, `PrinterMargins` from
  `PhomemoPrinterService`
- Inline margin extraction in both `printPrinterLabel` and `printCalibration` callbacks

Replace with:
```ts
// Print ID label for a specific printer
await printer.printPrinterIdLabel(printerRecord, org?.name ?? orgId);

// Print calibration for a specific printer
await printer.printCalibration(printerRecord);
```

`DevicesPage` still reads and edits margin values (via `editMargins` state and `patchPrinter`
API calls) — this is configuration UI, not printing logic, and is unaffected.

---

## Out of scope

- `api.types.ts` / `api.ts` margin fields: these represent the stored printer configuration
  and are correct to remain in the API layer.
- The calibration pattern draw function (`generateCalibrationPattern`) uses manual dot-level
  rendering, not the canvas API, and cannot easily use `_compose`. It should keep its current
  full-canvas approach internally; `printCalibration` in the context just calls it with margins
  extracted from the record.
- No changes to the API, database, or server code.
