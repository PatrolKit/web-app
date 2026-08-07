import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { PrismaService } from '../prisma/prisma.service';
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
import type { PermissionKey } from '../contracts/org.contracts';

@Injectable()
export class DevicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditService: AuditService,
  ) {}

  // ─── Provision ──────────────────────────────────────────────────────────────

  async provision(
    orgId: string,
    actorUserId: string,
    data: ProvisionDeviceRequest,
  ): Promise<ProvisionDeviceResponse> {
    const clientId = createId();
    const clientSecret = randomBytes(32).toString('hex');
    const secretHash = await argon2.hash(clientSecret, { type: argon2.argon2id });

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

    if (data.permissions.length > 0) {
      await this.assignDevicePermissions(device.id, data.permissions as PermissionKey[]);
    }

    await this.auditService.log({
      actorType: 'user',
      actorId: actorUserId,
      orgId,
      action: 'device.provisioned',
      targetType: 'device',
      targetId: device.id,
      metadata: { name: data.name, permissions: data.permissions },
    });

    return {
      id: device.id,
      clientId,
      clientSecret, // returned ONCE, not stored
      name: device.name,
      role: device.role as DeviceRole,
      orgId,
      permissions: data.permissions as PermissionKey[],
      createdAt: device.createdAt,
    };
  }

  // ─── List ────────────────────────────────────────────────────────────────────

  async listDevices(orgId: string): Promise<DeviceListItem[]> {
    const devices = await this.prisma.device.findMany({
      where: { orgId },
      include: { permissions: { include: { permission: true } } },
      orderBy: { createdAt: 'desc' },
    });

    return devices.map((d) => ({
      id: d.id,
      clientId: d.clientId,
      name: d.name,
      role: d.role as DeviceRole,
      orgId: d.orgId,
      permissions: d.permissions.map((dp) => dp.permission.key as PermissionKey),
      lastSeenAt: d.lastSeenAt,
      createdAt: d.createdAt,
    }));
  }

  // ─── Device token ────────────────────────────────────────────────────────────

  async getDeviceToken(clientId: string, clientSecret: string): Promise<DeviceTokenResponse> {
    const device = await this.prisma.device.findUnique({
      where: { clientId },
      include: { permissions: { include: { permission: true } } },
    });

    // Constant-time-ish check: always verify even if not found
    const hash = device?.secretHash ?? '$argon2id$v=19$m=65536,t=3,p=4$placeholder';
    const valid = await argon2.verify(hash, clientSecret).catch(() => false);

    if (!device || !valid) {
      throw new UnauthorizedException('Invalid device credentials');
    }

    const permissions = device.permissions.map((dp) => dp.permission.key);

    const accessToken = await this.jwtService.signDeviceToken({
      sub: clientId,
      deviceId: device.id,
      orgId: device.orgId,
      permissions,
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
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device || device.orgId !== orgId) throw new NotFoundException('Device not found');

    await this.prisma.device.delete({ where: { id: deviceId } });

    await this.auditService.log({
      actorType: 'user', actorId: actorUserId, orgId,
      action: 'device.revoked', targetType: 'device', targetId: deviceId,
    });
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private async assignDevicePermissions(deviceId: string, keys: PermissionKey[]): Promise<void> {
    const perms = await this.prisma.permission.findMany({ where: { key: { in: keys } } });
    await this.prisma.devicePermission.createMany({
      data: perms.map((p) => ({ deviceId, permissionId: p.id })),
      skipDuplicates: true,
    });
  }

  // ─── Device me ───────────────────────────────────────────────────────────────

  async getDeviceMe(deviceId: string): Promise<DeviceMeResponse> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        org: true,
        permissions: { include: { permission: true } },
      },
    });

    if (!device) {
      throw new UnauthorizedException('Device not found');
    }

    await this.prisma.device.update({
      where: { id: deviceId },
      data: { lastSeenAt: new Date() },
    });

    return {
      id: device.id,
      name: device.name,
      role: device.role as DeviceRole,
      orgId: device.orgId,
      orgName: device.org.name,
      permissions: device.permissions.map((dp) => dp.permission.key),
    };
  }

  // ─── Update role ─────────────────────────────────────────────────────────────

  async updateDeviceRole(
    orgId: string,
    deviceId: string,
    role: DeviceRole,
  ): Promise<DeviceListItem> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: { permissions: { include: { permission: true } } },
    });

    if (!device || device.orgId !== orgId) throw new NotFoundException('Device not found');

    const updated = await this.prisma.device.update({
      where: { id: deviceId },
      data: { role },
      include: { permissions: { include: { permission: true } } },
    });

    return {
      id: updated.id,
      clientId: updated.clientId,
      name: updated.name,
      role: updated.role as DeviceRole,
      orgId: updated.orgId,
      permissions: updated.permissions.map((dp) => dp.permission.key as PermissionKey),
      lastSeenAt: updated.lastSeenAt,
      createdAt: updated.createdAt,
    };
  }
}
