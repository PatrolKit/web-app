import { appReport } from './devices-me.controller';
import { DevicesService } from './devices.service';

/**
 * A staff iPad says which app it runs on each `/devices/me`, and its station's
 * status shows it. The build is read from the default User-Agent until a build
 * sends the headers.
 */

describe('appReport', () => {
  it('takes the version and build from the headers', () => {
    expect(appReport('1.4.0', '202610021640', 'PatrolKit/202610021640 CFNetwork/1498.700.2.2.1 Darwin/23.6.0'))
      .toEqual({ version: '1.4.0', build: '202610021640' });
  });

  it('reads the build from the User-Agent when no header says it', () => {
    expect(appReport(undefined, undefined, 'PatrolKit/202610021640 CFNetwork/1498.700.2.2.1 Darwin/23.6.0'))
      .toEqual({ version: undefined, build: '202610021640' });
  });

  it('ignores anything that is not PatrolKit, too long, or not printable', () => {
    expect(appReport(undefined, undefined, 'ESP32HTTPClient')).toEqual({ version: undefined, build: undefined });
    expect(appReport('x'.repeat(33), 'a b')).toEqual({ version: undefined, build: undefined });
  });

  it('keeps markup as text: the page escapes it, and nothing here interprets it', () => {
    expect(appReport('<script>', undefined)).toEqual({ version: '<script>', build: undefined });
  });
});

describe('recording it', () => {
  function build() {
    const writes: Record<string, unknown>[] = [];
    const prisma = {
      device: {
        findUnique: async () => ({
          id: 'ipad-1', name: 'iPad', role: 'ski_swap.staff_check_in', orgId: 'org-1', org: { name: 'Org', logoUrl: null },
          attendedStation: null, bridgedStations: [], resort: null,
        }),
        update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return {}; },
      },
    };
    const config = { get: () => 'https://patrolkit.io/sell' };
    const unused = {} as never;
    return { svc: new DevicesService(prisma as never, unused, unused, unused, unused, config as never), writes };
  }

  it('stores what the device said', async () => {
    const { svc, writes } = build();
    await svc.getDeviceMe('ipad-1', { version: '1.4.0', build: '202610021640' });
    expect(writes[0]).toMatchObject({ appVersion: '1.4.0', appBuild: '202610021640' });
  });

  it('leaves the last report standing when a request says nothing', async () => {
    const { svc, writes } = build();
    await svc.getDeviceMe('ipad-1', {});
    expect(writes[0]).not.toHaveProperty('appVersion');
    expect(writes[0]).not.toHaveProperty('appBuild');
  });
});
