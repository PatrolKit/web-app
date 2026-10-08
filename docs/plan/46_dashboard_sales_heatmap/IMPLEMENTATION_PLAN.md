# Plan 46: Sales by hour, an Items bar, and sold by category

## Goal

Three changes to the swap dashboard:

- **Items** becomes a short stacked bar, like the Sellers tile, and joins the top row as a third tile.
- **Check-ins by hour** moves to the left. A new **Sales by hour** heat map takes its old place on the right. It reads like Check-ins by hour (days across, hours down, each cell as solid as it's busy), with an **Items / Dollars** toggle.
- **Items by category** stays a bar chart, and each bar gains a **sold** layer filled in from the bottom.

The dashboard, top to bottom:

1. **Tiles:** Sellers · Consigned value · **Items**
2. **Heat maps:** Check-ins by hour · **Sales by hour**
3. **Items by category**, with sold, at full width

## What's already here

- **`SkiSwapDashboard.tsx`:**
  - two tiles (`grid-cols-2`): `SellersTile` (a total, an `h-2.5` stacked bar, a legend) and Consigned value;
  - then `ItemsPieCard` and `CheckinsHeatmapCard` (`lg:grid-cols-2`);
  - then `CategoriesChartCard` at full width, then the issue cards.
- **The Items pie:**
  - **Server:** `ItemBreakdownService.getItemBreakdown` returns sold, returned, for sale, no price, no description, not on sale, and the total.
  - **Sales:** read from Square with `PosAdapter.listSales`, one paged `orders.search` of completed orders, 200 a page. They're cached for two minutes per swap, but only as units sold per variation (`soldByVariation`).
  - **Web:** `itemsPie.ts` holds the slices' order, labels and colors (`pieSlices`, `percent`).
- **Sale lines:** each `PosSaleLine` has `orderId`, `variationId` (our `squareVariationId`), `quantity`, `collectedCents` (after discounts), `refundedQuantity` and `soldAt` (`closedAt`).
- **Check-ins by hour:**
  - **Server:** `StatsService.getCheckinsHeatmap` buckets by `dayIn` and `hourIn` (`checkins-per-day.ts`) in the swap's `timeZone`.
  - **Web:** `checkinsHeatmap.ts` holds `heatView`, `opacity`, `dayLabel` and `hourLabel`.
- **Items by category:**
  - **Server:** `StatsService.getCategoryCounts` returns `{ categories: [{ categoryId, label, count }], uncategorised }` for live items, busiest first, without the catch-all "Other".
  - **Web:** `CategoriesChartCard` draws teal columns up to 80px tall: the count on top, the category's icon and name underneath.
- **Quantity:**
  - imports always create quantity 1;
  - only the item form can make one higher;
  - production's 3,987 live items are all quantity 1.

## Decisions

| # | Decision |
|---|---|
| D1 | **One Square read serves everything that shows sales.** The two-minute cache keeps Square's sale **lines**, not per-variation totals. It feeds the Items bar's sold count (as now), Sales by hour, and sold per category. Whichever card asks first once the two minutes are up triggers the read, and the rest reuse it, so nothing here adds a Square call. Each of these cards says "Sales from Square as of 2:14 PM". |
| D2 | **Only this swap's sales count.** A line counts when its `variationId` matches one of this swap's items' `squareVariationId`, including deleted and returned items, since a sale is a sale. Anything else rung up at that Square location (concessions, another swap) is left out. The same lookup gives each sale its item's category (D6). |
| D3 | **Items: a stacked bar in the third tile,** styled like the Sellers tile.<br>• **Content:** the label and total ("Items 1,248"), one `h-2.5` bar in the pie's colors and order (Sold, Returned, For sale, No price, No description, Not on sale), and a wrapping legend of colored squares with counts. A segment's tooltip gives its count and percent. "Sales from Square as of" sits in small text under the legend.<br>• **If Square can't be read:** the legend says so in amber, and the bar shows everything except Sold.<br>• **Layout:** three tiles at `md` and wider; two, then one, on narrower screens. |
| D4 | **Sales by hour mirrors Check-ins by hour,** minus the individuals/businesses chips, since a sale has no seller kind.<br>• **Items** is units sold, `quantity − refundedQuantity`.<br>• **Dollars** is what the register took: `collectedCents` less the refunded share (`collectedCents × refundedQuantity / quantity`), the same money payouts use. Cells show whole dollars ("$1,240"); tooltips show cents.<br>• **Time:** each sale's `soldAt`, bucketed in the swap's time zone with the same `dayIn`/`hourIn` as check-ins. The grid shows only days and hours with sales.<br>• **Color:** the green the Items bar uses for Sold, so the two heat maps read as different things side by side.<br>• **Empty and error states:** "No sales yet"; Square's error in amber when it can't be read. |
| D5 | **The heat maps share one grid component.** It covers the cells, the totals along the top and right, and the Fewer/More key, and takes a color, a value function and a formatter. Check-ins by hour looks exactly as it does now. |
| D6 | **Each category bar shows how much has sold.**<br>• **The column:** it stays the category's total. A solid fill from the bottom is the sold part; the rest of the column is a lighter tint of the same color.<br>• **Labels:** "38 / 112" (sold / total) above; the percent in the tooltip.<br>• **Units:** columns and sold are both counted in units. That matches today's item counts, since every item is quantity 1, and stays right if a larger quantity ever appears.<br>• **Sold:** units sold less refunds, with each sale line assigned to its item's **current** category (D2). An item categorized after it sold counts under that category.<br>• **Header:** "38 sold of 1,248 in these categories · 230 without a category".<br>• **Square down:** the counts come from our own rows in their own request, and sold follows in a second one. When Square can't be read, the bars still draw, without the sold layer, and the header says sales couldn't be read. |

## Server

- **`item-breakdown.service.ts`:**
  - `sales()` caches `{ at, lines: PosSaleLine[] }`; `getItemBreakdown` derives `soldByVariation(lines)` as before.
  - **`salesHeatmap(orgId, swapId)`** returns `{ days, hours, cells: [{ date, hour, units, cents }], totals: { units, cents }, timeZone, asOf, error }`.
  - **`soldByCategory(orgId, swapId)`** returns `{ categories: [{ categoryId, units }], asOf, error }`. `categoryId` is null for items with no category.
  - Both read the shared cache (D1) and map variations to the swap's items in one query (D2).
- **`sales-heatmap.ts`** (new, pure): `salesHeatmap(lines, variationIds, timeZone)` and `soldByCategory(lines, categoryByVariation)`, applying D2, D4 and D6.
- **`stats.controller.ts`:** `GET …/stats/sales-heatmap` and `GET …/stats/sold-by-category`, under `ski_swap:report`, beside `checkins` and `breakdown`.
- **`getCategoryCounts`:** sums `originalQuantity` instead of counting rows (D6).
- **Contracts:** `SalesHeatmap`, `SalesCell` and `SoldByCategory` in `ski-swap.contracts.ts`.

## Web

- **`SkiSwapDashboard.tsx`:** the tiles row with `ItemsTile` in third place (D3), then `CheckinsHeatmapCard` and `SalesHeatmapCard` (`lg:grid-cols-2`), then `CategoriesChartCard`.
- **`ItemsTile.tsx`** (new, replacing `ItemsPieCard.tsx`): the bar and legend, built from `itemsPie.ts`'s slices. `itemsPie.ts` keeps the order, labels, colors and `percent`, and drops the donut geometry.
- **`heatmapParts.tsx`** (new, D5): the shared grid, plus `opacity`, `dayLabel` and `hourLabel`, moved out of `checkinsHeatmap.ts`, which keeps `heatView`.
- **`SalesHeatmapCard.tsx`** and **`salesHeatmap.ts`** (new):
  - `salesView(map, 'items' | 'dollars')` returns `value`, `dayTotal`, `hourTotal`, `total` and `max`;
  - `money(cents)` formats dollars;
  - the card polls every two minutes, like the Items tile.
- **`CategoriesChartCard.tsx`:** adds the `sold-by-category` query (every two minutes) and draws each column as a full-height track with the sold fill, the "sold / total" label and the header line (D6). Its pure parts live in **`categoriesChart.ts`**: `columns(counts, sold)` joins sold to totals and clamps sold to the total.
- **`lib/api.ts`:** `getSalesHeatmap` and `getSoldByCategory`, with types in `api.types.ts`.

## Tests

- **`sales-heatmap.spec.ts`:**
  - only this swap's variations count, including deleted and returned items;
  - refunds come off both units and dollars;
  - discounts are already in `collectedCents`;
  - buckets fall in the swap's time zone, including a sale just after local midnight;
  - only days and hours with sales appear;
  - sold by category goes to each item's current category, with null for none.
- **`item-breakdown.spec.ts`:** the breakdown is unchanged with lines cached, and all reads within two minutes share one Square call.
- **`salesHeatmap.test.ts`:** items vs dollars, totals, and the money format.
- **`categoriesChart.test.ts`:**
  - sold is joined to totals;
  - a category with no sales shows 0;
  - sold never exceeds the total;
  - the header's sums are right.
- **`itemsPie.test.ts`** and **`checkinsHeatmap.test.ts`:** still pass after the donut geometry and the shared parts move out.

## Rollout

1. Build and test locally against the stub Square: `PAYOUTS_STUB`, with `SMOKE_SALES_FILE` holding sale lines across two days, including:
   - one just past local midnight;
   - a refund;
   - a sale of something not in the swap.
2. Deploy, after asking. No migration.
3. Check the dashboard in the test org, and BMBW's read-only.

## Out of scope

- Sales by seller.
- Check-ins and sales in one chart.
- Updates more often than the two-minute Square read.
