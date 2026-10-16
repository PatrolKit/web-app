// Plan 52: deletes every payout run, before the migration that reshapes the
// payout tables. Lists them first; deletes only with --delete.
//
//   node scripts/delete-payout-runs.mjs            # list only
//   node scripts/delete-payout-runs.mjs --delete   # list, then delete
//
// Refuses if any line was ever handed to PayPal (`payoutBatchId` or `sentAt`)
// or had a check marked sent (`checkSentAt`): money that moved is a record, not
// something to tidy away. Lines, line items and notices cascade with the run.
// Raw SQL, so it runs against the tables as they are before the migration.
// Touches the payout tables only, and writes one audit entry.

import { PrismaClient } from '@prisma/client';
import { createId } from '@paralleldrive/cuid2';

const prisma = new PrismaClient();
const doDelete = process.argv.includes('--delete');

try {
  const runs = await prisma.$queryRawUnsafe(`
    SELECT r.id, r.orgId, r.swapId, r.status, r.createdAt,
           (SELECT COUNT(*) FROM PayoutLine l WHERE l.runId = r.id) AS lineCount,
           (SELECT COUNT(*) FROM PayoutLine l WHERE l.runId = r.id
              AND (l.payoutBatchId IS NOT NULL OR l.sentAt IS NOT NULL OR l.checkSentAt IS NOT NULL)) AS movedCount
    FROM PayoutRun r ORDER BY r.createdAt`);

  console.log(`${runs.length} payout run(s):`);
  for (const r of runs) {
    console.log(`  ${r.id}  org ${r.orgId}  swap ${r.swapId}  ${r.status}  ${new Date(r.createdAt).toISOString()}  ${Number(r.lineCount)} line(s), ${Number(r.movedCount)} with money moved`);
  }

  const moved = runs.filter((r) => Number(r.movedCount) > 0);
  if (moved.length) {
    console.error(`Refusing: ${moved.length} run(s) have lines handed to PayPal or checks marked sent.`);
    process.exit(1);
  }
  if (!doDelete || runs.length === 0) {
    console.log(doDelete ? 'Nothing to delete.' : 'Listed only. Run with --delete to delete them.');
    process.exit(0);
  }

  const deleted = await prisma.$transaction(async (tx) => {
    const n = await tx.$executeRawUnsafe('DELETE FROM PayoutRun');
    for (const orgId of new Set(runs.map((r) => r.orgId))) {
      await tx.auditLog.create({
        data: {
          id: createId(),
          actorType: 'system',
          actorId: 'plan-52-migration',
          orgId,
          action: 'payout_run.deleted_for_plan_52',
          targetType: 'payout_run',
          metadata: { runs: runs.filter((r) => r.orgId === orgId).map((r) => ({ id: r.id, swapId: r.swapId, status: r.status, lines: Number(r.lineCount) })) },
        },
      });
    }
    return n;
  });

  const [{ remaining }] = await prisma.$queryRawUnsafe('SELECT COUNT(*) AS remaining FROM PayoutRun');
  console.log(`Deleted ${deleted} run(s). Payout runs left: ${Number(remaining)}.`);
} finally {
  await prisma.$disconnect();
}
