# Plan 39: The Items page at 10,000 items

## Goal

The Items page stays quick, and Square stays unbothered, at **10,000 items in a
swap with 5 staff on the page at once**.

**Stock stays in Square.** Nothing stores a copy of it. The server keeps
Square's last answer in memory for 2 minutes, so the page, its filters and the
dashboard share one read instead of each making their own.

## Today, at 10,000 items

| | |
|---|---|
| Requests to open the Items page | 50, one after another (200 items each) |
| Square stock reads to open it | at least 50, one per batch, more where Square splits its answers into pages |
| Sent to the browser | roughly 15–20 MB: photos, answers and seller on every row |
| After any save, delete, print, accept, or closing Fast Edit | all of the above again |
| 5 staff during check-in | hundreds of Square reads a minute, and multi-megabyte responses built on a 1 GB server |
| Dashboard, with the one-minute refresh already committed | every item's stock from Square, every minute, per open dashboard |
| An iPad's item sync | one Square read per batch, for stock the iPad never uses |

When Square pushes back on that rate, rows show "Stock unknown", and the
For sale and Sold filters go wrong.

**Also fixed here:** the Receipt popup on the Sellers page asks for a seller's
items without a limit, so it gets the server's default of 50. Its item count
and total value are wrong for any seller with more than 50 items.

## Targets

- **Items page:**
  - first rows on screen in under 1 s;
  - a sort, filter or next page in under 300 ms of server time.
  - The exception is the first stock read for a swap after a restart (D7).
- **Square:** stock reads don't grow with staff, page views or iPads. At most
  one full read per running swap every 2 minutes, and only while someone is
  looking.
- **Server memory:** no response over about 300 KB.

## Decisions

| # | Decision |
|---|---|
| D1 | **Pages of 50.** The server filters, sorts and counts, and the browser shows one page: "1–50 of 9,812", Previous and Next. Changing a filter, sort or search starts again at page 1. |
| D2 | **Every filter and sort runs on the server.** Our own columns run in SQL; For sale, Sold and Status use Square's remembered answer (D5). Search covers what it does today: SKU, name, seller name, email and phone. |
| D3 | **Counts come from the server in the same answer.** That means each status's count for the filter menu ("Needs a price (7)", "Sold (3,100)"), the items waiting to be accepted for the chosen seller, and the items whose stock is unknown. Nothing on the page counts the rows it was sent. |
| D4 | **A save updates its row in place.** Edit, print, price and accept replace that row with the server's answer, then refresh only the counts. A delete removes the row. Nothing reloads the whole list. |
| D5 | **Square's answer is remembered, not stored.** The server keeps the last full stock read per swap in memory for **2 minutes**, a single setting to lengthen if Square's reads prove costly. It's never written to the database, it's gone on a restart, and it's read only when someone needs it. |
| D6 | **One source per screen.** Everything on the Items page and the dashboard reads the remembered answer: row badges, filters, Status sorting and counts. A row's badge never disagrees with the filter it's listed under. |
| D7 | **Shown stale while it refreshes.** Once the answer is 2 minutes old, the next request gets it at once and a refresh starts behind it. Only the first read for a swap, after a restart, makes anyone wait. One refresh runs at a time per swap. |
| D8 | **Freshness is shown, and can be forced.** The page and the dashboard say "Stock as of 1 min ago". **Refresh stock** re-reads Square now, at most once every 15 s per swap. If a refresh fails, the last answer stays up with its age and a notice that Square didn't answer. |
| D9 | **Decisions still read Square live.** Anything that acts on "unsold" reads Square at that moment: removing returned tickets (Plan 38 D10), the shop's describe-once rule (Plan 38 D6) and payouts (orders). The remembered answer is for showing and finding, not for deciding. |
| D10 | **The iPads' sync doesn't read Square.** The iPads store `inStock` and `soldCount` but never read them: no screen, count, receipt or check uses them, and their own notes say a check-in iPad shouldn't show "sold". The `walk` and `updatedSince` modes answer with stock unknown (`inventoryKnown: false`), which the app already decodes. |

## Server

### The list

- **`GET …/swaps/:swapId/items`** gains:
  - `status=not_received|not_in_square|for_sale|sold|stock_unknown|needs_price`;
  - `printed=true|false`;
  - `sort=sku|name|price|seller|status|tag` and `dir=asc|desc`, the table's columns;
  - `counts=true`, which adds the counts in D3 and the remembered answer's age.
- **SQL handles our own columns:**
  - SKU sorts as a number: by length, then value.
  - Seller sorts by the name shown: the business name, or first and last.
  - A missing price or seller sorts last either way, and ties sort by SKU, as the table does now.
- **Stock-based filters and sorts** (For sale, Sold, Stock unknown, Status, and the counts): the other filters run in SQL first. Their result is then split by the remembered answer, sorted and paged. At 10,000 items that's a list of ids and numbers in memory, not rows.
- **The page itself** is read with the usual includes, for its 50 ids only.
- **Other callers keep the defaults:** no `sort` means newest first, as now.
- **`walk` and `updatedSince`** make no Square call (D10).

### Square's remembered answer

- **What it holds:** per swap, stock by variation id, when it was read, and whether the last refresh failed.
- **How it's filled:** the swap's synced items' counts, read by catalog id in batches as large as Square allows. The off-hours test finds that size.
- **Who reads it:**
  - the Items page: status filters, Status sort, counts and row badges;
  - the shop's My Items page;
  - the dashboard's sold count and revenue, in place of the one-minute refresh's direct reads;
  - the Receipt popup's totals.
- **Who doesn't:** the decisions in D9, and the public status pages, which look up one SKU or one seller's items with a small live read.
- **One copy:** the server runs as one process, so there's one entry per swap. If it ever runs as several, each keeps its own, and the cost scales with that.

### The Receipt popup

- It reads the seller's item count and total from the server, which fixes the 50-item limit.

## Web

- **`SwapItemsPanel`:**
  - asks for one page with the filters, sort and search;
  - keeps them in the URL, so the dashboard's links and a reload land on the same view;
  - drops the paging loop and the browser-side filtering, sorting and counting;
  - keeps the sort headings already committed, which now send `sort` and `dir`.
- **Pager:** "1–50 of 9,812", Previous and Next, above and below the table.
- **Stock line:** "Stock as of 1 min ago · Refresh stock" above the table, and the same on the dashboard (D8).
- **Saves** follow D4.
- **The shop's My Items page** works the same way, through its own list endpoint (`seller/me/items`), which already takes `skip` and `take`.

## Rollout

- **Nothing deploys while a customer's swap is running** without the user's say-so.
- **No migration.**
- **The one-minute dashboard refresh** already committed ships only with the
  remembered answer. Otherwise it comes out of that commit.
- **iPad:** no change. A one-line note to the iOS repo says the sync now answers
  with stock unknown, as its notes already expect.

## Tests

- **Scale,** against a scratch database with 10,000 items, sellers and photos:
  - each sort and filter, with and without search, for query time and response size;
  - five clients loading pages, filtering by Sold and saving at once, against a fake Square that counts its calls: at most one full read per swap per 2 minutes, plus forced refreshes.
- **Server:**
  - every filter and sort, including numeric SKU, missing values last and ties by SKU;
  - counts that match the filters;
  - stock-based filters and sorts split by the remembered answer;
  - `walk` and `updatedSince` making no Square call.
- **The remembered answer:**
  - its expiry, and serving stale while refreshing;
  - one refresh at a time;
  - the 15 s floor on forced refreshes;
  - a failed refresh keeping the last answer, with its age.
- **Web:**
  - the URL keeping the view;
  - a save updating one row and the counts;
  - the pager and the stock line;
  - the Receipt total for a seller with more than 50 items.
- **Against Square, in off-hours:** there's no sandbox, so the full read is
  checked against a real account outside swap hours. It's read-only and needs
  the user's go-ahead. It finds Square's batch size and how long a large read
  takes.
