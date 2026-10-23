import type { PrismaService } from '../prisma/prisma.service';
import type { DevicePinResponse } from '../contracts/devices.contracts';

/**
 * The org's one tablet PIN (Plan 56 D5), which unlocks settings and the mode
 * on every iPad. Both modules' old PIN routes read and write it too, so an iPad
 * on an older build, asking its module for "the" PIN, gets the same answer.
 */
export async function getTabletPin(prisma: PrismaService, orgId: string): Promise<DevicePinResponse> {
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { tabletPin: true } });
  return { devicePin: org?.tabletPin ?? null };
}

/**
 * `null` removes the gate. Audited, and the value never is: the log is not the
 * place to leak it to readers who were refused the route that returns it.
 */
export async function setTabletPin(
  prisma: PrismaService,
  orgId: string,
  pin: string | null,
  actorId: string,
  ipAddress?: string,
): Promise<DevicePinResponse> {
  const org = await prisma.organization.update({ where: { id: orgId }, data: { tabletPin: pin }, select: { tabletPin: true } });
  await prisma.auditLog.create({
    data: {
      actorType: 'user',
      actorId,
      orgId,
      action: pin === null ? 'org.tablet_pin.cleared' : 'org.tablet_pin.updated',
      ipAddress: ipAddress ?? null,
    },
  });
  return { devicePin: org.tabletPin };
}
