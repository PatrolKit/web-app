// Plan 55: replays every patroller's clock events once, so shifts folded before
// the fold recorded `closeEventId` learn it. Prints what each org would change;
// writes only with --apply.
//
//   node scripts/recompute-time-clock.mjs            # report only
//   node scripts/recompute-time-clock.mjs --apply    # report, then recompute
//
// Uses the built fold (`dist/`), so it is the same code the server runs. Build
// first. A shift it changes gets a new `updatedAt`, so every iPad re-downloads
// those shifts once; nothing else moves. Each patroller is its own transaction.
//
// On production this writes real orgs' data: run it there only with the user's
// go-ahead.

import { createRequire } from 'module';
import { PrismaClient } from '@prisma/client';

const require = createRequire(import.meta.url);
const { foldEvents, shiftChanges, TimeClockFoldService, UNFOLDED_STATUSES } = require('../dist/src/time-clock/fold.service.js');

const prisma = new PrismaClient();
const apply = process.argv.includes('--apply');

try {
  const orgs = await prisma.organization.findMany({ select: { id: true, slug: true } });
  const fold = new TimeClockFoldService(prisma);
  let totalChanged = 0;

  for (const org of orgs) {
    const patrollers = await prisma.timeClockEvent.findMany({
      where: { orgId: org.id },
      distinct: ['patrollerId'],
      select: { patrollerId: true },
    });
    if (!patrollers.length) continue;

    let create = 0, update = 0, tombstone = 0, missingClose = 0;
    for (const { patrollerId } of patrollers) {
      const events = await prisma.timeClockEvent.findMany({
        where: { orgId: org.id, patrollerId, status: { notIn: [...UNFOLDED_STATUSES] } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
      const stored = await prisma.timeClockShift.findMany({ where: { orgId: org.id, patrollerId } });
      const changes = shiftChanges(stored, foldEvents(events).shifts);
      create += changes.create.length;
      update += changes.update.length;
      tombstone += changes.tombstone.length;
      missingClose += stored.filter((s) => s.status === 'closed' && !s.closeEventId && s.closeReason !== 'superseded').length;

      if (apply && (changes.create.length || changes.update.length || changes.tombstone.length)) {
        await fold.recomputeForPatroller(org.id, patrollerId);
      }
    }
    totalChanged += create + update + tombstone;
    console.log(
      `${org.slug}: ${patrollers.length} patroller(s); ${missingClose} closed shift(s) without their close; ` +
        `would create ${create}, update ${update}, tombstone ${tombstone}${apply ? ' — applied' : ''}`,
    );
  }

  console.log(apply ? `\nDone: ${totalChanged} shift(s) written.` : `\n${totalChanged} shift(s) would change. Run with --apply to write them.`);
} finally {
  await prisma.$disconnect();
}
