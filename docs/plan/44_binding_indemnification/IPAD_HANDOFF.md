# Plan 44 — iPad handoff: binding indemnification

What the server now does that the staff iPad can use, and what it must know even if it uses none of it. Nothing here is required for the iPad to keep working: every change is additive.

## 1. The lookup API (online only)

Base: `orgs/:orgId/ski-swap/bindings/indemnification`. User sessions only for now: the routes are behind `JwtAuthGuard` + membership, and a device token is refused. Say when the iPad wants it and the guard changes to the device-or-user one with `@RequireDeviceRole('ski_swap.staff_check_in')`.

| Route | Answers |
|---|---|
| `GET manufacturers` | `{ nssraMember, latestSeason, manufacturers: [{ nodeId, label, models, listed, programs }] }` |
| `GET manufacturers/:nodeId/models` | `BindingLookup[]` for one maker |
| `GET search?q=` | up to 50 `BindingLookup`, every query token prefix-matching a token of "maker model" |
| `GET models/:nodeId` | `BindingLookupDetail`: the lookup plus `entries[]` (every season), `programNotes`, `hiddenEntries` |

`BindingLookup`:

```ts
{
  nodeId, manufacturerId, manufacturer, model,
  answer: 'indemnified' | 'final_season' | 'lapsed' | 'not_listed' | 'unavailable',
  season: string | null,            // the season answered for (the program's latest)
  lastListedSeason: string | null,  // for lapsed
  lines: ('retail' | 'rental' | 'demo')[],
  currentLine: boolean | null, nonIso: boolean,
  program: { key, name } | null, note: string | null,
}
```

`unavailable` means the model's only entries come from NSSRA's members-only list and the org hasn't declared membership (`SkiSwapSettings.nssraMember`, now in `GET settings`). Show it as unavailable, never as "not listed".

The web shows the answer beside a chosen binding model in the item form (badge + one line) and in a Bindings tab. The iPad may do the same when online; there is no offline mirror yet.

## 2. The tree: Model under binding makers

Bindings › Type › Skis › Manufacturer now has many more makers (Völkl, Blizzard, Kästle, KneeBinding, V-Tec, …) and each has a **Model** question (`SELECT`, `nameSlot` 15, `allowFreeEntry` true) with the listed models as values. Manufacturer itself allows free entry now. Lists above 60 values arrive deferred in the partial tree, as elsewhere; `?depth=full` inlines them. A Model question under a binding maker carries `lookup: 'indemnification'` on its `ResolvedAttribute`: that is the signal that a chosen value can be looked up.

## 3. The pointer: `sameDetailsAs`

Skis › Bindings included › **Yes** and Snowboard › Bindings included › **Yes** no longer have questions of their own. Each resolves with the questions of Bindings › Type › **Skis** / **Snowboard** (Manufacturer with Model, Style, Max DIN), and says so:

```ts
ResolvedValue {
  ...,
  sameDetailsAs?: { id: string; category: string },  // { id: <Bindings › Type › Skis>, category: 'Bindings' }
  attributes: ResolvedAttribute[],                   // the target's, under the target's ids
}
```

What that means for a client:

- **Rendering:** nothing special. The resolved shape is the same; render `attributes` under Yes as you would any value's. The web adds a small heading with `sameDetailsAs.category` ("Bindings").
- **Answers:** an item answering them stores the shared attribute ids (`b-mfr`, the maker's Model id, Max DIN) with its own category (Skis). `SwapItemAttribute` is unchanged. If the iPad validates reachability locally, it must accept an attribute reached through a picked value's `sameDetailsAs` target, or defer to the server's resolved shape.
- **Names:** the server leaves these answers out of the derived name (the ski is "Völkl Mantra 170 Skis", whatever is on it). A client previewing the name should skip answers reached through a pointer. `ItemResponse.attributes[]` now carries `via: 'Bindings' | null` on such answers so a detail screen can group them.
- **Deferred fetch:** `GET taxonomy/nodes/:id/children` on the Yes value answers with the target's attributes.
- **Optional, always:** "Bindings included: Yes" alone is a complete answer. Nothing requires, nudges or counts identified bindings (D17).

## 4. Settings

`GET orgs/:orgId/ski-swap/settings` gains `nssraMember: boolean`, `nssraMemberSetBy: string | null`, `nssraMemberSetAt: string | null`. Informational for the iPad.

## 5. Acceptance, when the iPad takes any of this

- A ski described with Bindings included = Yes, a maker and a model syncs and reads back with those answers under `via: 'Bindings'`, and a name without them.
- Reachability on the iPad accepts the shared ids through Yes and refuses them without it (the server does).
- A chosen binding model shows its answer when online, and nothing when offline.
