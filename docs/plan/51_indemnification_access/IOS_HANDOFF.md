# To the iPad: binding indemnification has an on/off switch for iPads (server Plan 51)

## Why

The indemnified-bindings lists are licensed. They're now off unless a platform admin allows the organization, and then on for the iPads only once the organization's own admin switches **On the iPads** on (Ski Swap → Administration on the web). Turning it on certifies the organization's right to the lists.

This replaces Plan 44's NSSRA membership declaration. A patrol that may see the lists now sees **every** list. There is nothing in between, and no "unavailable" answer.

The iPad doesn't switch anything. It reads the switch, and shows binding indemnification only while it's on.

## What changes on the server

### 1. Settings carry the switch

`GET /api/v1/orgs/:orgId/ski-swap/settings`, which the iPad already reads, gains:

```json
"indemnification": {
  "allowed": true,
  "web": true,
  "ipad": true,
  "certification": "By enabling this function you certify that your organization has a right to access this proprietary information, and that you will not copy or distribute it outside the limits of your agreement with the NSSRA.",
  "certifiedBy": "Dana Smith",
  "certifiedAt": "2026-10-13T14:02:11.000Z"
}
```

- **`ipad` is the only field that decides what the iPad shows.** It's only ever `true` while `allowed` is `true`. You don't need to combine the two.
- `web` is the web's own switch. Ignore it.
- `certification`, `certifiedBy` and `certifiedAt` are optional to show. For example, a line under the Bindings screen's header: "Certified by Dana Smith on Oct 13".
- **Deprecated:** `nssraMember`, `nssraMemberSetBy` and `nssraMemberSetAt` are still sent, as `allowed && (web || ipad)` with the certifier, for builds that read them. Stop reading them.

Turning the switch on or off doesn't change `taxonomyVersion`. Pick it up on the iPad's usual settings read, each sync and when the app comes to the foreground.

### 2. The lookup refuses while off

Every route under `/api/v1/orgs/:orgId/ski-swap/bindings/indemnification/` (`manufacturers`, `manufacturers/:nodeId/models`, `search`, `models/:nodeId`) answers, when the iPad's switch is off or the org isn't allowed:

```
403 { "success": false, "error": "Binding indemnification isn’t turned on for this organization’s iPads.", "code": "INDEMNIFICATION_OFF" }
```

(or "…isn't available to this organization." when the platform hasn't allowed it).

When it's on, the answers are as Plan 44's handoff describes, except as in section 3.

### 3. No more `unavailable`

- A lookup that answers shows every list, so `answer` is never `unavailable`.
- `hiddenEntries` is always `0`.
- `nssraMember` in `GET manufacturers` is always `true`.

Keep handling `unavailable` if it's cheap, since it does no harm, but it won't arrive.

## What the iPad needs

1. **Read `indemnification.ipad`** from settings, the same way `showUsBootSizes` is read. Add it to `APISkiSwapSettings` as optional, treating missing as `false`.
2. **While it's `false`, show no binding indemnification anywhere:**
   - no Bindings lookup screen (hide its entry point);
   - no answer badge beside a binding model in the item form, even though the taxonomy still marks that question `lookup: "indemnification"`. The model picker itself stays: makes and models are public.
3. **While it's `true`, everything works as Plan 44's handoff describes.**
4. **On a `403` with `code: "INDEMNIFICATION_OFF"` from any lookup route, treat it as off at once:**
   - hide the screen and the badge;
   - don't retry;
   - re-read settings at the next chance.

   A switch can be turned off between settings reads.
5. **Remove the NSSRA notice** ("Your patrol hasn't declared NSSRA membership…"). It can no longer be true.
6. **If the iPad keeps any lookup answers on the device** (a cache, or an offline copy), drop them when `ipad` turns `false`. The lists are licensed, and "off" means off on the device too.

## Shipping

- **Live on patrolkit.io** since 2026-10-13 (server commit `aa502fe`).
- **Orgs that declared NSSRA membership carry over** with both switches on, so an existing patrol sees no change.
- **Builds that ignore the new field** keep working while the switch is on. Once an admin turns the iPads off, such a build gets `403` from the lookup. It should show that as an error rather than a "not listed" answer, which Plan 44's handoff already asks for.
