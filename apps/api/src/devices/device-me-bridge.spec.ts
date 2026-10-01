import { DevicesService } from './devices.service';

/**
 * `/devices/me` names the bridge a tablet's station prints through (Plan 28),
 * so the iPad asks it for helper labels only when there is one.
 */

type Row = Record<string, unknown> & { id: string };

function service(devices: Row[]) {
  const prisma = {
    device: {
      findUnique: async ({ where }: { where: { id: string } }) => devices.find((d) => d.id === where.id) ?? null,
      update: async () => ({}),
    },
  };
  const config = { get: () => 'https://patrolkit.io/sell' };
  const unused = {} as never;
  return new DevicesService(prisma as never, unused, unused, unused, unused, config as never);
}

const ORG = { name: 'Org', logoUrl: null };
const ipad = (station: Row | null): Row => ({
  id: 'ipad-1', name: 'Counter iPad', role: 'ski_swap.staff_check_in', orgId: 'org-1', org: ORG,
  attendedStation: station, bridgedStations: [], resort: null,
});
const STATION = { id: 'st-3', name: 'Station 3', code: 'C', deletedAt: null };

describe('the station on /devices/me', () => {
  it('names its bridge and the printer the bridge drives', async () => {
    const me = await service([
      ipad({ ...STATION, bridgeDeviceId: 'bridge-1' }),
      { id: 'bridge-1', name: 'Station 3 bridge', bridgedPrinter: { id: 'pr-1', model: 'm221', paperSize: '25x67' } },
    ]).getDeviceMe('ipad-1');
    expect(me.station).toEqual({
      id: 'st-3', name: 'Station 3', code: 'C',
      printBridge: { deviceId: 'bridge-1', name: 'Station 3 bridge', printer: { id: 'pr-1', model: 'm221', paperSize: '25x67' } },
    });
  });

  it('gives a bridge with no printer a null printer', async () => {
    const me = await service([
      ipad({ ...STATION, bridgeDeviceId: 'bridge-1' }),
      { id: 'bridge-1', name: 'Station 3 bridge', bridgedPrinter: null },
    ]).getDeviceMe('ipad-1');
    expect(me.station?.printBridge).toEqual({ deviceId: 'bridge-1', name: 'Station 3 bridge', printer: null });
  });

  it('is null for a station with no bridge', async () => {
    const me = await service([ipad({ ...STATION, bridgeDeviceId: null })]).getDeviceMe('ipad-1');
    expect(me.station?.printBridge).toBeNull();
  });

  it('leaves an unbound tablet with no station at all', async () => {
    const me = await service([ipad(null)]).getDeviceMe('ipad-1');
    expect(me.station).toBeNull();
  });
});
