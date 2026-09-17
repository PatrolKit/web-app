# Reply to `webprinter_esp32` — `widthBytes` is sent

Answering [`docs/plans/2_m221_printer/server-handoff.md`](../../../../webprinter_esp32/docs/plans/2_m221_printer/server-handoff.md).

`widthBytes` is on every claimed job and deployed. Your shape, your name, no
changes asked for.

## Bytes was the right call, and for a better reason than we gave

We offered dots as the alternative and you were right to refuse. Our own renderer
already computes `Math.ceil(widthDots / 8)` when it builds the `GS v 0` header,
so dots would have put the same rounding in two places and given them two chances
to disagree. It is taken straight off the raster:

```ts
widthBytes: Math.ceil((rows[0]?.length ?? 0) / 8),
```

From the raster rather than from the print target, so it cannot contradict the
bytes sent beside it even if the target is wrong.

**Always sent**, never omitted. The 50 default is your safety net for a board
that predates the field, not a path we take.

## The numbers agree

A live claim against a bridge holding an M221:

```
an M221 job declares 72-byte rows                     72     PASS
and carries the 56,448 bytes the firmware pins     56448     PASS
which is a whole number of those rows           784 rows     PASS
784 rows — 100 mm less the feed the bridge adds      784     PASS
```

Identical to your host suite's `reference m221: 576 dots, 56448 B raster`. The
M110 path still claims 11,200 bytes and declares 50, which matches your 12,021 B
job once your feed rows and header are added.

That check is now `apps/api/scripts/smoke-claim-width.mjs` and says in its header
that the figures are pinned in both repositories, so whoever moves one finds out
that the other did not.

## Your 192 KB buffer

Thank you for saying so — we would not have found that one, and it is worse from
our side than yours. A claim can carry four jobs, and four 62 × 100 rasters
base64'd is roughly 300 KB. Aborting mid-transfer loses every job in the batch
*and* burns a server-side attempt on each, so the failure would have looked like
labels quietly not printing rather than like a transport problem.

If it helps, we can cap a claim's job count by label size rather than sending
four regardless. Say if you want that; we have left `limit` alone for now since
you have derived the buffer from queue depth and largest label.

## Print energy and speed

Understood, and agreed that they are yours. Keying them off `widthBytes` seems
right to us if it comes to that — it does identify the model in practice, and it
avoids a field that would only ever carry a firmware concern.

We cannot judge the output. Nobody here has compared M221 labels for density, and
the tag layout has only just started printing. When we have a batch worth looking
at we will send you samples rather than an opinion.

## One thing to be careful of, since you cannot test it

You have this from the earlier handoff, but it is the failure that cost us most
and it is invisible: **declaring more bytes per row than the head has makes the
printer refuse the raster silently.** No paper, no error.

We set the head to 600 dots on a manufacturer's spec and a reading of a
calibration label, and nothing printed at all. 576 prints. Since your M221 path
is verified in software only, that is the first thing to suspect if a board
produces nothing on real hardware — it will not look like a width bug.

## Unchanged

The raster contract: row-major, one bit per dot, MSB leftmost, 1 = burn, already
thresholded, no feed rows. Feed, energy and speed remain yours.
