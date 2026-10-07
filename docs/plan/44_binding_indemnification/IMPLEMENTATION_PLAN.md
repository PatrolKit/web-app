# Plan 44: Binding indemnification lookup

## Goal

Staff at check-in can answer "will anyone stand behind these bindings?" from PatrolKit. A **Bindings** tab in the ski swap takes a brand or a model name and answers **Indemnified**, **Final season**, **Lapsed** (last listed in some earlier season), or **Not on the list**, with the season it's answering for, the lines it's listed in (retail, rental, demo), and the program's conditions.

The data behind it is the manufacturers' indemnified-binding lists, which come out every August. Each year we convert the new lists into one CSV, run it through an import, and the registry rolls forward a season. Platform admins own the data; every patrol reads it.

The binding models themselves become part of the item taxonomy: a **Model** detail under each binding manufacturer, filled from the lists. Indemnification status hangs off those model nodes, season by season. Items point at models as they point at any value, and the item form shows the answer beside a chosen model. Skis and snowboards that come with bindings get the same binding questions (manufacturer, model, style, DIN) once "Bindings included" is Yes, answered from the same nodes. Nothing is recorded on an item about indemnification, and nothing is enforced.

## The lists

Three documents arrived for 2025-26, and the same three are expected every year:

- **The NSSRA Combined Indemnified Bindings List** (66 pages, August 25, 2025). The National Ski & Snowboard Retailers Association collects each maker's section: the program's terms, then tables of models. Programs and brands: **Amer** (Armada, Atomic, Salomon, Scott, Techno Pro), **Elan**, **Elevate Outdoor Collective** (Marker, and Marker-built bindings sold as Völkl, K2, Nordica, Blizzard, Van Deer, Bogner), **Fischer**, **Head/Tyrolia** (plus Tyrolia-built Kästle and Liberty), **KneeBinding**, **Rossignol Group** (Look, Rossignol), **V-Tec** (plus Blossom, DPS, Kneissl). Page 2 says the list is published for NSSRA retail members only and may not be posted or given to non-members.
- **Two Marker one-pagers** from Elevate directly: retail, and rental/demo. Their content matches the Elevate section of the combined list (one model spelled differently). Being manufacturer-direct, they carry no NSSRA restriction.

What a table says about a model varies by program: current line or non-current line (both indemnified), retail or rental/demo, a non-ISO column (touring bindings, still indemnified), tables by model year, a final-season marker, a "last year" list, and end dates. Model names are as the vendor wrote them. A thousand-odd names across about twenty-five brands.

Indemnification itself is the maker's promise to defend an *authorized dealer* that followed its procedures. A patrol running a swap is not a dealer, so the answer is information for staff and sellers, not cover for the patrol. The plan says so on the page.

## What's already here

- **Taxonomy** (Plan 19). One table, `TaxonomyNode`: CATEGORY → ATTRIBUTE → VALUE → (ATTRIBUTE…). Global rows (`orgId` null) are curated in Platform Admin → Item Details; org rows overlay them. Nodes are retired, never deleted; items keep pointers; names are derived once and frozen. `dedupeKey` prevents duplicate labels under one parent. Merge repoints items. A select with more than 60 values arrives as `valuesDeferred` and is fetched when opened, so a long Model list costs nothing until it's needed.
- **Bindings in the tree.** Category **Bindings** › Type (Skis / Snowboard / Cross-country). Under Skis: Manufacturer (ten brands: Atomic, Dynafit, Fritschi, G3, Head, Look, Marker, Rossignol, Salomon, Tyrolia), Style, Max DIN. **No Model detail, and no free entry on Manufacturer.** Skis and Snowboard carry only "Bindings included: Yes/No", with no `nameSlot`.
- **Values aren't shared.** Plan 19 §9 keeps each attribute's values its own: the same label under two attributes is two nodes. A value's own attributes are followed when resolving (`ResolvedValue.attributes`), and `resolveAnswers` checks every answer is reachable from the item's category. `deriveName` composes from answers with a `nameSlot`. `ItemDescriber` renders whatever the resolved tree says, nested values included.
- **Seed and export.** `prisma/taxonomy.json` is the global tree, seeded once per database and exported back with `db:export-taxonomy`. Model nodes minted by this plan join it.
- **Platform admin.** `User.isSuperAdmin`, `SuperAdminGuard`, `admin/*` controllers, the `AdminLayout` tabs. `PlatformSettings` is one row.
- **Org settings.** `SkiSwapSettings`, one row per org, a typed column per setting, `GET/PATCH orgs/:orgId/ski-swap/settings`, edited in Administration → Settings.
- **Imports.** The seller import's parse → map → commit shape (`SellerImportModal`), and Plan 42's pure matcher with label normalization (case, accents, spacing, apostrophes).
- **Ski swap tabs** (Plan 12). `SkiSwapLayout`: a swap-scoped group, a divider, an org-scoped group (Sellers, Swaps, Check-in, Hardware, Administration).

## Decisions

| # | Decision |
|---|---|
| D1 | **Models are taxonomy nodes.** Under Bindings › Type › Skis › Manufacturer, every manufacturer VALUE gets a **Model** ATTRIBUTE (select, `nameSlot` 15, so a name reads "Marker Griffon 13 ID …", free entry on). Each listed model is a global VALUE under it, labelled as the vendor wrote it (whitespace tidied, nothing else). The import mints manufacturers the tree lacks (Völkl, Blizzard, Kästle, KneeBinding, V-Tec…) and turns free entry on for Manufacturer, so an unlisted binding can still be described. Snowboard and cross-country bindings have no programs and are untouched. |
| D2 | **Status is a season's entry on a model node, not a column.** New table `BindingIndemnification`: `nodeId` (the model VALUE, `onDelete: Restrict`), `programKey`, `season` ("2025-26"), `status` LISTED \| FINAL_SEASON, `lines` (retail / rental / demo flags), `currentLine`, `nonIso`, `source` NSSRA \| MANUFACTURER, `sourceRef` ("Combined list p.35"), `note`, `importId`. Unique on `(nodeId, season)`. Each August adds a season; nothing is overwritten, so "last listed 2023-24" is answerable and a disputed answer can be traced to a page. A model that falls off a list keeps its node (people still own it) and simply has no entry for the new season. |
| D3 | **Programs.** New table `BindingIndemnificationProgram`: `key` (amer, elan, elevate, fischer, head_tyrolia, kneebinding, rossignol, vtec), `name`, `notes` (the terms in a few paragraphs: dealer agreement needed, exclusions and deadlines), `latestSeason`. Notes are edited by platform admins in the UI; the import sets `latestSeason`. |
| D4 | **The answer**, computed at read time for a model, against its program's latest season (not the platform's, so a brand whose sheet arrives late doesn't look lapsed):<br>• **indemnified**: an entry this season with status LISTED;<br>• **final_season**: an entry this season with status FINAL_SEASON ("indemnified through 2025-26");<br>• **lapsed**: no entry this season, an entry in an earlier one ("last listed 2023-24");<br>• **not_listed**: a model node with no entry ever (free-entered or org-minted models answer this);<br>• **unavailable**: the only entries are NSSRA-sourced and the patrol hasn't declared membership (D5). Never "not listed" in that case: a wrong "no" is the one answer that must not happen.<br>Each answer carries the season, the lines, `currentLine`, `nonIso`, the program, and the entry's note. |
| D5 | **NSSRA entries are per-org opt-in.** `SkiSwapSettings.nssraMember` (default false), with `nssraMemberSetBy/At`. An org admin turns it on under a declaration: *"This patrol is a retail member of the National Ski & Snowboard Retailers Association. NSSRA publishes its combined list for members only."* Audited. A non-member org sees manufacturer-sourced entries (today: Marker's) and `unavailable` for the rest, with a line saying why and where to turn it on. Platform admins see which orgs declared. The model **nodes** are visible to every org regardless: they're product names, and an item picker that differs per org would break promotion and merge. The residual leak (a non-member can see which models exist under Look) is accepted and noted. |
| D6 | **Marker from Marker.** The converter takes Elevate's rows from the Marker sheets, source MANUFACTURER, and skips the combined list's Elevate section (the two agree; the sheet's spelling wins). Where one `(node, season)` arrives from both sources, the import keeps one entry, ORs the lines, and upgrades the source to MANUFACTURER. |
| D7 | **One CSV a season.** Columns: `program, manufacturer, model, season, status, lines, current_line, non_iso, source, source_ref, note`. `lines` is `retail`, `rental`, `demo`, joined with `+`. `status` is `listed` or `final_season`. Every row names its season, so one file can carry back-seasons too. The converted file for each season is committed at `apps/api/prisma/indemnification/<season>/entries.csv` beside a `programs.json` (names and notes), under `prisma/` because that is the directory the release script ships to the server, so a fresh database can be loaded (`pnpm --filter api db:import-indemnification -- 2025-26`) and a season re-run. The repository is private; the PDFs themselves are not committed. |
| D8 | **Import: dry run, then commit**, `POST admin/bindings/indemnification/import` with the file, `season`, and `dryRun`. The dry run answers what the commit would do: manufacturers to mint, models to mint, entries new / changed / unchanged, and, per program, last season's models missing from the file (the ones about to read **lapsed**), plus row errors (unknown program, bad status, a season that isn't `YYYY-YY`). The commit is one transaction: mint, upsert entries, set `latestSeason`, bump every org's taxonomy version, audit `ski_swap.indemnification.imported` with the counts. Matching a row to an existing node uses Plan 42's normalization plus `²`→`2` and collapsed punctuation, so "GRIFFON 13 ID" finds "Griffon 13 ID"; a miss mints. Re-running the same file is a no-op. |
| D9 | **Merging and retiring carry entries.** `TaxonomyService.merge` moves the source's entries to the target (a `(target, season)` collision keeps the target's). Retiring a model keeps its entries. Discard is refused by the foreign key, as items refuse it. Promoting an org's free-entered model into a global one is the existing promote, then a merge if it duplicates a listed model. |
| D10 | **Who reads.** The patrol's staff (`ski_swap:report`) and its check-in iPads (`ski_swap.staff_check_in`). Not sellers: they're org members with no ski-swap permission, and a business seller is a retail shop, exactly who NSSRA's list is kept from. The Bindings tab and the item form's answer are on staff screens only. Nothing under `public/*`, ever: even manufacturer-direct lists are dealer material. |
| D11 | **Shown on the form, not stored on the item.** When a binding model is chosen in the item form (on a binding, or on skis with bindings, D14), its answer appears beside the select: the badge, the season, and one line ("Listed 2025-26, retail and rental" / "Last listed 2023-24" / "Not on any list"), from `GET models/:nodeId`. No item column, badge, filter or policy: the item points at the node like any other answer, and the answer is computed when asked. |
| D12 | **The page says what it is.** Above results: *"From the manufacturers' 2025-26 indemnified lists. Indemnification covers authorized dealers who follow the maker's procedures; it isn't cover for the swap. The vendor's tech manual is the last word."* The same line, shortened, sits under the badge on the form. |
| D13 | **Out of scope:** the iPad's offline mirror (handoff only), snowboard bindings' programs (none exist), boot/binding compatibility (GripWalk and the like), enforcement at check-in, and alias matching ("Rossi"). |
| D14 | **Skis with bindings ask the binding questions, from the same nodes.** A new taxonomy pointer, `TaxonomyNode.sameDetailsAsId` on a VALUE: "my details are that value's details". Skis › Bindings included › **Yes** and Snowboard › Bindings included › **Yes** point at Bindings › Type › **Skis** and › **Snowboard** respectively. Resolving Yes inlines the target's attributes (Manufacturer with Model, Style, Max DIN; deferred above 60 values as usual), so the form shows exactly the binding picker, and an item's answers store the *shared* attribute and value ids. One set of model nodes, one set of entries, one picker. Chosen over copying the subtree under Yes, which would double every model node, split the entries, and need the import to keep two trees in step. |
| D15 | **Pointed-to details stay out of the name and off the tag.** `deriveName` ignores answers reached through `sameDetailsAsId`, so a ski's frozen name is unchanged by its bindings ("Völkl Mantra 170 Skis", not "Völkl Marker Mantra Griffon 170 Skis"), and the printed tag doesn't mention them. The binding answers show in the item's details, on the Items page, and in the tab. |
| D17 | **Identifying bindings is optional, always.** "Bindings included: Yes" is a complete answer on its own. The binding questions appear beneath it and can be left blank; nothing refuses, warns or counts skis whose bindings aren't identified, and skis described before this ships are left as they are. Staff add the details when they want the answer. |
| D16 | **Rental and demo models are ordinary values.** The import mints every listed model, retail or rental, approved and visible in the picker. Used rental skis reach a swap with rental and demo bindings on them, and staff need to pick those. The Model select is searchable, so the length of the list costs a keystroke, not a scroll. |

## Server

### Migration (`20261020120000_binding_indemnification`)

- `BindingIndemnificationProgram` (`key` PK, `name`, `notes TEXT`, `latestSeason VarChar(7)?`, `updatedAt`, `updatedById?`), seeded with the eight programs and empty notes.
- `BindingIndemnificationImport` (`id`, `season`, `fileName`, `counts JSON`, `createdAt`, `createdById`).
- `BindingIndemnification` as D2, FK `nodeId → TaxonomyNode` Restrict, FK `programKey`, FK `importId`, unique `(nodeId, season)`, index `(programKey, season)`.
- `SkiSwapSettings.nssraMember BOOLEAN NOT NULL DEFAULT false`, `nssraMemberSetBy VarChar(191)?`, `nssraMemberSetAt DATETIME?`.
- `TaxonomyNode.sameDetailsAsId VarChar(191)?`, self-FK `onDelete: SetNull`, index. Set by the migration for the two global Yes values (D14), found by label path, so production's tree needs no seed re-run.
- Additive, no backfill beyond those two rows.

### Taxonomy (`taxonomy.service.ts`, `derive-name.ts`, `import-details.ts`, seed and export)

- **`resolve` / `children`:** a VALUE with `sameDetailsAsId` answers with the target's resolved attributes in place of its own (it has none). The target must be a global VALUE; a cycle or an org-scoped target is refused at write time. Org overlays on the shared attributes (an org's own binding manufacturer) show in both places, as they're one set of nodes.
- **`resolveAnswers`:** reachability follows the pointer: from Yes, the target's attributes and everything beneath are reachable. The stored `attributeId` is the shared attribute's own id. `@@unique([itemId, attributeId])` holds: a ski item never otherwise answers Bindings' Manufacturer.
- **`deriveName`:** answers reached through a pointer are skipped (D15). The resolver marks them (`viaPointer: true`) so the web and the iPad can tell them apart too.
- **`matchImportDetails`** (Plan 42): a CSV column `Binding manufacturer` / `Binding model` is matched against the pointed-to subtree when the row's "Bindings included" is Yes. The template and the categories-and-details download list them under Skis and Snowboard as "only when Bindings included = Yes".
- **`assertPlacement` / `createNode` / `patchNode`:** `sameDetailsAsId` is settable only on a global VALUE by a platform admin, in Item Details ("Same details as…", a picker of values). A value with a pointer refuses child attributes.
- **Seed and export:** `ValueSpec` gains `sameDetailsAs: string[]` (a label path), written by `export-taxonomy` and resolved after all nodes exist by `seedTaxonomy`.
- **`merge`:** the D9 entry move.

### Registry (`ski-swap/indemnification/`, new module)

- **`indemnification-import.ts`** (pure): `parseEntriesCsv(text)` → rows or errors; `normalizeModel(label)`; `planImport(rows, tree, existingEntries)` → the D8 plan `{ mintManufacturers, mintModels, upserts, lapsing, errors }`. No database, tested on fixtures.
- **`indemnification-import.service.ts`**: `dryRun(file, season)` and `commit(file, season, actor)`. Minting goes through `TaxonomyService.createNode` (global, APPROVED) so dedupe keys, audit and version bumps behave as in Item Details; the Model ATTRIBUTE is created under a manufacturer the first time it's needed. Also `seed(seasonDir)` for a fresh database, run by `pnpm --filter api db:import-indemnification -- 2025-26`.
- **`indemnification-lookup.service.ts`**: `manufacturers(orgId)`, `models(orgId, manufacturerNodeId)`, `search(orgId, q)`, `model(orgId, nodeId)`. Reads the org's `nssraMember` once per request and drops NSSRA entries for a non-member before computing D4. Search normalizes the query as D8 does, splits it into tokens, and keeps a model when every token prefix-matches a token of "manufacturer model"; results are capped at 50 and ordered brand, then label. The data is small enough to read whole and cache per `taxonomyVersion`.
### Contracts (`contracts/indemnification.contracts.ts`)

```ts
type IndemnificationAnswer =
  | 'indemnified' | 'final_season' | 'lapsed' | 'not_listed' | 'unavailable';

interface BindingLookup {
  nodeId: string; manufacturer: string; model: string;
  answer: IndemnificationAnswer;
  season: string | null;          // the season answered for
  lastListedSeason: string | null; // for lapsed
  lines: ('retail' | 'rental' | 'demo')[];
  currentLine: boolean | null; nonIso: boolean;
  program: { key: string; name: string } | null;
  note: string | null;
}
```

`BindingLookupDetail` adds `entries[]` (every season, with source and `sourceRef`) and the program's `notes`. `ManufacturerSummary` is `{ nodeId, label, models, listed, programs[] }`. Import DTOs mirror the D8 plan and counts.

### Routes

**Patrol-facing**, `orgs/:orgId/ski-swap/bindings/indemnification`, staff and check-in iPads (`OrDeviceAuthGuard`, `OrgContextGuard`, `ModuleEnabledGuard`, `PermissionsGuard`; `@RequirePermissions('ski_swap:report')`, `@RequireDeviceRole('ski_swap.staff_check_in')`). The registry is cached a minute per org, cleared by an import, a program's notes and the NSSRA declaration:

- `GET manufacturers`
- `GET manufacturers/:nodeId/models`
- `GET search?q=`
- `GET models/:nodeId`

**Settings:** `PATCH orgs/:orgId/ski-swap/settings` takes `nssraMember` (`ski_swap:admin`), stamps who and when, and audits `ski_swap.settings.nssra_member`.

**Platform**, `admin/bindings/indemnification`, `JwtAuthGuard` + `SuperAdminGuard`:

- `GET programs`, `PATCH programs/:key` (`name`, `notes`)
- `POST import` (multipart `file`, `season`, `dryRun`)
- `GET imports`
- `GET orgs` (which orgs declared NSSRA membership, by whom, when)

### The seasonal conversion (one-off each year, not committed)

A scratchpad script per season, reviewed by hand:

- `pdftotext -layout` on each PDF. Table rows extract cleanly; the section headings in the combined list use a remapped font and are read from the rendered page instead.
- Each program's section is cut by page range, each table split into cells on runs of two or more spaces, each cell tagged with the heading above it (current / non-current, retail / rental / demo, the OEM brand, Non ISO, Final Season). Elan's season headings set the row's season; everything else is the document's season.
- Marker rows come from the Marker sheets (D6).
- Output: `entries.csv`, `programs.json` with the notes drafted from the terms pages, and a diff against last season's file (new, dropped, renamed), which is the review.
- Then the admin import's dry run, a look at what would lapse, and the commit. I can run both calls, or hand the CSV to whoever is at the admin tab.
- **The script is not the contract.** What the repo depends on is the CSV format and the import; how a season's PDFs become that CSV is redone each year to suit that year's layout, by hand where a page needs it. For 2025-26: table rows came from the text layer, the section headings and a dozen scrambled cells were read from the rendered pages, and every table's count was checked against its page.

## Web

- **Bindings tab**, `ski-swap/bindings` → `pages/ski-swap/BindingsPage.tsx`, in the org-scoped group after Check-in, shown to every member.
  - **Search** across brand and model, debounced, results as rows: brand, model, a status badge (green **Indemnified**, amber **Final season** / **Lapsed** with the season, grey **Not on the list**, slate **Unavailable**), the lines as small chips, and a **Non-ISO** chip where it applies.
  - **Browse**: brands down the side with listed counts; picking one lists its models.
  - **Detail** on a row: every season's entry, source and page, and the program's notes.
  - The D12 line above results. For a non-member org, a notice: *"Your patrol hasn't declared NSSRA membership, so only manufacturer-published lists are shown. An administrator can declare it under Administration → Settings."*
  - Empty state before any import: "No lists loaded yet."
  - Pure logic (`bindingsLogic.ts`): grouping, badge mapping, the token matcher mirrored for instant client-side filtering of an already-loaded brand.
- **Administration → Settings:** an **NSSRA membership** toggle with the D5 declaration, `ski_swap:admin`, showing who turned it on and when.
- **Platform Admin → Bindings** (`pages/admin/BindingIndemnificationTab.tsx`):
  - **Import**: season field, file picker, **Check** (dry run) showing the D8 plan with the lapsing list expandable, then **Import**.
  - **Programs**: each with its name, latest season, and a notes editor.
  - **Imports**: the history with counts.
  - **Patrols**: who has declared membership.
  - Model nodes (rename, retire, merge, reorder) stay in Item Details; the tab links there. Item Details gains the "Same details as…" control on a global value (D14).
- **Item form (`ItemDescriber.tsx`):**
  - Skis and Snowboard: choosing Bindings included = Yes reveals the binding questions, rendered by the same nested-value code the Bindings category already uses. Nothing is special-cased on the client; the resolved tree carries them.
  - Beside a chosen binding Model, the D11 answer: badge, season, one line, loaded on selection and cached per node. A free-entered model shows "Not on any list" once minted. A non-member org sees "Unavailable" with the D5 line.
- **Items page and item detail:** pointed-to answers are listed under a "Bindings" heading, as the resolver marks them.
- **`lib/api.ts`**: `skiSwap.indemnification.*` and `indemnificationAdmin.*`; types in `api.types.ts`.

## iPad (handoff)

`docs/plan/44_binding_indemnification/IPAD_HANDOFF.md`, once the API is final:

- the four read routes and `BindingLookup`, for showing the answer beside a chosen model as the web does (online only; no offline mirror yet);
- Model is now a detail under binding manufacturers; values above 60 arrive deferred, as elsewhere;
- **the pointer:** Skis › Bindings included › Yes resolves with attributes it doesn't own. Stored answers for a ski carry attribute ids from the Bindings subtree. The iPad's local mirror of the tree and any client-side reachability check must follow `sameDetailsAsId` (sent on the resolved value) or accept the server's resolved shape as given;
- `viaPointer` answers are not part of the derived name.

## Rollout

1. Convert the 2025-26 lists; review the diff of the CSV against the three PDFs by program and page.
2. Build and test locally against a copy of the database: migration, seed from the committed season, dry run and commit through the admin tab, the Bindings tab as a member and as a non-member org, merge of a free-entered model into a listed one.
3. Migrate and deploy, after asking: additive, but it restarts every org's app.
4. Import in production through the admin tab (dry run first). Export the taxonomy and commit `taxonomy.json` with the new nodes.
5. BMBWAV is an NSSRA member: its admin turns the declaration on. Any other member patrol does the same for itself.
6. Smoke in `patrolkit-smoke`: a search, a brand browse, a lapsed answer, an `unavailable` answer with membership off, a ski described with Bindings included = Yes and a Marker model, and the badge beside it.

## Tests

- **`indemnification-import.spec.ts`** (pure):
  - CSV parsing: lines joined with `+`, booleans, season format, unknown program, duplicate rows;
  - normalization: case, accents, `²`, punctuation, whitespace; "GRIFFON 13 ID" matches "Griffon 13 ID", "Griffon 13" does not;
  - the plan: mints only what's missing, including a manufacturer and its Model attribute; upserts; lapsing computed per program against its latest season; re-running the same file plans nothing.
- **Import service:** dry run writes nothing; commit is one transaction; minted nodes are global and APPROVED; `latestSeason` set; audit written; both-sources rows merge per D6.
- **Lookup service:**
  - each D4 answer from fixtures, including final season and lapsed with the right seasons;
  - a brand whose latest season lags the others isn't lapsed;
  - non-member: NSSRA entries hidden, `unavailable` where that empties a model, manufacturer-sourced still answered;
  - search tokens prefix-match across brand and model; cap at 50.
- **Taxonomy:** merge moves entries and keeps the target's on collision; discard refused with entries; retire keeps them.
- **Pointer (`taxonomy.spec.ts`, `derive-name.spec.ts`, `import-details.spec.ts`):**
  - resolving Yes inlines the target's attributes, deferred above 60; an org's own binding manufacturer shows in both places;
  - `resolveAnswers` accepts a ski's answers against the shared attribute ids, and refuses them when Bindings included isn't Yes;
  - a pointer to an org value, to a non-value, or in a cycle is refused; a pointing value refuses child attributes;
  - `deriveName` skips `viaPointer` answers: the ski's name is unchanged by its bindings;
  - the CSV matcher finds `Binding manufacturer` and `Binding model` under Yes, and the downloads list them with their "only when";
  - seed resolves `sameDetailsAs` label paths after all nodes exist; export writes them; a round trip is stable.
- **Settings:** `nssraMember` needs `ski_swap:admin`, stamps who and when, audits.
- **Web:** `bindingsLogic` badge mapping and client-side filter; the form badge loads on model selection, is cached per node, and reads "Unavailable" for a non-member.
- **Conversion check (manual, each season):** counts per program in the CSV against the PDF tables; spot-check ten rows to their pages.

## Open questions

None at the moment. Bindings stay off the printed tag (D15), and identifying them is never required or nudged (D17).
