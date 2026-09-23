import { GoneException, NotFoundException } from '@nestjs/common';
import { PrintQueueService } from './print-queue.service';

/**
 * A claimed job's raster as raw bytes, for a bridge with no PSRAM.
 *
 * What the firmware asked for, as rules: only the bridge holding the claim,
 * only while it is live, the same bytes on every fetch, and no side effects.
 * The claim's own SQL is covered by `smoke-print-queue.mjs`; this covers what
 * happens around it.
 */

type Job = {
  id: string; orgId: string; kind: string; itemId: null; sellerId: null; swapId: null; params: null;
  seq: number; status: string; claimToken: string | null; claimUntil: Date | null; claimedAt: Date | null;
  bridgeDeviceId: string;
};

function harness(jobs: Job[]) {
  let renders = 0;
  const writes: unknown[] = [];
  const prisma = {
    device: { update: async () => ({}) },
    checkinStation: {
      findFirst: async () => ({ id: 'station-1', bridge: { bridgedPrinter: null, bridgedScanner: null } }),
    },
    $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      // The claim: every queued job takes the token.
      if (strings.join('?').includes("SET status = 'claimed'")) {
        const token = values[0] as string;
        for (const j of jobs.filter((x) => x.status === 'queued')) {
          Object.assign(j, { status: 'claimed', claimToken: token, claimedAt: new Date(), claimUntil: new Date(Date.now() + 90_000) });
        }
      }
      return 0;
    },
    printJob: {
      findMany: async ({ where }: { where: { claimToken: string } }) => jobs.filter((j) => j.claimToken === where.claimToken),
      findFirst: async ({ where }: { where: { id: string; station: { bridgeDeviceId: string } } }) => {
        const job = jobs.find((j) => j.id === where.id && j.bridgeDeviceId === where.station.bridgeDeviceId);
        return job ? { ...job, station: { bridge: { bridgedPrinter: null } } } : null;
      },
      count: async () => 0,
      update: async (args: unknown) => { writes.push(args); return {}; },
    },
    swapItem: { update: async () => ({}) },
  };
  // Every render is different, so a test can tell a kept raster from a new one.
  const renderer = { toRaster: () => Buffer.from(`raster-${++renders}-`.padEnd(64, '#')) };
  const recipes = { resolve: async () => [[[true, false, true, false, true, false, true, false]]] };
  const queue = new PrintQueueService(prisma as never, renderer as never, recipes as never);
  return { queue, writes, renders: () => renders };
}

const job = (over: Partial<Job> = {}): Job => ({
  id: 'job-1', orgId: 'org-1', kind: 'calibration', itemId: null, sellerId: null, swapId: null, params: null,
  seq: 1, status: 'queued', claimToken: null, claimUntil: null, claimedAt: null, bridgeDeviceId: 'bridge-1', ...over,
});

describe('claiming without the payload', () => {
  it('leaves the base64 out and says how many bytes to expect', async () => {
    const { queue } = harness([job()]);
    const claim = await queue.claim('bridge-1', 1, undefined, undefined, undefined, 0, { omitPayload: true });
    expect(claim.jobs[0]).not.toHaveProperty('payload');
    expect(claim.jobs[0]).toMatchObject({ id: 'job-1', rasterBytes: 64, widthBytes: 1 });
  });

  it('changes nothing for a bridge that does not ask, beyond adding the size', async () => {
    const { queue } = harness([job()]);
    const claim = await queue.claim('bridge-1', 1, undefined, undefined, undefined, 0);
    expect(Buffer.from(claim.jobs[0].payload!, 'base64')).toHaveLength(claim.jobs[0].rasterBytes);
  });
});

describe('fetching the raster', () => {
  it('returns exactly the bytes the claim measured, every time, without rendering again', async () => {
    const { queue, renders } = harness([job()]);
    const claim = await queue.claim('bridge-1', 1, undefined, undefined, undefined, 0, { omitPayload: true });
    const first = await queue.raster('bridge-1', 'job-1');
    const second = await queue.raster('bridge-1', 'job-1');
    expect(first).toHaveLength(claim.jobs[0].rasterBytes);
    expect(second.equals(first)).toBe(true);
    expect(renders()).toBe(1);
  });

  it('matches the inline payload byte for byte', async () => {
    const { queue } = harness([job()]);
    const claim = await queue.claim('bridge-1', 1, undefined, undefined, undefined, 0);
    expect((await queue.raster('bridge-1', 'job-1')).toString('base64')).toBe(claim.jobs[0].payload);
  });

  it('changes nothing about the job', async () => {
    const { queue, writes } = harness([job()]);
    await queue.claim('bridge-1', 1, undefined, undefined, undefined, 0, { omitPayload: true });
    await queue.raster('bridge-1', 'job-1');
    expect(writes).toEqual([]);
  });

  it('renders again after a restart, and keeps that for the rest of the claim', async () => {
    const live = job({ status: 'claimed', claimToken: 't1', claimedAt: new Date(), claimUntil: new Date(Date.now() + 60_000) });
    const { queue, renders } = harness([live]);
    const first = await queue.raster('bridge-1', 'job-1');
    expect((await queue.raster('bridge-1', 'job-1')).equals(first)).toBe(true);
    expect(renders()).toBe(1);
  });

  it('is 404 for a job on another bridge, one that does not exist, or one never claimed', async () => {
    const { queue } = harness([
      job({ id: 'theirs', bridgeDeviceId: 'bridge-2', status: 'claimed', claimToken: 't', claimedAt: new Date(), claimUntil: new Date(Date.now() + 60_000) }),
      job({ id: 'waiting' }),
    ]);
    await expect(queue.raster('bridge-1', 'theirs')).rejects.toBeInstanceOf(NotFoundException);
    await expect(queue.raster('bridge-1', 'nope')).rejects.toBeInstanceOf(NotFoundException);
    await expect(queue.raster('bridge-1', 'waiting')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is 410 once the claim has expired or been settled', async () => {
    const claimed = { claimedAt: new Date(Date.now() - 120_000) };
    const { queue } = harness([
      job({ id: 'expired', status: 'claimed', claimToken: 't', claimUntil: new Date(Date.now() - 1_000), ...claimed }),
      job({ id: 'printed', status: 'printed', ...claimed }),
      job({ id: 'requeued', status: 'queued', ...claimed }),
      job({ id: 'abandoned', status: 'abandoned', ...claimed }),
    ]);
    for (const id of ['expired', 'printed', 'requeued', 'abandoned']) {
      await expect(queue.raster('bridge-1', id)).rejects.toBeInstanceOf(GoneException);
    }
  });

  it('forgets the kept raster when the job is settled', async () => {
    const jobs = [job()];
    const { queue } = harness(jobs);
    await queue.claim('bridge-1', 1, undefined, undefined, undefined, 0, { omitPayload: true });
    await queue.nack('bridge-1', 'job-1', 'no room');
    Object.assign(jobs[0], { status: 'queued', claimToken: null, claimUntil: null });
    await expect(queue.raster('bridge-1', 'job-1')).rejects.toBeInstanceOf(GoneException);
    expect((queue as unknown as { rasters: Map<string, unknown> }).rasters.size).toBe(0);
  });
});
