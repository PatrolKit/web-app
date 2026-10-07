# Plan 42: Categories and item details in a CSV import

## Goal

A seller's spreadsheet can say what each item is. Alongside `ticket`, `name`, `price` and `description`, the CSV import takes a `category` column and one column per item detail (`Manufacturer`, `Model`, `Size`, `Length`, `Color`…). Each cell is matched against our categories and values, so imported items are described the way the iPad and the item form describe them: they show in "Items by category", filter by detail, and carry their answers.

Nothing is guessed and nothing is minted. A file with a category or value we don't have is refused at first, with every unknown listed and nothing written. Whoever uploaded it then fixes the file, or has the values added (globally or for the patrol) and uploads again, or chooses **Import anyway**, which imports the file without the unknowns.

Both uploads say what the file should hold, and offer three downloads built from the patrol's own categories: a **template** of headers only, an **example** with sample rows, and a **list of categories and details** spelled as the import expects them.

The first file through it is a shop's 1,128-item spreadsheet (BMBW, tickets 86828–88019), converted by a one-off script described at the end.

## What's already here

- **Two uploads, one importer.** Staff's "Import for a seller" (`ProxyItemImportModal.tsx` → `POST …/swaps/:swapId/items/import` → `ItemService.importForSeller`) and a shop's own upload (`TicketItemImportModal.tsx` → `POST …/seller/me/items/import` → `SellerSelfService.importItems`) share `LegacyTicketService.parseItemCsv`, `checkImportRows` and `ItemService.importItems`.
- **The CSV today:** `sku`/`ticket`, `name`, `description`, `price`, with aliases, case-insensitive. Unknown columns are ignored. No category or details: Plan 19 D12 left the CSV as free text.
- **Checked whole, then written.** Any row error refuses the file, with every error listed by line; otherwise the file is written in the same request.
- **Writing.** A ticket row fills in an issued ticket through `patch`; a row without a ticket is a `create`. Square follows in the background, in batches (`pushImported`).
- **Describing an item.** `patch` and `create` take `categoryId` and `attributes: { attributeId, valueId?, numberValue?, freeText? }[]`. `TaxonomyService.resolveAnswers` validates them against the org's tree and composes the name; `freeText` mints a new value. An explicit `name` (patch) or `printedName` (create) is kept as the name, with the answers stored alongside.
- **The tree.** Global categories plus the patrol's own. A detail is a select (a list of values, some with details of their own: Model under each Manufacturer, ski or snowboard details under a binding's Type) or a number (Length, Mondopoint, Flex), with an optional range and unit. `TaxonomyService.resolve(orgId)` returns the approved tree.

## Decisions

| # | Decision |
|---|---|
| D1 | **The format.** Two new kinds of column, both optional, both case-insensitive:<br>• `category`: one of the patrol's categories by its label. A trailing "s" is ignored, so "Ski boot" finds "Ski boots".<br>• **A detail column**, headed with the detail's label: `Manufacturer`, `Model`, `Size`, `Length`, `Mondopoint`, `Color`, `Gender`, `Condition`, `Bindings included`, `Style`, `Holds`…<br>A file without either imports exactly as today. |
| D2 | **Details are read per row, against the row's category.** One file can mix boots, skis and jackets. An empty cell, and a detail the row's category doesn't have, are skipped without comment. A column that's neither one of ours nor any category's detail ("NEW/USED?", "Colour") is ignored, as today, and named once in the result ("Ignored columns: …") so a typo can be spotted. |
| D3 | **Matching a value.**<br>• **Select:** the value's label, trimmed, case-insensitive. Approved values only, global and the patrol's.<br>• **Nested:** a detail that hangs under a value is matched only among that value's children, so a Model needs its Manufacturer on the row.<br>• **Number:** the leading number, read in the detail's unit ("163", "163cm", "24.5"). A cell marked in inches (`42"`, "42 in") is converted for a detail in cm (42" → 107). Outside the detail's range is unknown.<br>No aliases: "Rossi" doesn't find "Rossignol". |
| D4 | **Refused first, then Import anyway.** Two kinds of problem:<br>• **Row errors** (a bad or unknown ticket, a ticket that isn't this seller's, a price that isn't an amount, a ticket twice) refuse the file as today, with no override. The file has to change.<br>• **Unknowns** (an unknown category or value, a Model not under the row's Manufacturer, a number that isn't one or is out of range) also refuse the file, with nothing written, and are listed (D6). The upload then offers **Import anyway**: an unknown category leaves its row uncategorized, an unknown cell isn't stored, and everything else is written. The server takes the override as an `acceptUnknown` field on the same upload, and refuses unknowns without it.<br>The same rules apply to staff and to a shop's own upload. |
| D5 | **Never minted.** The importer never sends `freeText`, so no file creates a value, whoever uploads it. Adding values stays a deliberate act in Item details. |
| D6 | **What a refused upload shows.** Import checks the whole file first (parse, tickets, matching), so a refusal writes nothing and needs no separate check step. The result shows:<br>• row errors by line, as now;<br>• **unknowns grouped**: "Ski boots · Manufacturer · Alpina · 31 rows", "Skis · Model · Mantra 84 (Volkl) · 4 rows", "Category · Ski/Bdg · 2 rows", each expandable to its lines, with **Copy** to hand the list to whoever adds the values;<br>• ignored columns (D2);<br>• what Import anyway would write: "1,128 tickets described, 1,071 with a category; 37 values won't be saved".<br>Import anyway appears only for unknowns without row errors. |
| D7 | **The name.** A row's `name` stays the tag name, with the details stored alongside (ticket rows: `patch` with `name`; new rows: `create` with `printedName`). A row with a category and no `name` gets the composed name, as the item form does. A row with neither is `Item #<ticket>`, as today. |
| D8 | **Re-importing.** For staff, a row with a category replaces the ticket's category and details wholesale, as `patch` does. A row without a category leaves an existing description alone. A shop's own file still fills a ticket only once (Plan 38 D6). |
| D9 | **Speed.** The tree is read once per file. Matching is in memory, and the write path takes the matched ids without re-reading the tree per item. Target: 1,200 described rows in about 15 seconds locally. |
| D10 | **Who.** Unchanged: `ski_swap:manage` for staff's upload; a business seller for their own. |
| D11 | **The guide.** Both uploads show the same short guide above the file picker, collapsed after the first upload of a session:<br><br>*One row per item, with a header row. Column names can be in any case.*<br>• **ticket**: the number on the ticket, digits only. Required, unless you generate SKUs.<br>• **name**: what the tag says. Kept as you wrote it.<br>• **price**: in dollars, like 45 or 19.50. Can be blank for a ticket.<br>• **description**: notes buyers see under the name.<br>• **category**: one of our categories, like Ski boots.<br>• **details**: one column per detail, headed with its name (Manufacturer, Size, Color…), one value per cell, spelled as in our lists. A detail only counts for a category that has it.<br>*Leave a cell blank to skip it. Put quotes around anything with a comma in it. Columns we don't use are ignored. A category or value we don't know stops the upload and is listed; you can fix the file, or import anyway without them.*<br><br>Below it: **Download a template**, **Download an example** and **Download categories and details** (D12). |
| D12 | **Three downloads, built from the patrol's tree on request**, so they're always current and include the patrol's own categories and values.<br>• **Template (`items-template.csv`):** the header row only: `ticket`, `name`, `price`, `description`, `category`, then every detail any category has (34 today), most used first: Manufacturer, Model, Condition, Color, Gender, Size, Type, Length… A shop deletes the columns it doesn't need.<br>• **Example (`items-example.csv`):** the header and four sample rows (skis with bindings, ski boots, a jacket, poles) with realistic values (Rossignol, 170, Mondopoint 26.5, Patagonia, M…). A sample value the tree lacks is left blank and a sample category it lacks is dropped, so every value matches. Ticket numbers are placeholders (1001–1004).<br>• **Categories and details (`categories-and-details.csv`):** one row per detail: `category`, `detail`, `only when` (the parent answer of a nested detail, like "Manufacturer = Rossignol" or "Type = Skis"), `kind`, and `values` (joined with " \| ") or the number range with its unit ("70–215 cm"). |
| D13 | **Out of scope:** XLSX upload (staff convert to CSV), aliases for values, minting values from a file, and keeping what Import anyway dropped. Once values are added, staff re-import the file to give its items those details. |

## Server

### Matching (`ski-swap/import-details.ts`, new, pure)

- `matchImportDetails(headers, rows, taxonomy)` takes the parsed headers, the cells and the resolved tree. It returns per row `{ categoryId?, attributes: ItemAttributeInput[], unknown: { column, value, reason }[] }`, plus the file's ignored columns. `attributes` holds only what matched, so Import anyway writes it as it stands.
- Reasons: `unknown_category`, `unknown_value`, `needs_parent`, `out_of_range`, `not_a_number`.
- No database, no Nest: tested directly against a fixture tree.

### Parsing (`legacy-ticket.service.ts`)

- `parseItemCsv` keeps today's columns and also returns the header row and each row's cells for the matcher. Today's column names and aliases (`name`, `item`, `title`, `price`…) take precedence over any detail of the same name.

### Import (`item.service.ts`)

- `importItems(…, { acceptUnknown })` parses, checks tickets, then matches details against `taxonomy.resolve(orgId)`, read once.
  - **Row errors:** refuse, as today.
  - **Unknowns without `acceptUnknown`:** refuse, returning each row with outcome `'ok'` and its `unknown`, plus the ignored columns. Nothing is written.
  - **Otherwise:** write each row with its `categoryId` and matched `attributes` (ticket rows through `patch`, new rows through `create` with `printedName`), with `deferPos` as now.
- `patch` and `create` take an optional pre-read tree, which `resolveAnswers` uses instead of `visibleNodes` (D9).
- `ImportRowResult` gains `categoryId?` and `unknown?`. The response gains `ignoredColumns` and `refused: 'errors' | 'unknown' | null`.

### Downloads (`ski-swap/import-guide.ts`, new, pure)

- `templateCsv(taxonomy)`, `exampleCsv(taxonomy)` and `detailsCsv(taxonomy)` build D12's files. The four sample rows are fixed in this file, and each value is kept only if the tree has it.

### Routes

- Both import routes take `acceptUnknown` (`"true"`) on the same multipart body.
- `GET …/swaps/:swapId/items/import/template.csv`, `…/example.csv` and `…/details.csv` for staff (`ski_swap:manage`), and the same three under `…/seller/me/items/import/` for a shop. Each serves `text/csv` as an attachment, as the seller import template does (`seller.controller.ts`, `import/template`).

## Web

- **`ProxyItemImportModal.tsx`, `TicketItemImportModal.tsx`:** Import as now. A refused upload shows D6's panel.
  - **Import anyway** resends the same file with `acceptUnknown`. It confirms with the count of values that won't be saved.
  - Choosing a file again clears the result.
- **`ImportFileGuide.tsx`**, shared by both modals: the D11 copy and the three download links. It remembers being collapsed for the session.
- **`importedSummary`** adds "… with a category" when some rows had one.

## This shop's file (one-off, not committed)

A scratchpad script turns `BMBW_Swap_PRINTABLE_Master.xlsx` into a D1 CSV.

- **Rows:** the 1,128 not sold in store (rows with `SOLD` = LML are dropped). `ticket` is ITEM #; `price` is PRICE (87587 has none and stays unpriced); `name` is BRAND/MODEL plus size, as the shop wrote it (D7).
- **`category` from ITEM TYPE:**
  - Ski boots: Jr Boot, SKI BOOT, Adult Boot.
  - Poles: JR POLE, JR. POLE, Jr Pole, Ski Pole, Pole, Adult Pole.
  - Skis: every ski and ski-and-binding spelling.
  - Snowboard: SB w/Bind, SB Snowbrd + Bind, sb/bdg, SNOWBOARD, SNOWBOARD/BIND, SNOWBOARD/BDG.
  - Snowboard boots: SB BOOT.
  - Cross-country boots: XC BOOT.
  - Bindings, Type Snowboard: SNOWBOARD BDG, SB BDG.
  - Jacket: JACKET, JKT.
  - Base layer: BASE LAYER.
  - Mid layer: FLEECE PULLOVER (Type Fleece), MID LAYER.
  - Gloves: GLOVE, MITT.
  - Bag: SKI BAG, SNOWBOARD BAG.
- **Details:**
  - **Gender:** Kids for the Jr types.
  - **Bindings included:** Yes for ski and board types with a binding ("+ Bind", "/Bdg", or "w/" in the model).
  - **Style:** Mitten for MITT, Glove for GLOVE.
  - **Holds:** Skis or Snowboard for bags.
  - **Condition:** New for N, blank for U.
  - **MWK SIZE:** Mondopoint for ski boots; Length for skis, poles (in inches, converted by D3) and snowboards; Size for snowboard and cross-country boots, apparel, gloves and snowboard bindings.
  - **Manufacturer, Model, Color:** split from BRAND/MODEL against production's tree, read-only. Leading words match a manufacturer, then a model under it, then color words. A small table in the script expands the shop's abbreviations ("Blk", "Wht", "Rossi") and is shown for review.
- **Output:** the CSV, the type table, and the unknowns in D6's grouping, so values can be added before the real upload.

## Rollout

1. Build and test locally against a copy of the database, with the shop's converted file.
2. Deploy, after asking: the swap is live.
3. Issue tickets 86828–88019 to the shop, and take back the 64 sold in store.
4. Upload in production. Add the values it lists, or choose Import anyway.

## Tests

- **`import-details.spec.ts`:**
  - category by label, any case, trailing "s";
  - select values, any case;
  - a Model only under its Manufacturer;
  - numbers with units, inches to cm, and out of range;
  - a detail the row's category doesn't have, skipped;
  - columns that aren't ours or a detail, ignored and named once;
  - nothing minted (no `freeText` in the output).
- **Import:**
  - A file with unknowns is refused whole, with nothing written and its unknowns returned.
  - With `acceptUnknown` it imports: unknown categories leave rows uncategorized, unknown cells aren't stored, the rest is written.
  - Row errors refuse the file even with `acceptUnknown`.
  - Ticket rows `patch` with `categoryId`, `attributes` and the file's `name`; new rows `create` with `printedName`.
  - A row without a category leaves an existing description alone.
  - The tree is read once per file.
- **`import-guide.spec.ts`:**
  - The template has the base columns, then each detail once, most used first.
  - Every value in the example matches the committed `taxonomy.json`; values the tree lacks are blanked and a missing category's row is dropped.
  - The categories-and-details file gives nested details their "only when", and number ranges their units.
  - Commas and quotes in labels and values are escaped.
- **Web:** unknowns grouped by category, detail and value, with row counts.
- **Local timing:** the shop's 1,128 described rows within D9's target.
