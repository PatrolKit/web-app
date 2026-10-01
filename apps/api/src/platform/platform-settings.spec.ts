import { GUARDS_METADATA } from '@nestjs/common/constants';
import { PlatformSettingsService } from './platform-settings.service';
import { PlatformSettingsController, PublicFeaturesController } from './platform-settings.controller';
import { SuperAdminGuard } from '../common/guards/super-admin.guard';

/** The platform switch (Plan 29). */

function build(row: { smsEnabled: boolean; updatedAt: Date; updatedById: string | null } | null) {
  let stored = row;
  const prisma = {
    platformSettings: {
      findUnique: jest.fn(async () => stored),
      upsert: async ({ update }: { update: { smsEnabled: boolean; updatedById: string } }) => {
        stored = { ...update, updatedAt: new Date() };
        return stored;
      },
    },
    user: { findUnique: async () => ({ firstName: 'Chris', lastName: 'A', email: null, phone: null }) },
  };
  const config = { get: (k: string, d?: unknown) => ({ 'app.snsOriginationNumber': '+18449442760' })[k] ?? d };
  return { svc: new PlatformSettingsService(prisma as never, config as never), prisma };
}

describe('platform settings', () => {
  it('reads as off when nobody has said otherwise', async () => {
    await expect(build(null).svc.smsEnabled()).resolves.toBe(false);
    await expect(build({ smsEnabled: false, updatedAt: new Date(), updatedById: null }).svc.smsEnabled()).resolves.toBe(false);
  });

  it('is read once, and a change is seen at once without a restart', async () => {
    const { svc, prisma } = build({ smsEnabled: false, updatedAt: new Date(), updatedById: null });
    await svc.smsEnabled();
    await svc.smsEnabled();
    expect(prisma.platformSettings.findUnique).toHaveBeenCalledTimes(1);
    await svc.update({ smsEnabled: true }, 'u1');
    await expect(svc.smsEnabled()).resolves.toBe(true);
  });

  it('says whether texts would leave, never the number', async () => {
    const { svc } = build(null);
    await svc.update({ smsEnabled: true }, 'u1');
    const described = await svc.describe();
    expect(described).toMatchObject({
      smsEnabled: true, updatedBy: 'Chris A',
      smsReadiness: { originationNumber: true, outboundNotifications: false },
    });
    expect(JSON.stringify(described)).not.toContain('8449442760');
  });

  it('is changed by super admins only, and read by anyone as { sms } alone', async () => {
    expect(Reflect.getMetadata(GUARDS_METADATA, PlatformSettingsController)).toContain(SuperAdminGuard);
    expect(Reflect.getMetadata(GUARDS_METADATA, PublicFeaturesController)).toBeUndefined();
    const { svc } = build(null);
    await expect(new PublicFeaturesController(svc).get()).resolves.toEqual({ sms: false });
  });
});
