import { ConflictException } from '@nestjs/common';
import { StationService } from './station.service';
import { PrintQueueService } from './print-queue.service';

/**
 * One print bridge for several staffed stations (Plan 27).
 *
 * A bridge serves either one self-service station or any number of staffed
 * ones, never a mix, and its claim prints for all of them.
 */

type Station = { id: string; orgId: string; name: string; code: string; attendantDeviceId: string | null; bridgeDeviceId: string | null; deletedAt: Date | null };
type Device = { id: string; orgId: string; role: string };

function stationHarness(stations: Station[], devices: Device[]) {
  const prisma = {
    checkinStation: {
      findFirst: async ({ where }: { where: { id: string } }) => stations.find((s) => s.id === where.id && !s.deletedAt) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Partial<Station> }) => {
        const s = stations.find((x) => x.id === where.id)!;
        Object.assign(s, data);
        return { ...s, createdAt: new Date(), attendant: null, bridge: null };
      },
    },
    device: {
      findFirst: async ({ where, include }: {
        where: { id: string };
        include: { bridgedStations?: { where: { id: { not: string } } }; attendedStation?: boolean };
      }) => {
        const d = devices.find((x) => x.id === where.id);
        if (!d) return null;
        return {
          ...d,
          attendedStation: stations.find((s) => s.attendantDeviceId === d.id) ?? null,
          bridgedStations: stations.filter(
            (s) => s.bridgeDeviceId === d.id && !s.deletedAt && s.id !== include.bridgedStations?.where.id.not,
          ),
        };
      },
    },
  };
  return new StationService(prisma as never, {} as never);
}

const BRIDGE = { id: 'bridge-1', orgId: 'org-1', role: 'ski_swap.print_bridge' };
const IPAD = (n: number) => ({ id: `ipad-${n}`, orgId: 'org-1', role: 'ski_swap.staff_check_in' });
const station = (id: string, over: Partial<Station> = {}): Station => ({
  id, orgId: 'org-1', name: `Station ${id}`, code: id, attendantDeviceId: null, bridgeDeviceId: null, deletedAt: null, ...over,
});

describe('sharing a bridge', () => {
  it('binds a free bridge to any station', async () => {
    const stations = [station('A')];
    await expect(stationHarness(stations, [BRIDGE]).update('org-1', 'A', { bridgeDeviceId: 'bridge-1' })).resolves.toBeDefined();
    expect(stations[0].bridgeDeviceId).toBe('bridge-1');
  });

  it('lets a second staffed station share a staffed station’s bridge', async () => {
    const stations = [
      station('A', { attendantDeviceId: 'ipad-1', bridgeDeviceId: 'bridge-1' }),
      station('B', { attendantDeviceId: 'ipad-2' }),
    ];
    await stationHarness(stations, [BRIDGE, IPAD(1), IPAD(2)]).update('org-1', 'B', { bridgeDeviceId: 'bridge-1' });
    expect(stations[1].bridgeDeviceId).toBe('bridge-1');
  });

  it('refuses a self-service station a bridge that is already in use', async () => {
    const stations = [station('A', { attendantDeviceId: 'ipad-1', bridgeDeviceId: 'bridge-1' }), station('B')];
    await expect(stationHarness(stations, [BRIDGE, IPAD(1)]).update('org-1', 'B', { bridgeDeviceId: 'bridge-1' }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(stations[1].bridgeDeviceId).toBeNull();
  });

  it('refuses a staffed station the bridge of a self-service one', async () => {
    const stations = [station('A', { bridgeDeviceId: 'bridge-1' }), station('B', { attendantDeviceId: 'ipad-2' })];
    const err = await stationHarness(stations, [BRIDGE, IPAD(2)])
      .update('org-1', 'B', { bridgeDeviceId: 'bridge-1' })
      .catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as Error).message).toMatch(/self-service station "Station A"/);
  });

  it('refuses to take the tablet from a station that shares its bridge', async () => {
    const stations = [
      station('A', { attendantDeviceId: 'ipad-1', bridgeDeviceId: 'bridge-1' }),
      station('B', { attendantDeviceId: 'ipad-2', bridgeDeviceId: 'bridge-1' }),
    ];
    await expect(stationHarness(stations, [BRIDGE, IPAD(1), IPAD(2)]).update('org-1', 'B', { attendantDeviceId: null }))
      .rejects.toBeInstanceOf(ConflictException);
    expect(stations[1].attendantDeviceId).toBe('ipad-2');
  });

  it('lets a station with a bridge of its own lose its tablet', async () => {
    const stations = [station('A', { attendantDeviceId: 'ipad-1', bridgeDeviceId: 'bridge-1' })];
    await stationHarness(stations, [BRIDGE, IPAD(1)]).update('org-1', 'A', { attendantDeviceId: null });
    expect(stations[0].attendantDeviceId).toBeNull();
  });

  it('ignores a retired station when deciding', async () => {
    const stations = [
      station('A', { bridgeDeviceId: 'bridge-1', deletedAt: new Date() }),
      station('B'),
    ];
    await stationHarness(stations, [BRIDGE]).update('org-1', 'B', { bridgeDeviceId: 'bridge-1' });
    expect(stations[1].bridgeDeviceId).toBe('bridge-1');
  });
});

describe('the claim of a shared bridge', () => {
  function claimHarness() {
    const sql: { text: string; values: unknown[] }[] = [];
    const prisma = {
      device: {
        update: async () => ({}),
        findUnique: async () => ({ lastSeenAt: new Date() }),
        findUniqueOrThrow: async () => ({
          bridgedPrinter: null,
          bridgedScanner: null,
          bridgedStations: [{ id: 'station-a', name: 'Station A' }, { id: 'station-b', name: 'Station B' }],
        }),
      },
      $executeRaw: async (strings: TemplateStringsArray | { strings: string[]; values: unknown[] }, ...values: unknown[]) => {
        const text = Array.isArray(strings) ? strings.join('?') : (strings as { strings: string[] }).strings.join('?');
        sql.push({ text, values: values.flatMap((v) => ((v as { values?: unknown[] })?.values ?? [v])) });
        return 0;
      },
      printJob: { findMany: async () => [], count: async () => 0 },
    };
    const queue = new PrintQueueService(prisma as never, {} as never, {} as never, { recordCheckIn: async () => undefined } as never);
    return { queue, sql };
  }

  it('takes and sweeps jobs from every station the bridge serves, oldest batch first', async () => {
    const { queue, sql } = claimHarness();
    await queue.claim('bridge-1', 4, undefined, undefined, undefined, 0);
    const take = sql.find((q) => q.text.includes("SET status = 'claimed'"))!;
    const sweep = sql.find((q) => q.text.includes("SET status = 'abandoned'"))!;
    for (const q of [take, sweep]) {
      expect(q.text).toMatch(/stationId IN \(/);
      expect(q.values).toEqual(expect.arrayContaining(['station-a', 'station-b']));
    }
    expect(take.text).toMatch(/ORDER BY createdAt, seq/);
  });

  it('names every station, and keeps the first as `stationId`', async () => {
    const { queue } = claimHarness();
    await expect(queue.claim('bridge-1', 4, undefined, undefined, undefined, 0)).resolves.toMatchObject({
      stationId: 'station-a', stationIds: ['station-a', 'station-b'],
    });
  });

  it('is woken by work queued at any of its stations', async () => {
    const { queue, sql } = claimHarness();
    let close: () => void = () => undefined;
    const res = { on: (_e: string, f: () => void) => { close = f; }, off: () => undefined };
    const takes = () => sql.filter((q) => q.text.includes("SET status = 'claimed'")).length;

    const held = queue.claim('bridge-1', 4, undefined, undefined, res, 5_000);
    await new Promise((r) => setTimeout(r, 50));
    expect(takes()).toBe(1); // looked once, found nothing, now waiting

    (queue as unknown as { wake: (id: string) => void }).wake('station-b');
    await new Promise((r) => setTimeout(r, 50));
    // Looked again at once — well inside the 2 s re-check it would otherwise wait for.
    expect(takes()).toBe(2);

    close();
    await held;
  });
});
