import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { BootstrapService, canonicalJson, etagFor } from './bootstrap.service';
import { BootstrapManifestSchema } from '../contracts/bootstrap.contracts';

/**
 * Assembling the manifest a fleet acts on.
 *
 * The device validates what it receives and **discards a manifest that fails**,
 * keeping the previous one — so a manifest this server is happy with and the
 * device is not produces no error anyone sees. It produces devices that quietly
 * stop taking updates. Hence the schema assertion in every happy path here.
 */

const REPO = {
  id: 'repo-1',
  name: 'patrolkit',
  uri: 'https://apt.patrolkit.io',
  suite: 'trixie',
  components: 'main',
  arch: 'arm64',
  signedByKeyId: 'A267DE35610137808C467188B7B81B42B960F4F0',
  pinPriority: null as number | null,
};

type Pkg = {
  id: string;
  name: string;
  version: string | null;
  resolvedVersion: string | null;
  resolvedAt: Date | null;
  position: number;
};

function profile(packages: Pkg[], overrides: Record<string, unknown> = {}) {
  return {
    id: 'prof-1',
    role: 'signage.display',
    deviceType: 'patrolkit-signage',
    enabled: true,
    updateEnabled: true,
    updateWindow: '03:00-05:00',
    checkinIntervalSec: 3600,
    manifestVersion: 7,
    repositories: [REPO],
    packages,
    ...overrides,
  };
}

/** Enough Prisma to answer the lookups, and a record of what was written. */
function stub(row: ReturnType<typeof profile> | null, newest: string | null = null) {
  const writes: { id: string; resolvedVersion: string }[] = [];
  const prisma = {
    bootstrapProfile: { findUnique: async () => row },
    bootstrapPackage: {
      update: async ({ where, data }: { where: { id: string }; data: { resolvedVersion: string } }) => {
        writes.push({ id: where.id, resolvedVersion: data.resolvedVersion });
        return data;
      },
    },
    device: { update: async () => undefined },
  };
  const aptIndex = { newestVersionOf: async () => newest };
  return {
    writes,
    service: new BootstrapService(prisma as never, aptIndex as never),
  };
}

const PINNED: Pkg = {
  id: 'pkg-1', name: 'patrolkit-signage', version: '1.4.2',
  resolvedVersion: null, resolvedAt: null, position: 0,
};
const TRACKING: Pkg = {
  id: 'pkg-2', name: 'patrolkit-signage', version: null,
  resolvedVersion: null, resolvedAt: null, position: 0,
};

describe('the manifest a device is served', () => {
  it('is one the device will accept', async () => {
    const { service } = stub(profile([PINNED]));
    const { manifest } = await service.manifestForRole('signage.display');

    expect(BootstrapManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest).toMatchObject({
      manifestVersion: 7,
      deviceType: 'patrolkit-signage',
      packages: [{ name: 'patrolkit-signage', version: '1.4.2' }],
      updatePolicy: { enabled: true, window: '03:00-05:00' },
      checkinIntervalSec: 3600,
    });
    expect(manifest.repositories[0].components).toEqual(['main']);
  });

  it('omits pinPriority rather than sending null, which the device would reject', async () => {
    const { service } = stub(profile([PINNED]));
    const { manifest } = await service.manifestForRole('signage.display');
    expect('pinPriority' in manifest.repositories[0]).toBe(false);
  });

  it('omits the window when none is set, rather than sending an empty one', async () => {
    const { service } = stub(profile([PINNED], { updateWindow: null }));
    const { manifest } = await service.manifestForRole('signage.display');

    expect(manifest.updatePolicy).toEqual({ enabled: true });
    expect(BootstrapManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('is a 404 for a role nobody has configured', async () => {
    const { service } = stub(null);
    await expect(service.manifestForRole('signage.display')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('is a 404 for a profile that has been switched off', async () => {
    // Off rather than deleted keeps the configuration; a device answers the 404
    // by keeping the manifest it already holds.
    const { service } = stub(profile([PINNED], { enabled: false }));
    await expect(service.manifestForRole('signage.display')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('a package that tracks the newest build', () => {
  it('resolves from the repository index and remembers what it found', async () => {
    const { service, writes } = stub(profile([TRACKING]), '1.5.0');
    const { manifest } = await service.manifestForRole('signage.display');

    expect(manifest.packages).toEqual([{ name: 'patrolkit-signage', version: '1.5.0' }]);
    expect(writes).toEqual([{ id: 'pkg-2', resolvedVersion: '1.5.0' }]);
  });

  it('falls back to what it last resolved when the index is unreachable', async () => {
    const cached = { ...TRACKING, resolvedVersion: '1.4.2', resolvedAt: new Date() };
    const { service, writes } = stub(profile([cached]), null);
    const { manifest } = await service.manifestForRole('signage.display');

    expect(manifest.packages).toEqual([{ name: 'patrolkit-signage', version: '1.4.2' }]);
    // Nothing new was learned, so nothing is written.
    expect(writes).toEqual([]);
  });

  it('fails the whole request rather than serving a manifest without it', async () => {
    // A manifest missing a package installs nothing and uninstalls nothing, and
    // looks exactly like success. Refusing is the only honest answer.
    const { service } = stub(profile([TRACKING]), null);
    await expect(service.manifestForRole('signage.display')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not rewrite a resolution it already holds and just checked', async () => {
    const fresh = { ...TRACKING, resolvedVersion: '1.5.0', resolvedAt: new Date() };
    const { service, writes } = stub(profile([fresh]), '1.5.0');
    await service.manifestForRole('signage.display');
    expect(writes).toEqual([]);
  });

  it('refreshes a stale resolution even when the answer has not changed', async () => {
    const stale = {
      ...TRACKING,
      resolvedVersion: '1.5.0',
      resolvedAt: new Date(Date.now() - 60 * 60_000),
    };
    const { service, writes } = stub(profile([stale]), '1.5.0');
    await service.manifestForRole('signage.display');
    expect(writes).toEqual([{ id: 'pkg-2', resolvedVersion: '1.5.0' }]);
  });
});

describe('the ETag', () => {
  it('is stable across runs for identical content', async () => {
    const a = await stub(profile([PINNED])).service.manifestForRole('signage.display');
    const b = await stub(profile([PINNED])).service.manifestForRole('signage.display');
    expect(a.etag).toBe(b.etag);
    expect(a.etag).toMatch(/^"[0-9a-f]{16}"$/);
  });

  it('moves when a pinned version is edited', async () => {
    const before = await stub(profile([PINNED])).service.manifestForRole('signage.display');
    const after = await stub(
      profile([{ ...PINNED, version: '1.4.3' }]),
    ).service.manifestForRole('signage.display');
    expect(after.etag).not.toBe(before.etag);
  });

  it('moves when a tracked package resolves anew, with no edit behind it', async () => {
    // The reason the ETag covers the resolved manifest and `manifestVersion`
    // does not: publishing a .deb changes what is served without anybody
    // touching the profile.
    const before = await stub(profile([TRACKING]), '1.4.2').service.manifestForRole('signage.display');
    const after = await stub(profile([TRACKING]), '1.5.0').service.manifestForRole('signage.display');
    expect(after.etag).not.toBe(before.etag);
  });
});

describe('canonicalJson', () => {
  it('sorts keys so equal manifests hash equally', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('drops undefined rather than emitting it', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('produces an etag for the shape the device is served', () => {
    const manifest = {
      manifestVersion: 1,
      deviceType: 'patrolkit-signage',
      repositories: [
        {
          name: 'patrolkit', uri: 'https://apt.patrolkit.io', suite: 'trixie',
          components: ['main'], arch: 'arm64' as const, signedByKeyId: 'A267DE35',
        },
      ],
      packages: [{ name: 'app', version: '1.0.0' }],
      checkinIntervalSec: 3600,
    };
    expect(etagFor(manifest)).toMatch(/^"[0-9a-f]{16}"$/);
  });
});
