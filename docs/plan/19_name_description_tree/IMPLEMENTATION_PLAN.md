# Plan 19 — Describing an item by picking, not typing

An item's identity today is a string a seller typed on a phone. "Volkl Kendo
177", "vokl kendos", "SKIS 177cm blue". The register sells them all equally
well, and nothing else can do anything with them at all.

This plan replaces the typed name with a tree of questions. The seller picks a
category, answers as many or as few of its questions as they care to, and the
name is composed from the answers. Free text does not disappear — it moves to
`description`, where it belongs, as notes.

It covers `apps/api` and `apps/web`. The native staff-iPad app in
`patrolkit_ios` consumes the same item contract and needs the same picker; that
is its own piece of work, sequenced after this one (§10).

## 1. The gap

`SwapItem` carries `name String` and `description String?`. Both are opaque.
Four things consume them and none can do better than pass them through:

| Consumer | What it does with the name |
|---|---|
| `printing/label-templates.ts` | Shrinks it to fit the tag (`fitted(ctx, item.name, 24, 15, W)`) |
| `pos/square.pos.adapter.ts` | Sends it as the catalogue object's name, description as its description |
| `public-seller.service.ts` / seller website | Prints it in a list |
| `SwapItemsPanel`, `ItemsStep` | A text input with a placeholder as the only guidance |

Nothing can filter by manufacturer, group the floor by category, tell a seller
what a Head Kore 112 went for last year, or notice that four people have
brought the same jacket. Not because the queries are hard, but because the data
to query does not exist. It was never captured, and it cannot be recovered from
the strings afterwards.

The placeholder in `ItemsStep` — `"What is it? e.g. Volkl Kendo skis, 177cm"` —
is the shape of the answer the system wants. It just has no way to ask for it.

## 2. Decisions

| # | Decision | Why |
|---|---|---|
| D1 | One self-referential `TaxonomyNode` table with a `kind` of CATEGORY, ATTRIBUTE or VALUE | The tree in the brief *is* alternating category→attribute→value→attribute. One table means branching costs nothing extra, and there is one place to look. §2.1 |
| D2 | Two scopes in one table: `orgId = null` is global, `orgId` set is that org's | Promotion is then a column change, not a copy between tables. An org's tree is the global tree plus its own rows; there is no merge step and no divergence. |
| D3 | An item stores **pointers**; its derived name is what is frozen | Two columns, two questions. The pointers answer "what is this, today" and follow the tree as it is tidied. `SwapItem.name` answers "what did we print" and never moves. §2.2 |
| D4 | A node any item points at is **retired, never deleted** | `retiredAt` hides it from new picks; the foreign key refuses the delete. This is what makes D3 safe: a pointer can never dangle. |
| D5 | `SwapItem.name` stays, and is **derived** on write | Every existing consumer — tag, Square, seller site, CSV, receipt — keeps working untouched. The name becomes a projection of the attributes rather than an independent fact. |
| D6 | Nothing is required except the category and the price | A seller at a table with a queue behind them answers two questions or eight, their choice. "Skis — $45" is a valid item, and it is *less* typing than today. |
| D7 | Free entry mints a **pending org value**, usable immediately | The seller cannot be blocked at the table by a brand nobody entered yet. The org sees it in a queue afterwards and decides whether it joins the list. §8 |
| D8 | The escape hatch is a category, not a text box | An `Other` category whose one question is a free-entry SELECT. Anything the tree cannot describe becomes a pending value, which is exactly the signal the org needs to grow the tree. One mechanism, not two. |
| D9 | Only SELECT values branch; NUMBER answers are leaves | A continuum has no children. Saying so in the model stops the UI generator having to ask. |
| D10 | Approving, and promoting, are separate acts by separate people | An org approves for itself (`ski_swap:admin`). A platform admin promotes to global (`SuperAdminGuard`). Neither can do the other's job. |
| D11 | A node's optional icon is **either** a compiled-in registry key **or** an uploaded image, never both | The registry covers what the app already draws, costs no request and matches the rest of the UI; an upload covers what it does not, without waiting for a release. Two nullable columns and an exclusivity rule, not a polymorphic one. §4.4 has the mechanics. |
| D12 | The CSV import paths keep free text and are out of scope | `legacy-ticket.service.ts` and the proxy-seller importer map a column to `name`. Structured import is a column-mapping problem of its own; see §10. |

### 2.1 Why one node table

The two examples in the brief are the same shape:

```
Skis ──┬── Manufacturer ── Head ── Model ── Kore
       ├── Color ──────── Black
       ├── Length ─────── 112cm
       └── Type ───────── Powder

Jacket ┬── Manufacturer ── Helly Hansen
       ├── Gender ─────── Mens
       └── Color ─────── Blue
```

Read the levels: a **category** has **attributes**; an attribute has **values**;
a value may have further **attributes**. It alternates, forever, and the
alternation is the only rule. A schema with three tables has to express that
same rule in three foreign keys, two of which are the same edge wearing
different names.

One table with `kind` and `parentId` gives it in one:

- `parentId = null` ⇒ a CATEGORY.
- An ATTRIBUTE's parent is a CATEGORY (asked always) or a VALUE (asked only
  when that value is chosen).
- A VALUE's parent is its ATTRIBUTE.

Subcategories fall out of this without being modelled. "Skis → Type → Alpine →
(Waist width, Rocker profile)" is a value with attributes under it; it behaves
as a subcategory and needs no new concept. That is why D9 exists: the one
constraint worth enforcing is that NUMBER attributes cannot have children,
because a number is not a branch point.

### 2.2 Two columns, two questions

An item's answers are foreign keys into the tree. Its name is a string derived
once and never recomputed by anything but an edit to that item. The pair is
deliberate, and each half answers a different question.

**`SwapItem.name` is the historic record.** Derived on write (D5), it is what
the receipt shows, what came out of the label printer, and what sits in the
Square catalogue. A platform admin renaming "Volkl" to "Völkl" in March touches
no item row; last autumn's items go on saying "Volkl Kendo 177cm Skis" because
that is what they said.

**The pointers are the live reading.** `attributeId` and `valueId` always
resolve, because a node in use cannot be deleted (D4), so an old item's detail
view renders its answers against the tree as it stands now. That is what a
report groups by, and it is why fourteen clubs' "Rossignol" become one the
moment they are merged, with nothing to migrate.

So the two are allowed to disagree: an item named "Volkl Kendo 177cm Skis"
whose Manufacturer now reads "Völkl". That is the right reading — same skis,
same brand, better spelling — not a defect to reconcile.

The case this does not cover is a rename used as a repurpose: renaming "Blue"
to "Navy" because someone wanted a Navy option turns a hundred blue jackets
navy. The defence is that renaming is not how a value is added, `retiredAt`
makes retire-and-add free, and the audit log records who did it.

## 3. The model

MySQL 8.0, which treats `NULL`s in a unique index as distinct. That shapes the
dedupe column below.

```prisma
enum TaxonomyKind {
  CATEGORY
  ATTRIBUTE
  VALUE
}

enum TaxonomyInput {
  /// Pick one of the child VALUE nodes. The only kind that branches.
  SELECT
  /// Type a number, rendered with `unit`. A leaf, always (D9).
  NUMBER
}

enum TaxonomyStatus {
  /// Offered to everyone in scope.
  APPROVED
  /// Minted by free entry. Usable by the item that created it, and visible in
  /// the org's queue. Not offered to anyone else until approved (D7).
  PENDING
}

/// One node of the item-description tree: a category, a question, or an answer.
///
/// Global rows (`orgId = null`) are curated by platform admins and visible to
/// every org. Org rows are that org's own, and may hang off a global parent —
/// that is how an org adds a brand to the shared Manufacturer list without
/// forking it (D2).
model TaxonomyNode {
  id       String       @id @default(cuid())
  kind     TaxonomyKind
  /// Null ⇒ global. Set ⇒ belongs to one org.
  orgId    String?
  /// Null only for a CATEGORY.
  parentId String?

  /// What the seller reads. Also what lands in the derived name, so it is
  /// written the way it should print: "Helly Hansen", not "helly-hansen".
  label String @db.VarChar(120)

  // ── Icon: at most one of the two (D11) ────────────────────────────────────
  /// A key into the web app's icon registry (§4.4) — `"skis"`, `"jacket"`.
  /// Never a Font Awesome name, and validated against the registry on write so
  /// a typo is refused at the admin screen rather than discovered as a blank
  /// chip.
  iconKey String? @db.VarChar(40)

  /// A 128×128 PNG for a node the registry does not cover (§4.4).
  ///
  /// `iconUrl` is the only one of the three clients read, and it is always a
  /// URL — never a data URI. One of the other two holds the bytes: `iconS3Key`
  /// when S3 is configured, keyed by node id so promotion (§8.4) needs no
  /// copy; `iconBlob` otherwise, read only by the proxy route.
  iconUrl   String? @db.Text
  iconS3Key String? @db.VarChar(300)
  iconBlob  Bytes?  @db.MediumBlob

  // Both kinds set is the one illegal combination, enforced in the service.
  // Prisma cannot express CHECK, so the constraint below is optional and
  // hand-written if wanted:
  //   CONSTRAINT icon_one_of CHECK (iconKey IS NULL OR iconUrl IS NULL)

  status       TaxonomyStatus @default(APPROVED)
  displayOrder Int            @default(0)
  /// Hides a node from new picks without deleting it. A node any item points
  /// at may never be hard-deleted, and this is how it leaves the tree
  /// instead (D4).
  retiredAt    DateTime?

  // ── ATTRIBUTE only ────────────────────────────────────────────────────────
  input TaxonomyInput?
  /// Where this answer sits in the derived name, ascending. Null ⇒ captured
  /// but not named — a detail worth having in a report and not on a tag (§5).
  nameSlot Int?
  /// Appended to a NUMBER with no space: 112 + "cm" ⇒ "112cm".
  unit     String? @db.VarChar(12)
  minValue Float?
  maxValue Float?
  step     Float?
  /// Whether a seller may type a value that is not listed, minting a PENDING
  /// org value (D7). SELECT only.
  allowFreeEntry Boolean @default(false)

  // ── Dedupe ────────────────────────────────────────────────────────────────
  /// `<orgId|global>:<parentId|root>:<label lower-cased, trimmed, spaces
  /// collapsed>`. One non-null column rather than a composite unique, because
  /// both `orgId` and `parentId` are nullable and MySQL would let two global
  /// categories with the same label through. Maintained in the service, never
  /// by the client.
  dedupeKey String @unique @db.VarChar(400)

  createdBy String?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  /// Who approved a PENDING value, and when. Null while pending.
  approvedBy String?
  approvedAt DateTime?

  org      Organization?  @relation(fields: [orgId], references: [id], onDelete: Cascade)
  parent   TaxonomyNode?  @relation("TaxonomyTree", fields: [parentId], references: [id], onDelete: Cascade)
  children TaxonomyNode[] @relation("TaxonomyTree")
  itemAttributeUses SwapItemAttribute[] @relation("AttributeNode")
  itemValueUses     SwapItemAttribute[] @relation("ValueNode")

  @@index([orgId, kind])
  @@index([parentId, displayOrder])
  /// The org approval queue, which is the only query that wants status alone.
  @@index([orgId, status])
}
```

The item side:

```prisma
model SwapItem {
  // … unchanged …

  /// The CATEGORY node this item was described under. Null for an item
  /// created by an importer that only had a name (D12).
  categoryId String?

  attributes SwapItemAttribute[]

  @@index([orgId, categoryId])
}

/// One answered question on one item. Pointers only (D3); labels are read back
/// through the tree, which D4 guarantees is still there.
model SwapItemAttribute {
  id     String @id @default(cuid())
  itemId String

  /// The ATTRIBUTE node that was asked.
  attributeId String
  /// The VALUE node that was picked. Null for a NUMBER answer, which has no
  /// node to point at — the answer is the number.
  valueId     String?
  /// The NUMBER answer, unrendered. Its unit comes from the attribute, so a
  /// report compares 112 to 115 rather than parsing "112cm".
  numberValue Float?

  createdAt DateTime @default(now())

  item      SwapItem      @relation(fields: [itemId], references: [id], onDelete: Cascade)
  // Restrict, deliberately: this is where D4 is enforced.
  attribute TaxonomyNode  @relation("AttributeNode", fields: [attributeId], references: [id], onDelete: Restrict)
  value     TaxonomyNode? @relation("ValueNode", fields: [valueId], references: [id], onDelete: Restrict)

  /// One answer per question per item.
  @@unique([itemId, attributeId])
  @@index([valueId])
}
```

`SwapItemPhoto` is untouched. `SkiSwapSettings` gains one column:

```prisma
model SkiSwapSettings {
  // … unchanged …

  /// Bumped whenever any node visible to this org changes — its own, or a
  /// global one. The clients' cache key (§7.2). A counter rather than a
  /// timestamp because the phone compares it for equality, not for order.
  taxonomyVersion Int @default(1)
}
```

Pre-production, so the database is dropped and reseeded rather than migrated.
No backfill is written: there are no live rows whose names need decomposing.

## 4. The resolved tree — the contract the UI is generated from

Everything in §6 is a rendering of this document.

### 4.1 Shape

```ts
interface ResolvedTaxonomy {
  /** Matches SkiSwapSettings.taxonomyVersion. The client's cache key. */
  version: number;
  categories: ResolvedCategory[];
}

/**
 * A node's icon, absent when it has none. Discriminated rather than two
 * optional fields, so a renderer cannot forget to check the second one.
 */
type ResolvedIcon =
  | { kind: 'registry'; key: string }   // look up in TAXONOMY_ICONS (§4.4)
  | { kind: 'image'; url: string };     // 128×128 PNG, render in an <img>

interface ResolvedCategory {
  id: string;
  label: string;                  // "Skis"
  /** Absent ⇒ render the label alone (§4.4). */
  icon?: ResolvedIcon;
  scope: 'global' | 'org';
  displayOrder: number;
  attributes: ResolvedAttribute[];
}

interface ResolvedAttribute {
  id: string;
  label: string;                  // "Manufacturer"
  icon?: ResolvedIcon;
  scope: 'global' | 'org';
  input: 'select' | 'number';
  displayOrder: number;
  /** Position in the derived name, ascending. Null ⇒ not named (§5). */
  nameSlot: number | null;

  // input === 'select'
  allowFreeEntry?: boolean;
  values?: ResolvedValue[];
  /** True ⇒ `values` is absent and must be fetched (§7.2). */
  valuesDeferred?: boolean;

  // input === 'number'
  unit?: string;                  // "cm"
  min?: number;
  max?: number;
  step?: number;
}

interface ResolvedValue {
  id: string;
  label: string;                  // "Head"
  icon?: ResolvedIcon;
  scope: 'global' | 'org';
  displayOrder: number;
  /** Questions that appear only once this value is chosen. Empty for a leaf. */
  attributes: ResolvedAttribute[];
}
```

Notes the generator depends on:

- Only APPROVED, un-retired nodes appear. A PENDING value is never in this
  document — the client that minted it holds it in local state for that one
  item (§8.1).
- `scope` is informational: it drives an "added by your club" marker in the
  admin screens and nothing in the seller UI. Sellers should not be able to
  tell where a value came from.
- Order within a level is `displayOrder`, then `label` as the tiebreak.

### 4.2 Rendering rules

| Condition | Control |
|---|---|
| Categories | A grid of tappable chips, one per category, each with its `icon` above its label. The one place an icon does real work: it is how a category is found at a glance on a phone. |
| `input: 'select'`, ≤ 8 values, no deferral | A row of chips. One tap, no dropdown, no keyboard. An `icon` renders inline before the label. |
| `input: 'select'`, > 8 values | A searchable select (`components/SearchableSelect`, already in the codebase). Icons render in the list rows, not in the closed control. |
| `input: 'select'` with `allowFreeEntry` | The same control, plus a persistent "Add …" row carrying whatever has been typed (§8.1). |
| `input: 'number'` | A numeric field, `inputMode="numeric"`, suffixed with `unit`, validated against `min`/`max`/`step` client-side and again on the server. |
| `valuesDeferred` | Renders disabled until its parent is chosen; fetches on first open and shows a spinner in the list, not over the form. |
| Any answered SELECT with nested `attributes` | Those attributes render **indented directly beneath it**, in `displayOrder`. Clearing the parent clears them and discards their answers. |
| Every attribute | Optional. No asterisks, no validation on submit, no "required" anywhere except the category (D6). |
| `icon.kind === 'registry'` | `<FontAwesomeIcon icon={TAXONOMY_ICONS[icon.key]} />`. Inherits the text color, so it is theme-correct for free. |
| `icon.kind === 'image'` | An `<img>` at the same box size, `loading="lazy"`, with `alt=""` — the label beside it is already the accessible name, so the image is decorative. |
| `icon` absent, or a registry key this build does not know | Render the label alone, with no gap where an icon would be. Never a placeholder glyph, and never a broken-image frame: a missing icon should be invisible. |

The form is therefore a fold over one category's attributes, where choosing a
value splices that value's attributes into the list at its own position. The
recursion has no depth limit in the model; the UI should stop indenting after
two levels and rely on order alone, because a phone has no room for a third
rail.

### 4.3 The brief's examples, resolved

```jsonc
{
  "id": "cat_skis", "label": "Skis", "icon": { "kind": "registry", "key": "skis" },
  "scope": "global", "displayOrder": 10,
  "attributes": [
    {
      "id": "att_ski_mfr", "label": "Manufacturer", "input": "select",
      "displayOrder": 10, "nameSlot": 10, "allowFreeEntry": true,
      "values": [
        {
          "id": "val_head", "label": "Head", "displayOrder": 20,
          "attributes": [
            { "id": "att_head_model", "label": "Model", "input": "select",
              "displayOrder": 10, "nameSlot": 20, "allowFreeEntry": true,
              "valuesDeferred": true }
          ]
        },
        { "id": "val_volkl", "label": "Volkl", "displayOrder": 30, "attributes": [ /* its own models */ ] }
      ]
    },
    { "id": "att_ski_len", "label": "Length", "input": "number",
      "displayOrder": 20, "nameSlot": 30, "unit": "cm", "min": 70, "max": 215, "step": 1 },
    { "id": "att_ski_type", "label": "Type", "input": "select",
      "displayOrder": 30, "nameSlot": 40,
      "values": [
        { "id": "val_powder", "label": "Powder", "displayOrder": 10, "attributes": [] },
        { "id": "val_allmtn", "label": "All-mountain", "displayOrder": 20, "attributes": [] }
      ] },
    { "id": "att_ski_color", "label": "Color", "input": "select",
      "displayOrder": 40, "nameSlot": 50, "values": [ /* … */ ] }
  ]
}
```

Answering Manufacturer=Head, Model=Kore, Length=112, Type=Powder yields the
name **"Head Kore 112cm Powder Skis"**. The jacket example — Manufacturer=Helly
Hansen, Gender=Mens, Color=Blue with slots 10/20/30 — yields **"Helly Hansen
Mens Blue Jacket"**.

### 4.4 Icons

A node may carry a registry icon or an uploaded image, and no node carries both
(D11). The two exist for different reasons and the order matters: the registry
is the default, and an upload is what covers the gap.

**The registry, for what the app already draws.** Every icon in `apps/web` is a
static named import — `import { faPrint as faPrintDuo } from
'@fortawesome/pro-duotone-svg-icons'` — and the bundler drops the rest of the
Pro set. There is no `library.add`, no `findIconDefinition`, no dynamic lookup
anywhere. Resolving a database string against the whole duotone set at runtime
would add megabytes to the bundle a seller's phone pulls over venue wifi, so
`iconKey` indexes a map instead:

```ts
// apps/web/src/lib/taxonomyIcons.ts — the single file to edit to add one.
import { faSkiing, faSnowboarding, faHelmetSafety /* … */ } from '@fortawesome/pro-duotone-svg-icons';

export const TAXONOMY_ICONS = {
  skis:      faSkiing,
  snowboard: faSnowboarding,
  helmet:    faHelmetSafety,
  // …
} as const;

export type TaxonomyIconKey = keyof typeof TAXONOMY_ICONS;
```

A registry icon costs no request and inherits the surrounding text color, so it
is correct in both themes with nothing asked of whoever chose it. The key list
is mirrored as a string array in `contracts/ski-swap.contracts.ts` and enforced
by the Zod schema, with a test asserting the two match. Ship it broad — roughly
sixty keys covering gear and apparel — so the common cases need no upload.

**An upload, for what it does not cover.** A platform admin adding a
"Splitboard" category, or a club whose own value wants a mark, uploads a small
image rather than waiting for a release. This follows the org-logo flow in
`orgs.service.ts:55` rather than inventing a second pattern:

- `FileInterceptor` with a 2MB limit, accepting PNG, JPEG, WebP or SVG.
- Always re-encoded through `sharp` — already a dependency, used for item
  photos — to a 128×128 PNG, `fit: 'inside'`, transparency preserved. One size,
  because the only sizes drawn are a 40px chip and a 20px list row and a retina
  chip wants 80. Rasterizing is also what makes an SVG upload safe: whatever
  script or external reference it carried does not survive.
- Stored at `taxonomy-icons/{nodeId}.png`. Keyed by node id alone, so promoting
  an org node to global (§8.4) needs no copy and no re-point.
- `iconUrl` always holds a URL, never a data URI. With S3 configured it is the
  object's URL; without, the bytes go in `iconBlob` and it points at a proxy
  route — `GET …/taxonomy/nodes/:id/icon`, the shape `orgs.controller.ts:31`
  already uses for logos, with a long `Cache-Control`. The org logo inlines
  itself; thirteen inlined category images in one tree response would undo
  §7.2.
- A global node's icon is uploaded by a platform admin and seen by every org;
  an org node's by `ski_swap:admin`, and seen only there. Sellers never upload
  an icon.

An upload is a request a seller's phone makes on arrival, which is why the
rendering rule says `loading="lazy"` and why the picker in §6.4 offers the
registry first. On a forty-entry model list neither kind is worth it, and the
seed leaves them null.

## 5. The derived name

One function, used by every write path, server-side only. The client may
preview it; it may not supply it. The write path has already loaded the
category's subtree to validate the answers (§7.3), so every label it needs is
in hand:

```
deriveName(category, answers) =
  answers
    .map(a => ({ attr: node(a.attributeId), value: node(a.valueId), num: a.numberValue }))
    .filter(x => x.attr.nameSlot !== null)
    .sort(by attr.nameSlot, then by attr.displayOrder)
    .map(x => x.value ? x.value.label : `${x.num}${x.attr.unit ?? ''}`)
    .concat(category.label)
    .join(' ')
```

The category label goes last because English puts the head noun there, and
because it is the one part always present — a name is never empty, and an item
with no answers at all is simply "Skis".

Four consequences worth stating:

- **The tag.** `label-templates.ts` already shrinks a name to fit and will go
  on doing so. A fully answered item is longer than most typed names, so expect
  smaller type on a 40×30. `nameSlot: null` is the lever: a detail the org
  wants in reports but not on the tag gets no slot. Seed accordingly — Color
  earns a slot, Rocker profile does not.
- **Square.** `syncItemToPos` sends `item.name` as it always has. Nothing in
  the POS adapter changes.
- **It is computed once and then frozen.** Derived on create, re-derived when
  that item's own answers are edited, and at no other time. A rename in the
  tree touches no item row (§2.2). An item edited afterwards picks up the
  current spelling, because editing it is someone saying so.
- **Duplicates are expected and fine.** Two people bringing the same skis now
  produce the same name, distinguished by SKU as they already are. That is what
  makes "how many Head Kore 112s are on the floor" a question with an answer.

`description` keeps its current type and its 2000-character limit, and is
relabelled **Notes** in every UI. It never enters the name. It continues to go
to Square as the catalogue description and to the seller site as detail.

## 6. The screens

### 6.1 Self check-in — `pages/checkin/ItemsStep.tsx`

The screen this plan is really about: a phone, a seller standing beside a pile,
roughly 300px of usable height above the keyboard.

```
┌──────────────────────────────┐
│ Add your items               │
│                              │
│ What is it?                  │
│ ┌────┐┌────┐┌────┐┌────┐     │
│ │ ◆  ││ ◆  ││ ◆  ││ ◆  │     │   ← the node's icon (§4.4)
│ │Skis││Brd ││Boot││Jckt│     │
│ └────┘└────┘└────┘└────┘     │
│ [Pants][Helmet][More…]       │
│                              │
│ ── Skis ─────────────  Change│   ← collapses to a header once picked
│ Manufacturer                 │
│ [ Head          ▾ ]          │
│   Model                      │   ← indented: Head's branch
│   [ Kore         ▾ ]         │
│ Length                       │
│ [ 112      ] cm              │
│ Type                         │
│ [Powder][All-mountain][Park] │
│                              │
│ + More detail (2)            │   ← the rest, collapsed
│                              │
│ Head Kore 112cm Powder Skis  │   ← live preview of the name
│                              │
│ Price  [ 45.00 ]             │
│ Notes (optional) [        ]  │
│ 📷 Add a photo (optional)    │
│                              │
│ [ Add item and print tag ]   │
└──────────────────────────────┘
```

- Category first, alone, full width. Nothing else renders until it is picked.
- The first three or four attributes by `displayOrder` show; the rest sit
  behind **More detail (n)**. The count is the honest signal that there is more
  and that skipping it is allowed.
- The name preview is the feedback loop that makes the form make sense — it is
  what shows a seller that answering one more question improves their listing.
- `Add item and print tag` enables on category + valid price. Unchanged in
  every other respect: the idempotency key, the photo best-effort upload, the
  localStorage draft.
- The **draft** in `localStorage` grows from `{name, price}` to
  `{categoryId, answers, price, notes}`. Its key is versioned so a stale draft
  from the old shape is discarded rather than parsed into nonsense.

### 6.2 Staff web — `SwapItemsPanel.tsx`

The same picker component as §6.1, laid out for a wider screen: attributes in
two columns, nothing collapsed behind **More detail**, the name preview on the
line where the name input used to be. `ItemFormData` loses `name` and gains
`categoryId` and `answers`; `description` stays and is relabelled Notes.

`CreateItemInput`/`PatchItemInput` lose `name` and gain `categoryId` and
`attributes`. The ticket-seller path (`tickets` prop), the SKU handling, the
printing and the photo flow are all untouched.

The **edit** case needs one rule: opening an item whose category has since
changed shape must not discard answers. Load the item's stored answers, render
the current tree, and show any answer whose attribute is no longer in the tree
as a read-only line with a "remove" affordance. Silent loss on open is the one
failure mode here that would be hard to notice and impossible to undo.

### 6.3 The org's taxonomy — a tab on `AdministrationPage`

`ski_swap:admin`, beside the existing ski-swap settings.

```
Item details

Waiting for approval (3)
┌────────────────────────────────────────────────────────────────┐
│ "Rossignol"     Skis › Manufacturer         2h ago · 4 items   │
│   Similar: Rossignol (global)  [Use that instead]              │
│                                [Approve]  [Discard]            │
│ "Kore 99"       Skis › Head › Model         2h ago · 1 item    │
│                                [Approve]  [Discard]            │
│ "vintage sled"  Other › What is it?         1d ago · 1 item    │
│                                [Approve]  [Discard]            │
└────────────────────────────────────────────────────────────────┘

Your club's values (12)                            [Add a value]
┌────────────────────────────────────────────────────────────────┐
│ Skis › Manufacturer › Wagner   6 items   ◆ icon  [Edit]        │
│                                          [Suggest for everyone]│
└────────────────────────────────────────────────────────────────┘

The shared list                                       (read only)
  Skis, Snowboard, Boots, Poles, Helmet, Jacket, Pants, …
```

- **Similar** is a normalized-label near match against the resolved tree,
  computed when the queue is rendered. It is the difference between a taxonomy
  and a pile: "Rossignol" pending next to "Rossignol" global should be one
  click to merge, not a judgement call.
- **Use that instead** is the merge of §8.3.
- **Discard** is disabled while any item uses the value, which is every pending
  value until one is edited away from it (§8.1). The two live choices on a
  fresh pending value are Approve and Use that instead.
- **Suggest for everyone** raises a promotion request (§8.4). The org cannot
  promote; it can only ask.
- An org value may carry an icon: the same registry staff see, or an image the
  club uploads for a mark the registry has no equivalent of (§4.4).
- The shared list is visible and not editable here. An org that wants a global
  change asks for one.

### 6.4 The global taxonomy — a tab on `pages/admin/AdminLayout.tsx`

`SuperAdminGuard`, beside Organizations / Users / Device Software.

- A tree editor over global nodes: add, rename, reorder, retire. Adding an
  attribute asks for its input kind, unit and `nameSlot`; adding a value asks
  only for a label and whether it branches.
- An **icon picker** on every node, in the order §4.4 argues for: the registry
  grid first, searchable by key; an **Upload an image** tab behind it; and a
  "no icon" option that is the default and needs to look like a deliberate
  choice rather than an empty state. Choosing either clears the other, because
  both cannot be set (D11). The category form shows the picker above the fold;
  the value form puts it behind a disclosure.
- A **promotion inbox**: every org value flagged with **Suggest for everyone**,
  grouped by the global parent it would land under, with a usage count across
  orgs. Promoting sets `orgId = null` and, if any ancestor is still org-scoped,
  promotes the ancestors first — a global node may never have an org parent,
  and the endpoint enforces it rather than trusting the UI.
- Renaming a global node bumps `taxonomyVersion` for every org. Retiring one
  hides it from new picks and changes nothing already captured (D4).

## 7. The API

### 7.1 Reading

```
GET  /orgs/:orgId/ski-swap/taxonomy
     → ResolvedTaxonomy  (APPROVED, un-retired: global ∪ this org's)
GET  /orgs/:orgId/ski-swap/taxonomy/nodes/:nodeId/children
     → ResolvedAttribute[] | ResolvedValue[]   (a deferred branch)
```

Reachable by anyone who can create an item: `ski_swap:manage` on the staff
paths, and the `SellerProfileGuard` path (`/orgs/:orgId/ski-swap/seller/me/…`)
for self check-in. A seller sees the same tree staff do.

### 7.2 Caching, and why `valuesDeferred` exists

The whole tree with every manufacturer's model list is hundreds of kilobytes,
fetched over a venue's wifi by a phone that is also uploading photos. So:

- The eager document carries categories, their attributes, and the values of
  every attribute hanging off a **category**. Attributes hanging off a
  **value** — the model lists — come back with `valuesDeferred: true`.
- `version` is `SkiSwapSettings.taxonomyVersion`, returned as the `ETag` and
  cached client-side under it. Any write to a node visible to an org bumps it;
  a global write bumps every org's.
- Deferred branches are fetched once per session and cached under the same
  version.

### 7.3 Writing an item

`CreateItemSchema` and `PatchItemSchema` drop `name` and gain:

```ts
categoryId: z.string(),
attributes: z.array(z.object({
  attributeId: z.string(),
  /** An existing value. Exclusive with `numberValue` and `freeText`. */
  valueId: z.string().optional(),
  numberValue: z.number().optional(),
  /** A value the seller typed. Mints a PENDING org value (§8.1). */
  freeText: z.string().max(120).optional(),
})).max(24).default([]),
description: z.string().max(2000).optional(),   // unchanged, now "Notes"
```

The service validates that every `attributeId` is reachable from `categoryId`
in this org's tree, that a `valueId` is a child of its attribute, that a
`numberValue` is within range and lands on the step, and that free entry is
only used where `allowFreeEntry` is set. Then it derives the name (§5) and
writes the item and its `SwapItemAttribute` rows in one transaction.

`ItemResponseSchema` keeps `name` and `description` exactly as they are — every
existing client keeps working — and gains `category: { id, label } | null` and
`attributes: { attributeId, attributeLabel, valueId, valueLabel, numberValue }[]`.
Those labels are resolved through the tree on read rather than stored (D3), so
they are current while `name` beside them is historic.

### 7.4 Managing the tree

```
POST   /orgs/:orgId/ski-swap/taxonomy/values          mint (staff, explicit)
PATCH  /orgs/:orgId/ski-swap/taxonomy/nodes/:id       approve · rename · reorder · retire · set iconKey
POST   /orgs/:orgId/ski-swap/taxonomy/nodes/:id/merge → { targetId }
POST   /orgs/:orgId/ski-swap/taxonomy/nodes/:id/suggest
DELETE /orgs/:orgId/ski-swap/taxonomy/nodes/:id       discard an *unused* PENDING value

POST   /orgs/:orgId/ski-swap/taxonomy/nodes/:id/icon   multipart upload, 2MB
DELETE /orgs/:orgId/ski-swap/taxonomy/nodes/:id/icon   clears both columns
GET    /orgs/:orgId/ski-swap/taxonomy/nodes/:id/icon   the bytes, when S3 is off

GET    /admin/taxonomy                                 global tree
POST   /admin/taxonomy/nodes                           add global
PATCH  /admin/taxonomy/nodes/:id
POST   /admin/taxonomy/nodes/:id/icon                  global upload
DELETE /admin/taxonomy/nodes/:id/icon
GET    /admin/taxonomy/suggestions                     promotion inbox
POST   /admin/taxonomy/nodes/:id/promote               orgId → null, ancestors first
```

`iconUrl` and `iconS3Key` are written only by the upload and delete routes,
never by `PATCH` — a client that could set the URL directly could point a node
at anything. `PATCH` carries `iconKey` alone, and setting it clears an uploaded
image along with its object.

Org routes take `ski_swap:admin`; `/admin/*` takes `SuperAdminGuard`, matching
`PlatformController`. Every state change writes an audit entry under
`ski_swap.taxonomy.*` — `value.approved`, `value.merged`, `node.promoted`,
`node.retired` — following the `ski_swap.device_pin.updated` convention.

## 8. Free entry, approval, promotion

The lifecycle is the point of the two-tier design, so it is worth stating end
to end.

```
seller types "Rossignol"
      │
      ▼
PENDING org value ──approve──► APPROVED org value ──suggest──► promotion inbox
      │                              │                              │
      │                              └──merge──► an existing value  │
      └──discard──► deleted, once no item uses it (D4)          promote
                                                                    │
                                                                    ▼
                                                           APPROVED global value
```

### 8.1 Minting, at the table

Free entry is allowed wherever `allowFreeEntry` is set. The client shows an
`Add "Rossignol"` row under the filtered list once what has been typed matches
nothing exactly. Taking it sends `freeText` with the item; the server creates a
PENDING org node under that attribute and points the item's answer at it, in
the same transaction as the item.

The value is usable immediately by the item that created it, because a seller
with a queue behind them cannot wait for an approval. It is not offered to the
next seller: it is not in the resolved tree until approved.

Before minting, the server checks `dedupeKey`. An exact normalized match — same
scope, same parent, same label — returns the existing node instead of a second
one, approved or pending. Two sellers typing "Rossignol" ten minutes apart
produce one pending value with two items behind it, which is what the queue in
§6.3 counts.

That count is also why discarding is rarely available: every pending value has
at least one item behind it, since one created it, and the foreign key refuses
to delete a node in use (D4). The endpoint returns the usage count rather than
a constraint error, so the UI can disable the button rather than fail the
click.

### 8.2 Approving

`ski_swap:admin` flips `status` to APPROVED, stamps `approvedBy`/`approvedAt`,
bumps `taxonomyVersion`. The value now appears for everyone in the org. The
items already pointing at it are untouched — they were already right.

### 8.3 Merging

**Use that instead** repoints every `SwapItemAttribute.valueId` from the
pending node to the target and deletes the pending node. No item rows are
rewritten.

The affected items' `name` columns are **not** recomputed. A merge says the two
values were always the same thing; it does not claim the tag that was printed
said something else, and correcting the name would mean correcting a label
already stuck to a pair of skis. The audit entry records both labels and the
item count, so an item named "Rossignal Skis" whose Manufacturer now reads
"Rossignol" has a traceable cause.

Merging is available to `ski_swap:admin` between any two org values, not only
from a pending one — the same operation cleans up a pair that were both
approved by mistake.

### 8.4 Promoting

An org suggests; a platform admin promotes. Promotion is `orgId = null`, with
two guards:

- **Ancestors first.** A global node may not have an org parent. The endpoint
  walks up and promotes the chain, or refuses and says which ancestor is in the
  way.
- **Collision.** If a global node already exists with the same normalized label
  under the same parent, promotion becomes a merge into it (§8.3), across every
  org that has its own copy. That is the payoff of the two-tier scheme:
  fourteen clubs' "Rossignol" collapse into one.

An uploaded icon needs no attention here: the S3 key is the node id, so the
image is already where a global node's image lives (§4.4).

Promotion bumps `taxonomyVersion` for every org.

## 9. The seed, and the round trip

Ships as a data file — `prisma/taxonomy.json`, consumed by `prisma/seed.ts` —
so the global tree is reproducible and reviewable in a diff rather than clicked
into existence.

It seeds a database **once**. The moment a database has a tree, that database is
the authority on it: the shared list is curated in §6.4, and nothing in a git
branch knows what a platform admin decided there yesterday. So the direction of
truth reverses after the first run, and `db:export-taxonomy` writes the database
back out to the same file for source control and for the next new environment.

Editing the file therefore does not change an existing server — add the category
in the admin screen and export. Replaying it would not merely be useless: a node
renamed since the last export no longer matches its `dedupeKey`, so the old one
is created again, and for a renamed category or question the whole subtree comes
back with it. Running once is what puts that out of reach.

The file carries no node ids. The same logical node has a different cuid in
every database — environments are seeded independently — so ids would make it
portable nowhere. Identity is the label and where it sits, which is what
`dedupeKey` already keys on.

Categories to start, each with a registry `iconKey` because the category grid
is the one screen where icons carry the navigation (§4.4): Skis, Snowboard, Ski
boots, Snowboard boots, Poles, Helmet, Goggles, Jacket, Pants, Gloves, Base
layer, Bag, Other. The seed uploads nothing — an asset would have to live in the
repo and reach a bucket that may not exist — so a category the registry cannot
cover ships without an icon and gets one from the admin screen. Attributes and
values seed with no icon at all.

Attributes worth having on day one, with their slots:

| Category | Attribute | Input | Slot |
|---|---|---|---|
| Skis | Manufacturer → Model | select → select | 10, 20 |
| Skis | Length | number, cm | 30 |
| Skis | Type (Powder / All-mountain / Carving / Park / Touring) | select | 40 |
| Skis | Color | select | 50 |
| Skis | Bindings included | select (Yes/No) | — |
| Jacket | Manufacturer | select | 10 |
| Jacket | Gender (Mens / Womens / Kids / Unisex) | select | 20 |
| Jacket | Size (XS–XXL, and numeric kids') | select | 30 |
| Jacket | Color | select | 40 |
| Ski boots | Manufacturer → Model | select → select | 10, 20 |
| Ski boots | Mondopoint | number | 30 |
| Ski boots | Flex | number | — |
| Other | What is it? | select, free entry, no values | 10 |

Colors and sizes are shared lists in spirit but separate nodes in fact — an
attribute's values are its children, and there is no value reuse across
attributes. That is a real cost in seed verbosity and the right trade: a shared
value table would mean a color edit for jackets silently changing skis.

Model lists ship thin — the well-known dozen per manufacturer — and grow
through the promotion path (§8.4), which is the mechanism designed to fill them
from what sellers actually bring.

## 10. What this plan does not do

- **The CSV importers.** `legacy-ticket.service.ts` and the proxy-seller
  importer keep mapping a column to `name`, and items they create carry a null
  `categoryId` (D12). Structured import needs a column-to-attribute mapping UI,
  which is its own plan. Items imported this way are complete and sellable;
  they simply have no attributes to report on.
- **The native staff-iPad app.** `patrolkit_ios` builds its own item form,
  renders its own labels from `item.name`, and queues creates offline through
  `SkiSwapSyncEngine`. It needs the taxonomy endpoint, a picker of its own, and
  a migration of its queued-payload shape — a plan of its own, and the reason
  the web work is worth finishing first: it settles the contract the native
  client will be written against. Until then staff check-in happens on the web
  surface.
- **Retro-classification.** No screen offers to decompose an existing free-text
  name into attributes. If one is ever wanted, it is a separate tool over the
  same write path.
- **Reporting.** This plan captures the data and stops. Grouping the floor by
  category, price history by manufacturer and model, and "what did a Head Kore
  112 go for last year" are what the data is *for*, and none of them are built
  here.
- **Color swatches.** Color values render as labels like every other value. A
  swatch is the better control, but it wants a hex column and a
  contrast-checked chip rather than an entry in the icon registry. Seeding
  color icons in the meantime would make that change harder, so §9 leaves them
  null.
- **Animated or multi-size icons.** One 128×128 PNG per node: no stored SVG, no
  per-theme variant, no srcset. A mark that only reads on a dark ground is the
  uploader's problem.
- **Square categories.** Items still land in the swap's single Square category
  (`swap.squareCategoryId`). Mapping taxonomy categories onto Square ones is
  possible now and deliberately deferred.

## 11. Phases

All three are `apps/api` and `apps/web`.

**Phase 1 — the tree exists.** `TaxonomyNode`, the icon registry and its
contract-side key list, the upload/serve/delete routes and their `sharp` step
(§4.4), the seed, the resolved-tree endpoint with versioning and deferred
branches, and the platform admin editor (§6.4). Nothing
about items changes; the tree can be browsed and curated before anything
depends on it.

**Phase 2 — items are described by it.** `SwapItemAttribute`, `categoryId` on
`SwapItem`, `deriveName`, the contract changes in §7.3, and the picker
component in both surfaces (§6.1, §6.2). Free entry is off — every attribute
ships with `allowFreeEntry: false` — so the first swap run on this exercises
the capture path without also exercising the approval path.

**Phase 3 — the tree grows.** `allowFreeEntry` turned on where it belongs,
pending values, the org queue (§6.3), merge, suggest, and the promotion inbox.

The phase boundary between 2 and 3 is the one that matters: it is what lets
free entry be switched on at a swap where someone is available to watch the
queue fill, rather than discovered at the busiest hour of the season.
