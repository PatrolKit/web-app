# Plan 51: Who may see binding indemnification

## Goal

The indemnified-bindings lists are licensed. Binding indemnification is off unless a platform admin allows an organization, and then on only where that organization's own admins switch it on: once for the web, once for its check-in iPads. Turning either on certifies the organization's right to the lists.

This replaces Plan 44's NSSRA membership declaration (D5), which showed the NSSRA-sourced entries only to a member, and the manufacturer-direct ones (Marker's) to everyone.

## Decisions

| # | Decision |
|---|---|
| D1 | **The platform allows each organization.** `Organization.indemnificationAllowed`, with who and when, set in Platform Admin → Bindings → Organizations, one switch per org. Audited `ski_swap.indemnification.allowed`. |
| D2 | **The organization switches the web and the iPads, one switch each.** `SkiSwapSettings.indemnificationWeb` and `indemnificationIpad`, in Ski Swap → Administration → Binding indemnification. They're editable only while allowed; otherwise the PATCH is refused (403 `INDEMNIFICATION_OFF`). Audited `ski_swap.settings.indemnification`, with each change and whether it certified. |
| D3 | **Not allowed: hidden, and everything off.** The section isn't shown, both switches read off, and every lookup is refused. The org's stored switches are kept, so allowing it again restores them. |
| D4 | **Turning either on is the certification.** The section shows the text, and turning a switch on asks for confirmation with the same text. The server refuses to turn one on without `certifyIndemnification: true`, and records who certified and when. Turning off asks nothing. The text: *"By enabling this function you certify that your organization has a right to access this proprietary information, and that you will not copy or distribute it outside the limits of your agreement with the NSSRA."* It's `INDEMNIFICATION_CERTIFICATION`, and it's sent in the settings so the web and the iPad show the same words. |
| D5 | **It replaces the NSSRA declaration.** A client that may ask sees every list, NSSRA's and the makers' own. `nssraMember` is no longer read or written. Its columns stay, so the migration is additive, and the settings still send it, mirrored (`allowed && (web || ipad)`), for iPads that read it. The lookup never answers `unavailable` now, and `hiddenEntries` is always 0. |
| D6 | **Off hides every status answer.** That covers the Bindings tab, the answer beside a binding model in the item form, and every lookup route. Binding makes and models stay in the item picker: they're public product names, and Plan 19's single tree stays one tree. The taxonomy's `lookup: 'indemnification'` marker stays too; it only says an answer can be asked for. |
| D7 | **Enforced on the server, per client.** `IndemnificationAccessGuard`, on every route under `orgs/:orgId/ski-swap/bindings/indemnification`, refuses with 403 `INDEMNIFICATION_OFF` and a sentence, unless the org is allowed and the switch for the client asking is on. A device token is the iPad; a person's token is the web. It's read per request, so a switch takes effect at once. |
| D8 | **Existing orgs carry over.** The migration allows every org that declared NSSRA membership, turns its web and iPad switches on, and keeps its declaration's author and date as the certification. Every other org starts not allowed. |

## Server

- **Migration** `20261027120000_indemnification_access`, additive:
  - `Organization`: `indemnificationAllowed`, `indemnificationAllowedBy`, `indemnificationAllowedAt`.
  - `SkiSwapSettings`: `indemnificationWeb`, `indemnificationIpad`, `indemnificationCertifiedBy`, `indemnificationCertifiedAt`.
  - Backfill as D8.
- **`indemnification-access.ts`**:
  - `accessOf(org, settings)` gives `{ allowed, web, ipad }`, with web and iPad only ever true while allowed.
  - `refusalOf(access, client)` gives the sentence for a refused client.
  - `INDEMNIFICATION_CERTIFICATION` is the text.
  - `IndemnificationAccessGuard` enforces D7.
- **Settings** (`GET/PATCH orgs/:orgId/ski-swap/settings`):
  - The response gains `indemnification: { allowed, web, ipad, certification, certifiedBy, certifiedAt }`, with `certifiedBy` as a name.
  - The PATCH takes `indemnificationWeb`, `indemnificationIpad` and `certifyIndemnification: true`.
  - `nssraMember` leaves the PATCH.
- **Platform**:
  - `GET admin/bindings/indemnification/orgs` lists every org with `allowed`, by whom and when, its web and iPad switches as stored, and who certified and when.
  - `PATCH admin/bindings/indemnification/orgs/:orgId { allowed }` sets the allowance.
- **Lookup**: the NSSRA filter is gone (D5).

## Web

- **Platform Admin → Bindings → Organizations:** one switch per org, with each org's state ("Allowed · on for the web and the iPads · certified by …"). Stopping an allowance asks first.
- **Ski Swap → Administration → Binding indemnification:**
  - shown only while allowed;
  - the certification text, then "On the web" and "On the iPads";
  - turning either on confirms with the text;
  - "Certified by …, date" while either is on.
- **The Bindings tab** shows only while the web switch is on. Reached by URL while off, the page says why and asks for nothing.
- **The item form** shows the answer beside a model only while the web switch is on.

## iPad

`IOS_HANDOFF.md`.

## Tests

- **Unit:**
  - `accessOf` and `refusalOf`;
  - the guard, for each client;
  - the guard sits on the lookup controller;
  - the certification is required, recorded and audited;
  - turning off needs no certification;
  - switches are refused while not allowed;
  - the platform allowance is set, audited once, and leaves the switches alone;
  - the lookup shows every list.
- **Checked by hand in the local preview:**
  - Platform Admin allows and disallows an org;
  - the Administration section appears and disappears with it;
  - turning a switch on confirms with the text and records the certification;
  - the Bindings tab follows the web switch;
  - the lookup answers 200 while on and 403 while off;
  - the Bindings page reached by URL while off says why.
