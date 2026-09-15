# Reply to `patrolkit_ios` — Plan 13, provisioned scanners

Answering [`docs/plan/13_provisioned_scanners/SERVER_HANDOFF.md`](../../../../patrolkit_ios/docs/plan/13_provisioned_scanners/SERVER_HANDOFF.md).

**Ask A is done and deployed.** `GET /orgs/:orgId/ski-swap/scanners` takes a
device token with role `ski_swap.staff_check_in`. Nothing about the response
changed — `SwapScannerResponseSchema` already carried every field your table
lists, and the smoke asserts all five come back.

Your three notes, answered, and then the one thing you asked for that you should
not have got.

## Pagination — there is none, on either list

Read it as a single page. `GET /scanners` returns a bare array inside the usual
`{ success, data }` envelope, with no `limit`, no `offset` and no `total`. So
does `GET /printers`, so your paging helper is already meeting that shape on the
printer side and will meet the same one here.

An org owns a handful of these. If that ever stops being true, pagination is an
additive change to the envelope and your helper is the reason it will be cheap.

## `ski_swap:manage` on a device token — it is never consulted

Worth knowing exactly, because the mental model behind the question does not
match what the code does.

`PermissionsGuard` treats a device and a person as different principals. For a
device it checks the **role and only the role** — `@RequirePermissions` is not
evaluated at all, and there is no path by which a device "satisfies
`ski_swap:manage` through its role". For a person it checks permissions and
ignores roles. The two never meet.

So the `@RequirePermissions('ski_swap:manage')` on the list route is, for your
iPad, decorative. What lets it through is `@RequireDeviceRole`. A device with the
wrong role gets a 403 naming the role it needed; a print bridge asking for the
scanner list is refused, and the smoke covers it.

## Offline-first

Nothing here fights it. The list is a plain read with no cursor, no ETag and no
server-held state, so caching it in SQLite and reading only the cache is the
shape the route expects.

## What we did not do: your controller

You proposed this, and said in the same breath that create, patch and delete stay
people-only:

```ts
@UseGuards(OrDeviceAuthGuard, …, PermissionsGuard)
@RequireDeviceRole('ski_swap.staff_check_in')   // ← on the class
export class ScannerController { … }
```

**Those two things contradict each other.** `@RequireDeviceRole` on the class
applies to every route in it, and per the section above a device that clears the
role is through — the `ski_swap:admin` on the write routes is never read. That
controller would have let any check-in iPad in the org delete scanners.

The role decorator is on the **list handler** instead. Every other route then
sees no roles at all, and `PermissionsGuard` turns devices away with *"This
endpoint is not available to devices"*. Same one-line ask, same route open, none
of the rest.

`apps/api/scripts/smoke-scanner-device-access.mjs` holds it there: an iPad lists,
and is refused a create, a rename and a delete, with the row checked afterwards
to confirm nothing happened.

## And a live one you found by accident

Copying `PrinterController` was reasonable — it is the precedent, and it is what
we would have reached for too. It also had this bug already, in production.

A check-in iPad could **rename and delete printers**. `DELETE` returned 204 and
the row was gone; we confirmed it against a running server before changing
anything. The other write routes take `@CurrentUser` and were dereferencing an
undefined user, so they failed as 500s — which looks like a bug rather than an
open door, and is how this went unnoticed.

Fixed the same way: the role decorator moved from the class to the list handler.
**Nothing you use changes.** `GET /printers` was the only printer route a device
could call successfully, and it still answers 200. The routes that now return 403
either returned 500 before or should never have worked.

If any iPad build is renaming or deleting printers with a device token, it will
start getting 403s — tell us and we will look again, but we do not think one is.

## Summary of what shipped

| Route | Device token | Person |
|---|---|---|
| `GET /ski-swap/scanners` | `ski_swap.staff_check_in` ✅ | `ski_swap:manage` |
| `POST`/`PATCH`/`DELETE /ski-swap/scanners` | refused | `ski_swap:admin` |
| `GET /ski-swap/printers` | `ski_swap.staff_check_in` ✅ | `ski_swap:manage` |
| `POST`/`PATCH`/`DELETE /ski-swap/printers` | refused *(was: allowed)* | `ski_swap:admin` |
