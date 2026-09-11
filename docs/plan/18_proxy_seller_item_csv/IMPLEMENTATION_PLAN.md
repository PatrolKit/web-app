# Plan 18 — Uploading a shop's inventory for them

The first swap runs on legacy tickets, and the shops using them will not be
signing in. Staff need to add a business seller without summoning them by email,
and to upload the spreadsheet that shop sent in on their behalf.

## 1. What is being asked, and one thing that is not

**Adding a business seller sends mail.** `BusinessSellerService.invite` requires
an email and always sends to it — a magic-link invite to a new address, a
"you've been added" notice to one already known. There is no way to record a
shop without contacting it.

**A CSV can only be uploaded by the shop itself.** `POST seller/me/items/import`
resolves the caller's own seller profile. The service under it,
`LegacyTicketService.importItems`, already takes a `sellerId` as an argument, so
the rules are not the problem — only who is allowed to name the seller.

**And a CSV import puts nothing on sale.** Found while reading for this plan and
confirmed against a running server. The same shop, the same swap, the same
ticket numbers, entered two ways:

| | `consignedAt` | reaches Square |
|---|---|---|
| Typed in one at a time | set | yes |
| **Uploaded as a CSV** | **null** | **never** |

`importItems` writes rows straight through Prisma rather than through
`ItemService.create`, so it sets no `consignedAt` and calls no Square sync. Since
Plan 16 a null `consignedAt` means *waiting for a staff member to accept it*, so
every imported item reads as unaccepted on the seller's public status page and
can never be rung up.

Nothing has been lost: production holds zero unconsigned items and no
organisation has the consignment scan switched on. There is nothing to repair,
only something to stop happening — and a reason to fix it before building the
proxy upload on top of it.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | An imported item is **consigned at creation and pushed to Square** | Plan 16 D2: only a self check-in at a station ever waits to be accepted. A shop's own inventory, uploaded from a desk, is not that — whoever sent the file. |
| D2 | Adding a seller and inviting them become **two separate acts** | A shop whose items staff upload may never sign in. Making the invite the price of recording an address is backwards, and the address is worth having — it is where the check goes. |
| D3 | The proxy upload reuses **the existing import rules** with a chosen seller id | The range, duplicate and all-or-nothing checks are already there and already tested. A second implementation is a second set of rules to drift. |
| D4 | The CSV gains a **`description`** column, and `description` stops being an alias for `name` | Square takes a description and shows it to buyers, and nothing fills it today. A shop that writes "177cm, small topsheet scratch" should not have that become the item's title. |
| D5 | The upload is gated on the swap's **`legacyTicketsEnabled`** | The same switch as the rest of the legacy-ticket UI. A swap on printed tags has no numbers to upload against. |
| D6 | The seller picker offers **only business sellers holding ranges in this swap** | See §2.2. |

### 2.1 Why the import fix comes first

It decides whether the feature above it works at all. Landed on its own, a
regression in it is unambiguous; landed together with the proxy upload, "the
items did not go on sale" has two possible causes. It also repairs the shop's
own upload in the same stroke, since both go through one method.

### 2.2 Choosing the seller instead of implying one

Putting the upload on the Items page behind a picker means the seller is chosen
rather than implied. Staff with two shops' files open have a way to attach one
shop's inventory to the other, and nothing about the screen would look wrong
while they did it.

Two things make that a refusal rather than a silent success:

- **The picker only lists sellers who could own these numbers** — business
  sellers holding at least one ticket range in this swap. A shop with no ranges
  cannot be selected, so the commonest mistake is unreachable.
- **A number outside the seller's blocks is already refused**, by name:
  *"67169 is not one of this seller's tickets. Theirs are 68000–68499."* Ranges
  never overlap, so a file uploaded against the wrong shop fails on its first
  row and every row after it, and nothing is written.

## 3. What changes

### 3.1 The import writes items the way everything else does

`LegacyTicketService.importItems` builds `swapItem.create` calls by hand. Those
writes belong on `ItemService.create`, which is what knows about `consignedAt`
and Square.

**It cannot simply call it.** `ItemService` already depends on
`LegacyTicketService` — the loose-ticket work added it, to check whether a
scanned number belongs to a shop's block — so injecting the reverse is a cycle.
The dependency has to stay pointing one way: `LegacyTicketService` keeps the
rules, and the writing loop moves to the side that may already call both.

Two things to watch when moving it:

- **`hasPrintedTag`.** The hand-written create sets it directly. `create` has no
  `alreadyPrinted` — that is `createAtStation`'s — so it has to be set
  explicitly, or a shop's items offer a reprint of a ticket that came out of a
  box.
- **A Square failure must not fail the import.** `create` pushes synchronously
  when there is no station, so an outage mid-file would abandon a hundred-row
  import halfway — precisely what the all-or-nothing check exists to prevent.
  The push already swallows its own errors and reports `'failed'`; the import
  should record that per row rather than throw.

### 3.2 Adding a seller without sending

`InviteBusinessSellerSchema` becomes:

```ts
{
  businessName: string,          // required, as now
  email?: string,                // optional
  sendInvite?: boolean,          // default false
}
```

Mail goes out only when `sendInvite` is true and an email is present. Without a
send this is `SellerService.create` in all but name — a person row, a membership,
a seller profile carrying a business name — so that is what the silent path
should call rather than keeping a second way to write the same rows.

Note the default. Today's behaviour is always-send; the new default is never,
and the checkbox is how the old behaviour is asked for.

### 3.3 The CSV

```
sku,price,name,description
67169,180.00,Salomon QST boots,27.5 mondo — buckles good
67170,45.00,Poles,
67171,20.00,,Ski bag
```

`sku` and `price` are required; `name` and `description` are not. A blank name
still falls back to `"<Shop> <ticket>"`, as the shop's own import already does.
`name` also accepts `item` and `title`; `description` also accepts `details` and
`notes`.

**This changes what an existing file means.** `description` is currently an
alias *for the name*, so a file carrying a description column and no name column
fills the item's title today and will fill its description afterwards, leaving
the title as the fallback. No such file has been imported in production, and the
product is pre-production, so it is worth taking rather than carrying the alias
forward.

### 3.4 The endpoint

```
POST /orgs/:orgId/ski-swap/swaps/:swapId/items/import   (ski_swap:manage)
  multipart: file, sellerId
  → ImportRowResult[]
```

Beside the existing item routes rather than under `sellers/`, because what it
creates is items. It refuses a swap without `legacyTicketsEnabled`, and a seller
holding no ranges — the same message the shop's own import already gives.

## 4. The screens

### 4.1 Adding a business seller — Sellers page

```
  Business name *  [ Alpine Sports         ]
  Email            [ sam@alpine.example    ]

  [ ] Send them a sign-in link
      They can add their own items and track sales. Leave this off if
      you are entering their inventory for them.

                                       [ Add seller ]
```

The button reads **Send Invite** today and becomes **Add seller**, because that
is now what it always does and sending is the exception. The line promising a
magic-link email goes with it.

### 4.2 Uploading for a seller — Items page

An **Import for a seller** button beside **Add item**, shown only when the swap
has legacy tickets on and at least one seller holds a range.

```
  Import items for a seller

  Seller   [ Alpine Sports  ▾ ]        tickets 67000–67499, 112 used

  [ Choose a CSV… ]   sku, price, and optionally name and description

  ──────────────────────────────────────────────────
  3 rows read for Alpine Sports

  ✓ 67169   Salomon QST boots        $180.00
  ✓ 67170   Poles                     $45.00
  ✗ 68001   Ski bag                   $20.00
            68001 is not one of this seller's tickets.
            Theirs are 67000–67499.

  Nothing was imported. Fix the file and try again.
```

The seller's ranges sit next to the picker and the result panel repeats their
name, so a wrong choice is visible before the file is read rather than only
after it fails.

## 5. Validation

| Rule | Behaviour |
|---|---|
| A swap without legacy tickets | Refused; the button is not shown either. |
| A seller with no ranges in this swap | Refused, and they are not in the picker. |
| A number outside the seller's ranges | The row fails, naming the seller's ranges. |
| A number already on an item | The row fails, naming the ticket. |
| The same number twice in one file | The row fails, naming the earlier line. |
| A row with no price, or a price of zero | The row fails. |
| Any row failing | Nothing is written at all. |
| Square unavailable | Items are still created; the failure is reported per row, and they can be re-pushed from the items table. |

## 6. Phases

1. **The import writes items properly.** The writing loop moves off
   `LegacyTicketService`; imported items are consigned and reach Square. Repairs
   the shop's own upload at the same time. Nothing new is reachable yet.
2. **Adding without sending.** The optional email, the checkbox, the copy.
3. **The description column.** Parser and fallback-name change; the shop's own
   upload gets it too.
4. **The proxy upload.** Endpoint, picker, dialog — everything in §4.2.

Phase 2 answers one ask and phases 1 and 4 the other; 3 serves both. Phase 1 is
worth landing on its own whether or not the rest follows.

## 7. What this costs, honestly

**Somebody will add a seller and expect an email.** The default flips from
always-send to never, and the only thing that says so is a checkbox nobody
reads. The first time a shop says "I never got a link", this will be why.

**An import that half-reaches Square is a new state.** The all-or-nothing rule
covers the database, not the catalogue: if Square goes down on row fifty, fifty
items are on sale and fifty are not, and all hundred exist. Better than
abandoning the import, and still a state somebody has to notice and clear from
the items table.

**A wrong-seller import stays possible.** §2.2 makes it a loud failure, but only
if the failure is read — and a hundred red rows are easier to dismiss as "the
file is wrong" than to read as "I picked the wrong shop".

**Two ways to add a business seller still exist.** The silent path folds onto
`SellerService.create` and the sending path stays on `invite`. If they drift,
the difference will show up as a seller row that looks different depending on
which button made it.

## 8. Out of scope

- **Editing a file after a failed import.** Fix it in the spreadsheet and upload
  again; the whole thing is rejected either way.
- **A progress bar.** A shop's inventory is hundreds of rows, not thousands, and
  the import is one request.
- **Inviting in bulk.** Sending is per seller and stays that way.
- **Backfilling unconsigned items.** There are none to backfill (§1).
