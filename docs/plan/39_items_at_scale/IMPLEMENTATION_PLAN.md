# Plan 39: The Items page at 10,000 items

## Goal

The Items page stays quick, and Square stays unbothered, at **10,000 items in a
swap with 5 staff on the page at once**.

Today the page loads every item into the browser and filters, sorts and counts
there. Each load is 50 requests one after another at 10,000 items, each with a
Square stock read, and every edit repeats the whole load. Stock comes from
Square on every request: the Items page, the dashboard, the iPads' item sync and
the public status pages all ask Square for it, each separately.

This plan does two things:

- **The server pages, filters and sorts.** The page asks for 100 rows at a time.
- **We keep a copy of Square's stock.** A background job keeps it current, so
  lists read our database rather than Square.

## Today, at 10,000 items

| | Today |
|---|---|
| Requests to open the Items page | 50, one after another (200 items each) |
| Square stock reads to open it | at least 50, more where Square splits its answers into pages |
| Sent to the browser | roughly 15–20 MB (photos, answers and seller on every row) |
| After any save, delete, print, accept, or closing Fast Edit | all of the above again |
| 5 staff during check-in | hundreds of Square reads a minute, and multi-megabyte responses built on a 1 GB server |
| Dashboard (with the queued one-minute refresh) | every item's stock from Square, every minute, per open dashboard |
| An iPad's full item sync | one Square read per batch it pulls |

When Square pushes back on that rate, rows show "Stock unknown". Then the
For sale and Sold filters go wrong.

**Bug found while planning:** the Receipt popup on the Sellers page asks for a
seller's items without a limit, so it gets the server's default of 50. Its item
count and total value are wrong for any seller with more than 50 items.

## Targets

- **Items page:** first rows on screen in under 1 s; a sort, filter or next page
  in under 300 ms (server time at 10,000 items).
- **Square:** stock reads don't grow with staff or page views. They're one
  background reader per running swap, a couple of calls a minute.
- **Server memory:** no response over about 300 KB.

## Decisions

| # | Decision |
|---|---|
| D1 | **Pages of 100.** The server filters, sorts and counts, and the browser shows one page with "1–100 of 9,812", Previous and Next. Changing a filter, sort or search starts again at page 1. |
| D2 | **Every filter and sort runs on the server**, the status ones included (after Phase 2). Search covers what it does today: SKU, name, seller name, email and phone. |
| D3 | **Counts come from the server in the same answer**: each status's count for the filter menu ("Needs a price (7)"), items waiting to be accepted for the chosen seller, and items whose stock is unknown. Nothing on the page counts the rows it was sent. |
| D4 | **A save updates its row in place.** Edit, print, price and accept replace that row in the page with the server's answer, then refresh only the counts. A delete removes the row. Nothing reloads the whole list. |
| D5 | **Our own copy of Square's stock** (Phase 2): each item's count in Square, and when it was read. Lists, filters, the dashboard, the public status pages and the iPads' sync read the copy. It holds only what Square reported, so sold status still comes from Square alone. |
| D6 | **One background reader per running swap** keeps the copy current. It asks Square only for counts changed since its last read (`updatedAfter`), every 30 s. On its first run for a swap it reads every item. |
| D7 | **Decisions still read Square live.** Anything that acts on "unsold" reads Square at that moment: removing returned tickets (Plan 38 D10), the shop's describe-once rule (D6 there) and payouts (orders). The copy is for showing and finding, not for deciding. |
| D8 | **Freshness is shown.** The Items page and the dashboard say "Stock as of 40 s ago". If the reader hasn't heard from Square for 5 minutes, a notice says so, and the For sale and Sold figures carry that warning. |
| D9 | **Square webhooks are a later option, not part of this plan.** Plan 6 designed them, but they were never built. Polling with `updatedAfter` covers 10,000 items in one or two calls a minute, without per-org webhook setup. Revisit if 30 s turns out too slow. |
| D10 | **Dashboard figures are cached for a minute per swap** (Phase 1), then computed from the copy (Phase 2). Any number of open dashboards costs at most one read a minute. |

## Phase 1: the server pages (no database change)

### Server

- **`GET …/swaps/:swapId/items`** gains:
  - `status=not_received|not_in_square|for_sale|sold|needs_price`;
  - `printed=true|false`;
  - `sort=sku|name|price|seller|status|tag` and `dir=asc|desc`, as the table offers today;
  - `counts=true`, which adds the status counts, the waiting count and the stock-unknown count (D3).
- **What runs where:**
  - SQL does every filter and sort on our own columns.
  - SKU sorts as a number: by length, then value.
  - Seller sorts by the name shown: business name, or first and last.
  - A missing price or seller sorts last either way, and ties sort by SKU, as the table does today.
  - Ids come from one raw query; the page is then read with the usual includes.
- **For sale, Sold and Status sorting** need stock. In Phase 1 they still read Square, but only for the ~100 rows on the page; filtering by them reads Square in batches for all of the swap's synced items. That costs more than the other filters, and Phase 2 removes it.
- **Defaults stay** for every other caller: no `sort` is newest first, as now, and the iPad's `walk` and `updatedSince` are unchanged.
- **The dashboard stats** (D10) are cached in-process for 60 s per swap.

### Web

- **`SwapItemsPanel`:**
  - asks for one page with the filters, sort and search;
  - keeps them in the URL, so the dashboard's links and a reload land on the same view;
  - the paging loop and the browser-side filtering, sorting and counting go;
  - the sort headings from the queued commit stay as they are, and send `sort` and `dir`.
- **Pager:** "1–100 of 9,812", Previous and Next, under the table and above it when the page is long.
- **Saves** follow D4.
- **The shop's "My Items" page** gets the same, through its own list endpoint (`seller/me/items`), which already takes `skip` and `take`.
- **The Receipt popup** reads the seller's count and total from the server, which fixes the 50-item bug.

## Phase 2: our copy of Square's stock (additive migration)

### Schema

- **`SwapItem.squareInStock Int?`**: Square's count for the item's variation at the swap's location. Null means never read.
- **`SwapItem.stockReadAt DateTime?`**: when that count was read.
- **`SkiSwap.stockReadThrough DateTime?`**: the newest `calculatedAt` the reader has seen, where its next read starts.
- **`SkiSwap.stockReadOkAt DateTime?`**: the last time a read succeeded, for D8.
- **Index** `(swapId, deletedAt, squareInStock)` for the status filters.

### The reader

- **What it covers:** every active swap with a Square location and a working Square connection.
- **When it runs:** an in-process timer every 30 s. The server runs as one process, so one timer is one reader. If it ever runs as several, the reader needs a lock first.
- **First run for a swap:** reads every synced item's count by catalog id, in batches as large as Square allows (Q1).
- **After that:** asks for counts at the location changed since `stockReadThrough` minus 60 s, which allows for clock drift and late-calculated counts. It keeps only our variations.
- **Writes:** the counts and `stockReadAt`, then advances `stockReadThrough` and `stockReadOkAt`.
- **A failed read** changes nothing, and `stockReadOkAt` stops moving (D8).
- **Our own Square writes record the count we set**: a new item, a resumed ticket push, a quantity edit. A new item isn't "Stock unknown" until the next read.

### Who reads the copy

- **Item lists:** the staff Items page, My Items, and the iPads' `walk` and
  `updatedSince` sync. Status filters and sorting become SQL; Phase 1's batched
  Square reads for them go.
- **The dashboard:** sold count and revenue become a database query.
- **The public status pages** (swap and seller).
- **Not decisions** (D7): those keep their live reads.

### The iPad

- Its sync gets stock from the copy, with no Square read per batch.
- **Open question for review (Q3):** a sale doesn't change an item's `updatedAt`, so a delta sync doesn't re-send a sold item. That's already true today.

## Rollout

- **Nothing deploys while a customer's swap is running**, unless the user says so.
- **Phase 1:** no migration. Deploy it with, or before, the queued commits. The
  queued one-minute dashboard refresh must not go out without Phase 1's 60 s
  stats cache; otherwise drop the refresh from that commit.
- **Phase 2:**
  - an additive migration; ask "migrate in place" first;
  - the reader starts on deploy and fills each running swap's copy on its first run;
  - until a swap's first read finishes, lists fall back to today's live reads;
  - iPad note: stock arrives with the usual sync; nothing changes for the iPad
    unless Q3 says otherwise.

## Tests

- **Scale, against a scratch database with 10,000 items, sellers and photos:**
  - each sort and filter, with and without search: query time and response size;
  - five clients loading pages and saving at once, with a fake Square that counts its calls: Phase 1 should cost at most one Square read per page shown, Phase 2 none.
- **Server:**
  - every filter and sort, including numeric SKU, missing values last and ties by SKU;
  - counts matching the filters;
  - defaults unchanged for `walk` and `updatedSince`.
- **The reader:**
  - first full read in batches;
  - incremental reads with the overlap;
  - unknown variations ignored;
  - a failed read changing nothing;
  - our own writes recording the count.
- **Web:**
  - the URL keeping the view;
  - a save updating one row and the counts;
  - the pager;
  - the Receipt total for a seller with more than 50 items.
- **Square sandbox:** the incremental read checked against a real account, since the smoke org has no Square (Q1).

## Questions for review

1. **Square sandbox:** `updatedAfter`, its paging and the largest batch Square
   accepts need checking against a real Square account. Is there a sandbox account or test location we can use,
   or should the first check be on BMBWAV's swap with the reader logging only?
2. **Page size:** 100 rows, or would staff rather scroll a longer page (say 250)?
3. **iPad stock after a sale:** should the reader also mark a sold item as
   changed, so the iPads' delta sync picks up the sale? That sends every sale to
   every iPad, which may be what staff expect at the counter. It's a change for
   the iOS repo.
4. **Freshness:** is 30 s between reads right during a sale? Webhooks (D9) would
   make it near-instant, at the cost of each org's Square webhook setup.
