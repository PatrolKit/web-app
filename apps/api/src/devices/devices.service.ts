import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '../auth/jwt.service';
import { AuditService } from '../common/audit/audit.service';
import { createId } from '@paralleldrive/cuid2';
import { randomBytes } from 'crypto';
import type {
  DeviceListItem,
  DeviceMeResponse,
  DeviceRole,
  ProvisionDeviceRequest,
  ProvisionDeviceResponse,
  DeviceTokenResponse,
} from '../contracts/devices.contracts';
import { moduleOfRole } from '../contracts/devices.contracts';
import { PermissionsService } from '../permissions/permissions.service';
import { ModuleAccessService } from '../common/services/module-access.service';

/**
 * What a device's role belongs to: the module that uses it, and the permission
 * that administers it.
 *
 * Hardware belongs to the module that uses it, so the module's own admin
 * authorises it. A single `devices:*` axis would mean a ski-swap admin could
 * provision a time clock, and — as it did — that a ski-swap admin could
 * configure a station while being unable to supply hardware for it.
 *
 * The module key is not the role prefix: a `time_clock.*` device belongs to the
 * `time_tracking` module.
 */
const ROLE_OWNER: Record<string, { moduleKey: string; permission: string }> = {
  ski_swap: { moduleKey: 'ski_swap', permission: 'ski_swap:admin' },
  time_clock: { moduleKey: 'time_tracking', permission: 'time_tracking:manage' },
};

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
    private readonly permissions: PermissionsService,
    private readonly moduleAccess: ModuleAccessService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Refuses unless the caller administers the module this role belongs to *and*
   * the org has that module turned on.
   *
   * Both halves matter. The permission says who; the module says whether this
   * org does that at all. Without the second, an org that switched ski swap off
   * could still be handed bridges through the API — hardware for a module whose
   * every other endpoint refuses the call.
   */
  async assertMayManage(orgId: string, userId: string, role: string): Promise<void> {
    const owner = ROLE_OWNER[moduleOfRole(role as DeviceRole)];
    if (!owner) throw new ForbiddenException('Unknown device role');

    if (!(await this.moduleAccess.isEnabled(orgId, owner.moduleKey))) {
      throw new ForbiddenException(`Module '${owner.moduleKey}' is not enabled`);
    }

    const granted = await this.permissions.getPermissions(userId, orgId);
    if (!granted.includes(owner.permission)) {
      throw new ForbiddenException(`Managing this device requires ${owner.permission}`);
    }
  }

  /** Looks the device up first, then checks the caller against its role. */
  private async assertMayManageDevice(orgId: string, deviceId: string, userId: string): Promise<void> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.orgId !== orgId) throw new NotFoundException('Device not found');
    await this.assertMayManage(orgId, userId, device.role);
  }

  /**
   * The role prefixes a caller may see: modules they administer, that this org
   * actually has on.
   */
  async manageableRoles(orgId: string, userId: string): Promise<string[]> {
    const granted = await this.permissions.getPermissions(userId, orgId);
    const owned = Object.entries(ROLE_OWNER).filter(([, o]) => granted.includes(o.permission));

    const enabled = await Promise.all(
      owned.map(([, o]) => this.moduleAccess.isEnabled(orgId, o.moduleKey)),
    );
    return owned.filter((_, i) => enabled[i]).map(([prefix]) => prefix);
  }

  // ─── Provision ──────────────────────────────────────────────────────────────

  async provision(
    orgId: string,
    actorUserId: string,
    data: ProvisionDeviceRequest,
  ): Promise<ProvisionDeviceResponse> {
    await this.assertMayManage(orgId, actorUserId, data.role);

    const clientId = createId();
    const clientSecret = randomBytes(32).toString('hex');
    const secretHash = await argon2.hash(clientSecret, { type: argon2.argon2id });

    // No code here. A device gets its SKU namespace from the station it is bound
    // to, so an unbound one has none — and a bridge never needs one at all.
    const device = await this.prisma.device.create({
      data: {
        id: createId(),
        orgId,
        name: data.name,
        role: data.role,
        clientId,
        secretHash,
        createdBy: actorUserId,
      },
    });

    await this.auditService.log({
      actorType: 'user',
      actorId: actorUserId,
      orgId,
      action: 'device.provisioned',
      targetType: 'device',
      targetId: device.id,
      metadata: { name: data.name, role: data.role },
    });

    return {
      id: device.id,
      clientId,
      clientSecret, // returned ONCE, not stored
      name: device.name,
      role: device.role as DeviceRole,
      orgId,
      createdAt: device.createdAt,
    };
  }

  // ─── List ────────────────────────────────────────────────────────────────────

  /**
   * Devices the caller administers, which is to say the hardware of the modules
   * they administer. A ski-swap admin has no business seeing time clocks.
   */
  async listDevices(orgId: string, userId: string): Promise<DeviceListItem[]> {
    const modules = await this.manageableRoles(orgId, userId);
    if (modules.length === 0) return [];

    const devices = await this.prisma.device.findMany({
      where: { orgId, OR: modules.map((m) => ({ role: { startsWith: `${m}.` } })) },
      orderBy: { createdAt: 'desc' },
    });

    return devices.map((d) => ({
      id: d.id,
      clientId: d.clientId,
      name: d.name,
      role: d.role as DeviceRole,
      orgId: d.orgId,
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt,
    }));
  }

  // ─── Device token ────────────────────────────────────────────────────────────

  async getDeviceToken(clientId: string, clientSecret: string): Promise<DeviceTokenResponse> {
    const device = await this.prisma.device.findUnique({
      where: { clientId },
    });

    // Constant-time-ish check: always verify even if not found
    const hash = device?.secretHash ?? '$argon2id$v=19$m=65536,t=3,p=4$placeholder';
    const valid = await argon2.verify(hash, clientSecret).catch(() => false);

    if (!device || !valid) {
      throw new UnauthorizedException('Invalid device credentials');
    }

    const accessToken = await this.jwtService.signDeviceToken({
      sub: clientId,
      deviceId: device.id,
      orgId: device.orgId,
      role: device.role,
    });

    await this.prisma.device.update({
      where: { id: device.id },
      data: { lastSeenAt: new Date() },
    });

    return { accessToken, tokenType: 'Bearer' };
  }

  // ─── Rotate secret ───────────────────────────────────────────────────────────

  async rotateSecret(
    orgId: string,
    deviceId: string,
    actorUserId: string,
  ): Promise<{ clientSecret: string }> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.orgId !== orgId) throw new NotFoundException('Device not found');
    await this.assertMayManage(orgId, actorUserId, device.role);

    const newSecret = randomBytes(32).toString('hex');
    const newHash = await argon2.hash(newSecret, { type: argon2.argon2id });

    await this.prisma.device.update({ where: { id: deviceId }, data: { secretHash: newHash } });

    await this.auditService.log({
      actorType: 'user', actorId: actorUserId, orgId,
      action: 'device.secret_rotated', targetType: 'device', targetId: deviceId,
    });

    return { clientSecret: newSecret };
  }

  // ─── Revoke ──────────────────────────────────────────────────────────────────

  async revokeDevice(orgId: string, deviceId: string, actorUserId: string): Promise<void> {
    await this.assertMayManageDevice(orgId, deviceId, actorUserId);
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.orgId !== orgId) throw new NotFoundException('Device not found');

    await this.prisma.device.delete({ where: { id: deviceId } });

    await this.auditService.log({
      actorType: 'user', actorId: actorUserId, orgId,
      action: 'device.revoked', targetType: 'device', targetId: deviceId,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────




  // ─── Device me ───────────────────────────────────────────────────────────────

  async getDeviceMe(deviceId: string): Promise<DeviceMeResponse> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        org: true,
        attendedStation: { select: { id: true, name: true, code: true, deletedAt: true } },
        bridgedStation: { select: { id: true, name: true, code: true, deletedAt: true } },
      },
    });

    if (!device) {
      throw new UnauthorizedException('Device not found');
    }

    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
    });

    // A device is bound through one slot or the other, never both. Which one it
    // is depends on what kind of device it is, and neither caller needs to care.
    const bound = device.attendedStation ?? device.bridgedStation;
    const station = bound && !bound.deletedAt
      ? { id: bound.id, name: bound.name, code: bound.code }
      : null;

    return {
      id: device.id,
      name: device.name,
      role: device.role as DeviceRole,
      orgId: device.orgId,
      orgName: device.org.name,
      /// Null until bound. A client that mints SKUs itself cannot do so without
      /// a station, and should say so rather than failing at the first item.
      station,
      sellerSiteUrl: this.config.get<string>('app.sellerSiteUrl')!,
      orgLogoUrl: device.org.logoUrl ?? null,
    };
  }

  // ─── Update role ─────────────────────────────────────────────────────────────

  async updateDeviceRole(
    orgId: string,
    deviceId: string,
    actorUserId: string,
    role: DeviceRole,
  ): Promise<DeviceListItem> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
    });

    if (!device || device.orgId !== orgId) throw new NotFoundException('Device not found');
    // Both sides: otherwise a ski-swap admin could relabel a time clock into
    // something they administer, and inherit it.
    await this.assertMayManage(orgId, actorUserId, device.role);
    await this.assertMayManage(orgId, actorUserId, role);

    const updated = await this.prisma.device.update({
      where: { id: deviceId },
      data: { role },
    });

    return {
      id: updated.id,
      clientId: updated.clientId,
      name: updated.name,
      role: updated.role as DeviceRole,
      orgId: updated.orgId,
      lastSeenAt: updated.lastSeenAt,
      createdAt: updated.createdAt,
    };
  }
}
