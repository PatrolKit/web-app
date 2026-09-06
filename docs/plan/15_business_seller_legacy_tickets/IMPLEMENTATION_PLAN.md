# Plan 15 — Legacy ticket ranges for business sellers

A business seller either prints their own tags or uses numbered tickets the
organisation issued them. Today only the first is possible.

## 1. The gap

A business seller is given a printer (`SwapPrinter.assignedSellerId`), enters
items from their own desk, and prints a tag per item over Bluetooth. We mint the
SKU — `SS26-0042` — and the barcode is Code 128-B.

Some shops do not print at all. The organisation hands them a block of numbered
tickets each year — pre-printed tags carrying a bare number like `67169` and a
Code 39 barcode — and the shop attaches those to its goods before arriving.
These shops are not going to buy a label printer to keep selling at the swap,
and asking them to stick our tag over a number we gave them is how a tag ends up
on the wrong ski.

The numbers are therefore ours, and the organisation already knows which block
went to which shop. What it cannot do is tell us, so the items those tickets end
up on are never recognised as that shop's.

Nothing in the model prevents an item carrying such a number: `SwapItem.sku` is
a string, unique per swap, and `ItemService.create` already accepts an explicit
`sku` from callers that have one. What is missing is any record of which numbers
a seller was given, and any way for that seller to use them.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | A seller has **either** an assigned printer **or** legacy ranges, never both | The two are alternative answers to "how does this item get a tag". A seller with both would have two SKUs competing for one item. |
| D2 | Ranges are **per swap** | Tickets are issued each year, so a block belongs to the season it was handed out in. Next year's are entered again. |
| D3 | Two ways in: one at a time, or a CSV of the whole inventory | A shop with six items types them; a shop with four hundred does not. |
| D4 | One at a time defaults to the number **above the highest used**, pre-selected | The pad is worked through in order, and a skipped ticket is usually gone — offering it back on every item would make the default something to correct. Pre-selected rather than locked, so entering a found ticket costs one keystroke. |
| D5 | Used numbers are **derived from the items**, not tracked separately | A ticket is nothing to us until the seller enters it, so the items already are the record. A second table tracking consumption would be a second truth to drift. |
| D6 | Running out **refuses the item**, but only when *no* number in the ranges is unused | Every legacy item must correspond to a ticket that physically exists. A skipped ticket is not gone — it turns up in a coat pocket, and the seller must be able to enter it. A fallback SKU would need a printer they do not have. |
| D7 | The high-water mark governs the **suggestion only**, never a refusal | Its whole job is to stop a binned ticket being offered back forever (D4). Letting it decide what is *allowed* would lock out the found ticket D6 exists to accept. |
| D8 | A legacy item never queues a tag, and counts as printed | The tag is already on the item. Leaving `hasPrintedTag` false would strand every legacy item in the "not printed" filter. |
| D9 | The number is stored in `SwapItem.sku` as plain digits, unpadded | It is what the barcode encodes, and these pads are not zero-padded — `67169` is the whole SKU. |
| D10 | Ranges are **typed, not allocated from a pool** | The app is told which block went to a shop; it does not decide. That keeps it out of the way of how tickets are ordered and handed out, at the cost described in §8. |
| D11 | Assume a number **can** come round again in a later swap | Whether the run climbs year to year is unsettled. Assuming reuse costs nothing in the model; assuming the opposite would bake in something to unpick later. |
| D12 | A name is optional, and a blank one becomes **seller plus number** | `SwapItem.name` is non-null and Square requires a name, so something has to fill it. "Alpine Sports 67169" says whose item it is on a receipt without inventing a description nobody wrote. Built from `displayName()`, not raw `businessName`, which is nullable, so the fallback is never itself blank. Both entry paths apply the same rule. |

## 3. The model

One new table, scoped to a swap and a seller, holding the numbers as integers.

```prisma
/// A block of pre-printed tickets issued to a business seller for one swap.
///
/// Several rows per seller is normal — a shop opens a second pad when the
/// first runs out.
model LegacyTicketRange {
  id       String @id @default(cuid())
  orgId    String
  swapId   String
  sellerId String

  /// Inclusive, and compared numerically: 999 is below 1000, which is not true
  /// of the strings. A range may cross a digit-width boundary, which costs
  /// nothing because nothing here pads — the SKU is `String(n)`.
  startNumber Int
  endNumber   Int

  createdBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  org    Organization  @relation(fields: [orgId], references: [id], onDelete: Cascade)
  swap   SkiSwap       @relation(fields: [swapId], references: [id], onDelete: Cascade)
  seller SellerProfile @relation(fields: [sellerId], references: [id], onDelete: Cascade)

  @@index([swapId, sellerId])
  @@index([orgId])
}
```

`SwapItem` is untouched. A legacy item is one whose `sku` is a bare number
falling inside one of its seller's ranges — there is no flag, because a flag
could disagree with the number.

### 3.1 The suggested number, and when a seller is out

A pad is worked through in order, and tickets go missing on the way: one is
lost, one is filled in wrong and binned. The seller's used numbers therefore
have gaps, and a gap usually means *gone* — often enough that the suggestion
should not keep offering it back, never so certainly that entering it should be
refused.

So the suggestion carries on past gaps: the first number in the seller's ranges
above the highest they have used.

```
ranges := LegacyTicketRange where (swapId, sellerId), ascending by startNumber
used   := SwapItem.sku for this swap, parsed as an integer where it is one
high   := max(used ∩ ranges), or nothing if they have entered none yet
next   := first number in ranges strictly above high, rolling into the next
          range when one is exhausted
```

Rolling matters with more than one range: a seller holding 67000–67499 and
68000–68499 whose highest used is 67499 is offered 68000, not 67500.

**The mark suggests; it never refuses** (D7). Three states, and only the last
one stops anybody:

| Ranges hold… | The form | Entering a number |
|---|---|---|
| an unused number above the mark | suggests it, pre-selected | accepted if in range and unused |
| unused numbers only *below* the mark | opens empty, no suggestion | accepted if in range and unused |
| nothing unused at all | opens empty | refused (D6) |

Five tickets with one skipped means four items entered, no suggestion for the
fifth, and the fifth accepted the moment that ticket turns up — or a refusal,
and a word with staff, if it never does.

The scan covers one swap's items for one seller — hundreds of rows, not
millions — and runs on the form's load and on each save.

**Concurrency.** Two browser tabs can be suggested the same number.
`@@unique([swapId, sku])` rejects the second write and the form re-suggests.
Unlike the SKU counter's race, no lock is needed: there is no value to hand
back, so the loser simply asks again.

## 4. The screens

### 4.1 Assigning ranges — staff

Ranges live where the seller lives: the **Sellers** page, in the seller's edit
view, behind the same permission that assigns a printer (`ski_swap:admin`). A
business seller's edit view gains one section, showing whichever answer applies:

```
Tags
  ( ) Prints their own          Printer: [ Alpine Sports M110  ▾ ]
  (•) Uses issued tickets       Ranges for Ski Swap 2026:
                                  67000 – 67499     (500 tickets, 118 used)   [Remove]
                                  [ from ] [ to ]                             [ Add ]
```

Switching between the two is explicit and refuses to leave the seller with both
(D1). Removing a range whose numbers are already on items is refused, naming
them — those tickets are on the goods.

### 4.2 One item at a time — the seller

For a legacy seller only, `SwapItemsPanel`'s add form replaces the invisible
minted SKU with a first field:

```
Ticket number   [ 67169 ]        ← focused, text selected
                Next in 67000–67499. Type another if this one was
                lost or you are using a different ticket.
Item            [                    ]  optional
Price           [                    ]
```

Pre-selected rather than read-only (D4): typing replaces it, tabbing past
accepts it. The number is validated as they leave the field rather than on
submit, so a bad one is caught before they have typed the rest of the item.

Past the top of their ranges the field opens empty rather than refusing, since
skipped tickets may still be in the box:

```
Ticket number   [                     ]
                No next ticket — you have worked to the end of
                67000–67499. If you have found a skipped one,
                enter its number.
```

The name is optional here as in the CSV (D12); left blank, the item becomes
"Alpine Sports 67169". The **Print** action is hidden for these sellers, and
items save with `hasPrintedTag: true` (D8).

### 4.3 The whole inventory at once — CSV

Mirrors the seller CSV import, which already has the shape: upload → column
mapping with guesses → per-row outcomes.

```
sku,name,price
67169,Rossignol Experience 88 skis 170cm,250.00
67170,,180.00
```

Three columns. `sku` and `price` are required; `name` is optional and may be
blank on a row or absent from the file entirely, in which case the item is named
after the seller and the number (D12). Quantity is always 1 — a ticket is on one
physical thing — and there is no description field.

Column names match through an alias table the way `SellerService.FIELD_ALIASES`
does, so `price`, `Price`, `amount` and `cost` all land on the same field.

Nothing is written until the whole file has been checked. A half-imported
inventory is worse than a rejected one, because the seller cannot tell which
half.

Rows may skip numbers and go backwards; the file is judged row by row against
§5, and the high-water mark has no say here either (D7).

## 5. Validation

Every rule is enforced on the server. The web UI enforces them too, to say so
earlier, but is not where they live.

| Rule | Refused with |
|---|---|
| Row has no ticket number | "Every row needs a ticket number." |
| Row has no price | "Every row needs a price." |
| Number is not all digits | "A ticket number is just the digits on the ticket." |
| Number is outside every range the seller owns | "67600 is not one of your tickets. Yours are 67000–67499." |
| Number already used in this swap | "Ticket 67169 is already on another item." |
| Duplicate numbers within one CSV | Both rows flagged, naming the other's line |
| Seller has no ranges for this swap | "This seller has no ticket ranges for Ski Swap 2026." |
| Every number in the seller's ranges is used (D6) | "All of your tickets are on items. Ask staff for another range." |
| A range overlaps another in the same swap | "67400–67600 overlaps Nordic Sports' 67500–67999." |
| `startNumber` > `endNumber` | "The first number has to be below the last." |
| Assigning a printer to a seller who has ranges (D1) | "This seller uses issued tickets. Remove their ranges first." |
| Adding a range to a seller who has a printer (D1) | "This seller has a printer. Unassign it first." |

A number is judged on two things and no others: it is in one of the seller's
ranges, and no item is using it. Nothing here consults the high-water mark
(D7) — that is what lets a found ticket be entered after the seller has worked
past it.

**Overlap is checked across sellers, not only within one.** Two shops cannot
both hold 67169 in a swap. `@@unique([swapId, sku])` would catch the collision
eventually, but only when the second shop saves an item — mid-swap, at a
counter, against the wrong seller.

**The seller's own path is not a licence to mint SKUs.**
`SellerItemCreateSchema` gains an optional `sku`, accepted *only* when the
seller has ranges and the number falls inside one. An ordinary seller sending a
`sku` is refused, or their number would collide with the minted sequence.

## 6. Square and the register

`SwapItem.sku` becomes the Square variation SKU, so a legacy item is findable at
the register by its printed number with no extra work. Two things to know.

**Two barcode symbologies at one swap.** Our tags are Code 128-B; these tickets
are Code 39. Most scanners read both, but Code 39 is not always enabled out of
the box and some configurations transmit the `*` start/stop characters. This
wants testing with the real scanner before a swap that mixes them — a setting
rather than a code change, and the kind nobody discovers until a queue has
formed.

**Numbers may repeat across swaps** (D11). If the run climbs year to year,
`67169` is used once ever. If it restarts, a block entered again next season
produces a second Square variation with the same SKU: Square permits it and each
swap has its own category, so nothing breaks, but a catalogue-wide SKU search
returns both and a bare number stops identifying an item across seasons. Nothing
here depends on the answer, so it does not block building — it is worth settling
before the second season, and it is decided by what gets ordered from the print
shop rather than by anything in the code.

## 7. Phases

1. **The model and the rules.** `LegacyTicketRange`, its migration, the next
   number derivation, and every rule in §5 with tests. Nothing visible yet.
2. **Assigning ranges.** The Sellers page section, exclusivity with printers from
   both directions, and the guard on removing a range that is in use.
3. **One at a time.** The ticket-number field, its default and pre-selection, the
   hidden Print action, `hasPrintedTag: true`.
4. **The CSV.** Parse, map, validate the whole file, import, report per row.

Phases 1 and 2 are worth landing together — ranges that cannot be assigned are
not testable. 3 and 4 are independent of each other.

## 8. What this costs, honestly

**A number is trusted because it is in range, not because it exists.** We know
which block was issued to a shop, not which tickets they still hold. A shop that
mistypes 67196 for 67169 gets a valid, accepted, wrong number and finds out at
the register. The pre-selected default keeps that rare; nothing prevents it.

**The typed range is the only record of what was handed over.** The range is
authoritative because the organisation issued it — but authoritative only
because someone typed it correctly. Nothing reconciles it against what was
physically counted out, so a transcription error hands a shop numbers that
belong to another shop, or to nobody. The overlap check catches the first;
nothing catches the second until a number is refused as out of range.

**Deleting an item quietly moves the high-water mark.** Numbers are derived from
the items (D5), so deleting the *highest* item makes its number the suggestion
again — right if the entry was a mistake, wrong if the ticket is already on goods
on the floor. Deleting anything below the mark leaves another gap the suggestion
will skip, though the number can still be typed. Staff deleting a legacy item
should know which of the two they have just done.

**Without a pool, nothing knows what is left** (D10). "How many tickets have we
handed out, and how many are still in the box?" is unanswerable, because the app
is only ever told about blocks after the fact. If that question starts being
asked, recording the swap's full run and issuing from it sits neatly on top of
this model.

## 9. Out of scope

- **Sourcing or printing the tickets.** The organisation orders the pads and
  hands them out; this plan records which numbers went where. Producing them is
  a print-shop job.
- **Tracking the run itself.** No pool, per D10 — §8 covers what that costs.
- **Reconciling unsold tickets.** Knowing which of a shop's 500 came back unused
  is a settlement question, and settlement is not built. More plausible as a
  future want now that the tickets are ours to get back.
- **Carrying ranges between swaps.** D2 settles this. If re-entering blocks each
  season becomes the annoyance, copying last year's forward is a small addition.
- **Individual sellers.** Legacy tickets are a business-seller arrangement. An
  individual checking in at a station gets a printed tag.
