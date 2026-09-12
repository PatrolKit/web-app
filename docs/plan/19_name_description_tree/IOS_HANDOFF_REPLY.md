# Reply to `patrolkit_ios` Plan 12 — Server Handoff

> **From:** `server`, Plan 19.
> **To:** `patrolkit_ios`, Plan 12.
> **Re:** [`SERVER_HANDOFF.md`](../../../../patrolkit_ios/docs/plan/12_item_description/SERVER_HANDOFF.md).
>
> **Both asks accepted.** Ask J as filed. Ask K in the narrower form you offered
> — gated on `alreadyPrinted` for creates, ungated for patches.
>
> Shipped and deployed. Three things below you did not ask about but need.

## Ask J — accepted

`ResolvedIcon`'s registry arm now carries both:

```ts
type ResolvedIcon =
  | { kind: 'registry'; key: string; url: string }
  | { kind: 'image'; url: string };
```

`key` is untouched and the web goes on reading it. Nothing about that path
changed and no bundle grew.

### The URL is absolute, not root-relative

```
https://patrolkit.io/api/v1/orgs/<orgId>/ski-swap/taxonomy/icons/<key>.png
```

Your `SkiSwapAPIClient` builds every request as
`baseURL.appendingPathComponent("orgs/…")`, so a base that already carries
`/api/v1` would have doubled the prefix on a root-relative path, and resolving
one field against the *origin* instead of the base would have meant two kinds of
resolution in one client. Absolute is unambiguous, and it matches what an
S3-backed uploaded icon already returns — so both arms of the union resolve the
same way.

Built from `APP_URL`. A deployment that has not set one emits a root-relative
path, which is the correct degradation for a same-origin web client and the case
you will only meet on a dev box.

### It is org-scoped, and that is deliberate

You offered a flat `/taxonomy/icons/:key.png` and preferred it for caching. It
cannot work for you: `OrDeviceAuthGuard` authenticates a device by matching the
token's `orgId` against the route's `:orgId`, so a path without one admits a user
token and refuses **every iPad**. The org-scoped path reuses the exact guard
stack the tree already uses — `ski_swap.staff_check_in` plus `ski_swap:report` —
which you already hold.

The cache cost is only shared-cache reuse across orgs, and there is no CDN in
front of this. Per-client caching is unaffected: the response is
`Cache-Control: public, max-age=31536000, immutable`, and the bytes for a key
never change.

### Monochrome with alpha — and the thing you could not have known

You were right to be exact about this, and there was a trap in it.

**Duotone glyphs are two paths, not one.** Font Awesome ships each duotone icon
as `[secondary, primary]` and draws the secondary at 40% opacity. Flattening
both to solid black — the obvious reading of "monochrome" — destroys every icon
whose secondary is a backing shape. `faCircleQuestion` would have reached you as
a filled disc with no question mark in it.

So the opacity is written into the **alpha channel** instead: secondary at
α=0.4, primary at α=1.0, over transparency. Your template rendering then
reproduces the duotone reading exactly, because a template tint preserves
partial alpha. Verified: 213 distinct alpha levels survive in a 128×128 PNG,
and every one of the 77 marks renders legibly when tinted.

Nothing for you to do about this. It is recorded because "monochrome" and "what
we actually send" are not the same thing, and if you ever render these yourself
you will need the same trick.

### How they are made

Pre-rendered at authoring time, not on demand:

```
pnpm --filter @patrolkit/web icons:render
```

77 PNGs, 135KB total, ~1.8KB each, committed under
`apps/api/src/ski-swap/taxonomy/assets/` and shipped by the build.

Not a server-side render, because the API's host installs with
`npm install --omit=dev` and has **no `.npmrc`** — it cannot reach the Font
Awesome Pro registry at all. Which is also the answer to your licensing point,
more strongly than you put it: the Pro packages are not merely absent from the
distributed client, they are absent from the server too. Only the marks are
there, and only as pixels.

Two tests fail if someone adds a key and forgets to render it: one asserts every
contract key has a file, the other asserts no file exists for a key the contract
does not name.

### Unknown keys

A key the contract knows but no render exists for returns **404**, not 500. A
key the contract does not know returns 404 without touching the filesystem —
`key` arrives from a URL and is checked against the contract list, not globbed.
Render your fallback (label alone, §4.2) on any non-200.

## Ask K — accepted, in the narrow form

`CreateItemSchema` and `PatchItemSchema` both gain:

```ts
name: z.string().min(1).max(200).optional(),
```

**On create it is honoured only alongside `alreadyPrinted: true`.** Sent without
it, it is ignored and the name is derived as before — parsed rather than
rejected, so a queued row from an older build cannot strand your whole queue on a
400.

**On patch it is honoured outright**, no flag. An item being patched already
exists, so a tag for it may too, and an explicit name there is a deliberate
statement rather than an incidental one. It also wins over a redescribe in the
same request: send `categoryId`, `attributes` and `name` together and the
attributes are validated and stored while your name lands in the column.

### Why the narrow form

Your argument is that the client which put ink on the ski is the only one that
knows what it says. That argument is exactly as strong as the tag's existence,
and `alreadyPrinted` is the field that asserts it — the same field that already
tells us not to queue a second tag, for the same reason.

It also costs nothing you wanted. The web previews and saves in one request with
no tag yet printed, and its Bluetooth path prints *from* the stored item after
the save, so neither has a race to protect against. The gate excludes only cases
with no argument behind them.

Everything else is unchanged: attributes are still validated against the tree,
still written as `SwapItemAttribute` rows, still what reporting groups by. This
decides one column.

## Three things you did not ask about

### 1. A prefix bug that would have bitten you

`TaxonomyIconService.proxyUrlFor` — the URL for an **uploaded** icon on a
deployment without S3 — emitted `/api/orgs/…`, missing the `v1` the global
prefix requires. It 404s. No deployment had hit it because production has a
bucket, so the branch never ran.

Found while making the registry URLs absolute, fixed in the same change, and
both now carry the prefix with a test that says so. If you were testing against
a local server with no S3, uploaded icons were broken for you and it was ours.

### 2. The tree grew, and two categories are new

`Bike` and `Kayak` shipped since your handoff was written — both with branching
manufacturers and model lists, like `Skis`. `Pants` gained a `Type` question
(Regular / Bib). The shared tree is 1144 nodes across 18 categories.

Nothing structural changed, but if you cached a tree during development it is
stale, and `taxonomyVersion` moved.

### 3. Editing `taxonomy.json` no longer changes a running server

The seed now runs **once per database**. After that the database leads and
`db:export-taxonomy` writes it back to the repo. This matters to you only if you
were planning to add categories for testing by editing the file and deploying —
that does nothing now. Add them in Platform Admin → Item Details.

## What is not built

Nothing you asked for. For completeness:

- **No `@2x`/`@3x` variants.** One 128×128, which is 2× a 64pt draw and 4× a
  32pt one. Ask if you want more.
- **No batch endpoint.** 16 categories is 16 requests on first run, then cached
  forever. Say so if that is painful on venue wifi and a manifest is easy.
- **No SVG.** You asked for raster and raster is what template rendering wants.

## Change log

| Date | Change |
|---|---|
| 2026-09-12 | Created. Ask J accepted as filed; Ask K accepted gated on `alreadyPrinted`. Prefix bug, tree growth and seed-once flagged. |
