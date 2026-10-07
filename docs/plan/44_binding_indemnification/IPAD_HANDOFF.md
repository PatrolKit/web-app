# To the iPad: binding indemnification lookup

**From:** the server (Plan 44). **When:** now. The server is deployed, and the 2025-26 lists are loaded in production.

## Why

Staff at check-in want to know whether anyone stands behind a pair of bindings. The makers publish **indemnified-binding lists** every August. A binding on its maker's list is one the maker defends an authorized dealer for, so a shop will work on it.

The server now holds those lists and answers for any binding model:
- **Indemnified**;
- **Final season**;
- **Lapsed** ("last listed 2023-24");
- **Not on the list**;
- **Unavailable**.

The web shows the answer in two places: in a Bindings tab, and beside a binding model picked in the item form. The iPad should do the same.

**The answer is information, not cover.** Indemnification protects authorized dealers who follow the maker's procedures. A patrol running a swap isn't one. Every place the answer appears carries a one-line disclaimer (below).

**One part is not optional and is already live (section 3, item 1).** Skis › Bindings included › **Yes** now opens the binding questions. The iPad currently puts those answers in the ski's name and on its tag, and the server doesn't. Fix that first.

## What reaches the iPad

### 1. The tree has binding models, and a pointer

Both arrive in the taxonomy the iPad already fetches (`depth=full`). There's no new call.

**Binding makers and their models.**
- Bindings › Type › Skis › **Manufacturer** now has 37 makers: the original 10 plus Völkl, Blizzard, K2, Nordica, Elan, Fischer, Armada, Kästle, V-Tec and others.
- It allows free entry.
- Every maker has a **Model** question (`select`, `nameSlot` 15, `allowFreeEntry` true). Its values are the listed models, labelled as each maker spells them.
- A Model question under a binding maker carries a new field on its `ResolvedAttribute`: `lookup: "indemnification"`. That is the signal that a picked value can be looked up. Nothing else has it.

**The pointer, `sameDetailsAs`.** Skis › Bindings included › **Yes** and Snowboard › Bindings included › **Yes** have no questions of their own. Each resolves with the questions of Bindings › Type › **Skis** or › **Snowboard**: Manufacturer (and under it, Model), Style, and Max DIN. They come under the **shared** ids, and the value says so:

```jsonc
// ResolvedValue
{
  "id": "…", "label": "Yes", "displayOrder": 10,
  "sameDetailsAs": { "id": "<Bindings › Type › Skis>", "category": "Bindings" },  // new, optional
  "attributes": [ /* Bindings' Manufacturer, Style, Max DIN, with their real ids */ ]
}
```

- **Answers:** an item answering these stores the shared attribute and value ids, under its own category (Skis). The server accepts them only when Yes is picked.
- **Names:** these answers are **never** part of the derived name or the tag. The ski stays "Völkl Mantra 170 Skis", whatever is mounted on it.
- **Optional, always:** "Bindings included: Yes" alone is a complete answer. Nothing requires, nudges or counts identified bindings.

**Size.** The binding models appear twice in a full tree: under Bindings, and again under Skis › Yes. Production's full tree for BMBW is about 595 KB, 141 KB gzipped.

### 2. The lookup API

Base: `GET /api/v1/orgs/:orgId/ski-swap/bindings/indemnification`.
- The check-in iPad's device token works (role `ski_swap.staff_check_in`).
- Staff need `ski_swap:report`.
- Sellers get `403`, so never call it from a seller-facing screen.
- Online only. The server caches the registry for a minute, so each call is cheap.

| Route | Answers |
|---|---|
| `GET manufacturers` | `{ nssraMember, latestSeason, manufacturers: [{ nodeId, label, models, listed, programs: [{ key, name }] }] }`. `models` is how many there are, `listed` how many are on a current list. |
| `GET manufacturers/:nodeId/models` | `BindingLookup[]`, one maker's models in list order. |
| `GET search?q=` | Up to 50 `BindingLookup`, ordered by brand, then model. Every query token must start a token of "maker model": `marker grif`, `pivot 14`, `attack 13 gw`. `q` is at most 120 characters, and empty returns `[]`. |
| `GET models/:nodeId` | `BindingLookupDetail` for one model node: the item form's call, and the detail screen's. |

```ts
BindingLookup {
  nodeId: string;               // the Model value's id: the same id an item's answer stores
  manufacturerId: string;
  manufacturer: string;         // "Marker"
  model: string;                // "Griffon 13 ID"
  answer: 'indemnified' | 'final_season' | 'lapsed' | 'not_listed' | 'unavailable';
  season: string | null;        // the season answered for, e.g. "2025-26" (ignore it for not_listed and unavailable)
  lastListedSeason: string | null; // for lapsed: the last season it was on a list
  lines: ('retail' | 'rental' | 'demo')[];
  currentLine: boolean | null;  // the maker's current line, or an older model still covered
  nonIso: boolean;              // indemnified, but not alpine-ISO certified (touring): check the boot
  program: { key: string; name: string } | null;  // "Elevate Outdoor Collective (Marker)"
  note: string | null;          // the maker's caveat, e.g. "Not indemnified after this season."
}

BindingLookupDetail extends BindingLookup {
  entries: {                    // every season it's listed in, newest first
    season: string; status: 'listed' | 'final_season'; lines: (…)[];
    currentLine: boolean | null; nonIso: boolean;
    source: 'nssra' | 'manufacturer'; sourceRef: string | null;  // "Combined list p.58", "Marker retail sheet"
    note: string | null; program: { key: string; name: string };
  }[];
  programNotes: string | null;  // the program's terms, a few paragraphs
  hiddenEntries: number;        // entries this patrol can't see (see unavailable)
}
```

**`unavailable` is not "no".** NSSRA publishes its combined list for **members only**. A patrol sees NSSRA-sourced entries only after its admin declares membership (web: Administration → Settings).
- Until then, those models answer `unavailable`.
- Today that's every maker except Marker and the Marker-built brands, whose lists come from Marker directly.
- Never show `unavailable` as "not listed". A wrong "no" is the one answer that must not happen.

`GET orgs/:orgId/ski-swap/settings` now carries the declaration: `nssraMember: boolean`, `nssraMemberSetBy: string | null` (a name) and `nssraMemberSetAt: string | null`. `GET manufacturers` repeats `nssraMember`, so a lookup screen needs only its own call.

### 3. What each answer says

Use the web's wording so the two read alike:

| `answer` | Badge | Tint | Line under it |
|---|---|---|---|
| `indemnified` | **Indemnified** | green | "Listed 2025-26, retail and rental, current line" (", older model" when `currentLine` is false; nothing when null) |
| `final_season` | **Final season** | amber | "Indemnified through 2025-26, retail; not after" |
| `lapsed` | **Lapsed** | amber | "Last listed 2023-24; not on the 2025-26 list" |
| `not_listed` | **Not on the list** | grey | "Not on any indemnified list we hold" |
| `unavailable` | **Unavailable** | slate | "On a list your patrol hasn't declared access to" |

Lines are joined as "retail", "retail and rental", or "retail, rental and demo".

Two more cues:
- **`nonIso`:** a small "Non-ISO" chip.
- **`note`:** the maker's caveat, under the line, in amber.

**The disclaimer**, wherever an answer appears: "From the makers' indemnified lists. Covers authorized dealers who follow their procedures, not the swap."

## What the iPad needs

1. **Keep pointed-to answers out of the name. Do this first: the pointer is live.**
   - **`TaxonomyModels.swift`:**
     - decode `sameDetailsAs: { id, category }?` on `ResolvedValue` (`:74`);
     - decode `lookup: String?` on `ResolvedAttribute` (`:43`).
   - **`ItemNameDeriver.swift`:** `attributesByID(of:)` (`:143`) walks into every value's attributes, including those under a value with `sameDetailsAs`. That means a ski's binding Manufacturer (`nameSlot` 10), Style (30) and Max DIN (40) land in `derive` (`:68`), and so in the printed name.
     - Mark attributes reached under a `sameDetailsAs` value, and have `derive` skip them, as the server's `deriveName` does.
     - Gender lookup and validation still see them.
   - **`AttributeList.swift` / `AttributeRow.swift`:** render the questions under Yes as any value's. Head them with the category and a note, as the web does: "Bindings · optional, kept off the tag".
2. **The answer beside a picked binding model** (item entry, `ItemEntryView` / `ItemEntryViewModel`).
   - **When:** the attribute has `lookup == "indemnification"` and a value is picked.
   - **Call:** `GET models/:valueId`, and show the badge, the line, the note and the disclaimer under the picker.
   - **Cache:** keep the answer per node in memory for the session.
   - **Offline:** say "Can't check the lists offline". Never show a stale or guessed answer.
   - **Typed model:** a free-typed model isn't a node yet. Say "Not on any indemnified list we hold".
   - **Never block the save.** The answer is information. Nothing is stored on the item.
3. **The Binding Indemnification mode.** It's stubbed as "Coming soon": `SkiSwapMode.bindingIndemnification` (`Modes/SkiSwapMode.swift`), dispatched to `SkiSwapModePlaceholder` at `SkiSwapCoordinator.swift:219`. Replace the placeholder with a lookup screen:
   - **A search field**, debounced (about 250 ms), calling `search?q=`. Results show brand, model, badge, line chips and Non-ISO.
   - **Brands down the side** from `manufacturers`, each with "listed / models". Picking one calls `manufacturers/:nodeId/models`. Filtering a loaded brand's list locally is fine: same rule as the server, every query token starts a token of "maker model", ignoring case, accents, `²` and punctuation.
   - **A detail sheet** from `models/:nodeId`: every season's entry with its source and page, the program's notes, and the disclaimer.
   - **The season it answers for**, above the results: "From the makers' 2025-26 indemnified lists" (`latestSeason`).
   - **When `nssraMember` is false**, a notice: "Your patrol hasn't declared NSSRA membership, so only maker-published lists are shown. An administrator can declare it in PatrolKit on the web under Administration → Settings."
   - **Empty states:** "No lists loaded yet" when `manufacturers` is empty; "Can't check the lists offline" when offline; a real error message for a failed call, never an empty list.
4. **`SkiSwapAPIClient.swift`:**
   - Add `indemnificationManufacturers`, `indemnificationModels(manufacturerId:)`, `indemnificationSearch(q:)` and `indemnificationModel(nodeId:)`, with `Decodable` types matching section 2.
   - Add `nssraMember` (optional) to `APISkiSwapSettings` (`:249`).
   - These are reads. Nothing goes through the sync queue.
5. **Don't persist the lists.** Keep lookup results in memory. The server is the one source, a new season changes answers, and turning NSSRA membership on or off must take effect at once. If check-in ever needs answers offline, ask the server for a bulk endpoint rather than mirroring these calls.

## How we'll know

- **The name:** describe a ski with Bindings included = Yes, maker Marker, a model and a DIN. The preview and the printed tag read like the web's ("Völkl Mantra 170 Skis"), with no binding words. After sync, the server's stored name matches.
- **The answer in item entry:** on that ski, picking a model that's on its maker's current list shows **Indemnified**, its season and lines, and the disclaimer. In airplane mode it says it can't check, and the item still saves.
- **Unavailable:** in an org that hasn't declared NSSRA membership (the test org, `patrolkit-smoke`), a model listed only on NSSRA's list reads **Unavailable**, never "Not on the list".
- **The mode:**
  - A search for a model family finds each of its models, with its answer and lines.
  - A brand with models in their last season lists them as **Final season**, each with its note.
  - A model's detail shows its seasons and the program's notes.
- **Sellers:** nothing on a seller-facing screen calls the lookup. The server refuses them anyway.
