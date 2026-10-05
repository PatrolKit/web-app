# Plan 39: The Items page at 10,000 items

## Goal

The Items page stays quick, and Square stays unbothered, at **10,000 items in a
swap with 5 staff on the page at once**.

**Stock stays in Square.** We store no copy of it. The server keeps Square's
last answer in memory for a couple of minutes, so that the page, the filters
and the dashboard share one read instead of each making their own.

## Today, at 10,000 items

| | Today |
|---|---|
| Requests to open the Items page | 50, one after another (200 items each) |
| Square stock reads to open it | at least 50 (one per batch), more where Square splits its answers into pages |
| Sent to the browser | roughly 15–20 MB (photos, answers and seller on every row) |
| After any save, delete, print, accept, or closing Fast Edit | all of the above again |
| 5 staff during check-in | hundreds of Square reads a minute, and multi-megabyte responses built on a 1 GB server |
| Dashboard (with the queued one-minute refresh) | every item's stock from Square, every minute, per open dashboard |
| An iPad's item sync | one Square read per batch, for stock the iPad never uses |

When Square pushes back on that rate, rows show "Stock unknown". Then the
For sale and Sold filters go wrong.

**Bug found while planning:** the Receipt popup on the Sellers page asks for a
seller's items without a limit, so it gets the server's default of 50. Its item
count and total value are wrong for any seller with more than 50 items.

## Targets

- **Items page:** first rows on screen in under 1 s; a sort, filter or next page
  in under 300 ms (server time at 10,000 items, once Square's answer is
  remembered).
- **Square:** stock reads don't grow with staff, page views or iPads. At most
  one full read per running swap every 2 minutes, and only while someone is
  looking.
- **Server memory:** no response over about 300 KB.

## Decisions

| # | Decision |
|---|---|
| D1 | **Pages of 100.** The server filters, sorts and counts, and the browser shows one page with "1–100 of 9,812", Previous and Next. Changing a filter, sort or search starts again at page 1. |
| D2 | **Every filter and sort runs on the server.** Our own columns run in SQL; For sale, Sold and Status use Square's remembered answer (D5). Search covers what it does today: SKU, name, seller name, email and phone. |
| D3 | **Counts come from the server in the same answer**: each status's count for the filter menu ("Needs a price (7)", "Sold (3,100)"), items waiting to be accepted for the chosen seller, and items whose stock is unknown. Nothing on the page counts the rows it was sent. |
| D4 | **A save updates its row in place.** Edit, print, price and accept replace that row in the page with the server's answer, then refresh only the counts. A delete removes the row. Nothing reloads the whole list. |
| D5 | **Square's answer is remembered, not stored.** The server keeps the last full stock read per swap in memory for **2 minutes**, which is within the 1–5 minutes agreed in review. It's never written to the database, it's gone on a restart, and it's read only when someone needs it. |
| D6 | **One source per screen.** Everything on the Items page and the dashboard reads the remembered answer: row badges, filters, Status sorting and counts. A row's badge then never disagrees with the filter it's listed under. |
| D7 | **Shown stale while it refreshes.** Once the answer is 2 minutes old, the next request gets it at once and a refresh starts behind it; only the first read for a swap (after a restart) makes someone wait. One refresh runs at a time per swap. |
| D8 | **Freshness is shown, and can be forced.** The page and the dashboard say "Stock as of 1 min ago". **Refresh stock** re-reads Square now, at most once every 15 s per swap. If a refresh fails, the last answer stays up with its age and a notice that Square didn't answer. |
| D9 | **Decisions still read Square live.** Anything that acts on "unsold" reads Square at that moment: removing returned tickets (Plan 38 D10), the shop's describe-once rule (D6 there) and payouts (orders). The remembered answer is for showing and finding, not for deciding. |
| D10 | **The iPads' sync doesn't read Square.** They store `inStock` and `soldCount` but never read them: no screen, count, receipt or check uses them, and their own notes say a check-in iPad shouldn't show "sold". The `walk` and `updatedSince` modes answer with stock unknown (`inventoryKnown: false`), which the app already decodes. The iPad needs no change. |

## Server

### The list

- **`GET …/swaps/:swapId/items`** gains:
  - `status=not_received|not_in_square|for_sale|sold|stock_unknown|needs_price`;
  - `printed=true|false`;
  - `sort=sku|name|price|seller|status|tag` and `dir=asc|desc`, as the table offers today;
  - `counts=true`, which adds the counts in D3 and the remembered answer's age.
- **What runs where:**
  - **SQL**, for our own columns:
    - SKU sorts as a number: by length, then value.
    - Seller sorts by the name shown: business name, or first and last.
    - A missing price or seller sorts last either way, and ties sort by SKU, as the table does today.
  - **With stock** (For sale, Sold, Stock unknown, Status sort and the counts): the server applies the other filters in SQL, then splits by the remembered answer (D5), sorts and pages. Even at 10,000 items that's a list of ids and numbers in memory, not rows.
- **The page itself** is read with the usual includes for its 100 ids only.
- **Defaults stay for other callers:** no `sort` is newest first, as now.
- **The iPad's `walk` and `updatedSince`** skip Square entirely (D10).

### Square's remembered answer

- **What it is:** a per-swap entry in memory: stock by variation id, when it was read, and whether the last refresh failed.
- **How it's filled:** the swap's synced items' counts, read by catalog id in batches as large as Square allows (Q1).
- **Who uses it:**
  - the Items page, through the list's status filters, Status sort, counts and row badges;
  - the shop's My Items page;
  - the dashboard's sold count and revenue (this replaces the queued one-minute refresh's direct reads);
  - the Receipt popup's totals.
- **Who doesn't:** the decisions in D9, and the public status pages. Those look up one SKU or one seller's items, a small live read.
- **The server runs as one process,** so one in-memory entry per swap is the only copy. If it ever runs as several, each keeps its own, and the cost scales with that.

### The Receipt popup

- It reads the seller's item count and total from the server, which fixes the 50-item bug.

## Web

- **`SwapItemsPanel`:**
  - asks for one page with the filters, sort and search;
  - keeps them in the URL, so the dashboard's links and a reload land on the same view;
  - the paging loop and the browser-side filtering, sorting and counting go;
  - the sort headings from the queued commit stay as they are, and send `sort` and `dir`.
- **Pager:** "1–100 of 9,812", Previous and Next, under the table and above it when the page is long.
- **Stock line:** "Stock as of 1 min ago · Refresh stock" above the table (D8), and the same on the dashboard.
- **Saves** follow D4.
- **The shop's "My Items" page** gets the same, through its own list endpoint (`seller/me/items`), which already takes `skip` and `take`.

## Rollout

- **Nothing deploys while a customer's swap is running**, unless the user says so.
- **No migration.**
- **The queued one-minute dashboard refresh** goes out only with this plan's
  remembered answer; otherwise drop the refresh from that commit.
- **iPad:** no change, and no handoff needed. A one-line note to the iOS repo
  says the sync now answers with stock unknown, as its notes already expect.

## Tests

- **Scale, against a scratch database with 10,000 items, sellers and photos:**
  - each sort and filter, with and without search: query time and response size;
  - five clients loading pages, filtering by Sold and saving at once, with a fake Square that counts its calls: at most one full read per swap per 2 minutes, plus forced refreshes.
- **Server:**
  - every filter and sort, including numeric SKU, missing values last and ties by SKU;
  - counts matching the filters;
  - stock-based filters and sorts split by the remembered answer;
  - `walk` and `updatedSince` making no Square call.
- **The remembered answer:**
  - its expiry;
  - stale-while-refreshing;
  - one refresh at a time;
  - the 15 s floor on forced refreshes;
  - a failed refresh keeping the last answer with its age.
- **Web:**
  - the URL keeping the view;
  - a save updating one row and the counts;
  - the pager and the stock line;
  - the Receipt total for a seller with more than 50 items.
- **Square sandbox:** a full read of a large location, to learn Square's batch limits and how long 10,000 takes (Q1).

## Questions for review

1. **Square sandbox:** Square's largest batch and how long a 10,000-item read
   takes need checking against a real Square account, since the smoke org has
   no Square. Is there a sandbox account or test location we can use?
2. **Page size:** 100 rows, or would staff rather scroll a longer page (say 250)?
3. **The remembered answer's age:** 2 minutes is the default, within the 1–5
   agreed. Shorter keeps Sold fresher during the sale; longer reads Square less.
