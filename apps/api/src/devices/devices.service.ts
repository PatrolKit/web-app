import {
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import * as argon2 from 'argon2';
import { Prisma } from '@prisma/client';
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

    const { device } = await this.prisma.$transaction(async (tx) => {
      const skiSwapDeviceCode = await this.assignSkiSwapDeviceCode(orgId, tx);
      const device = await tx.device.create({
        data: {
          id: createId(),
          orgId,
          name: data.name,
          role: data.role,
          clientId,
          secretHash,
          createdBy: actorUserId,
          skiSwapDeviceCode,
        },
      });
      return { device };
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

  async listDevices(orgId: string): Promise<DeviceListItem[]> {
    const devices = await this.prisma.device.findMany({
      where: { orgId },
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

  private async assignSkiSwapDeviceCode(
    orgId: string,
    tx: Prisma.TransactionClient,
  ): Promise<string> {
    const devices = await tx.device.findMany({
      where: { orgId },
      select: { skiSwapDeviceCode: true },
    });
    const existing = new Set(
      devices.map((d) => d.skiSwapDeviceCode).filter((c): c is string => c !== null),
    );
    let n = 1;
    while (true) {
      const code = this.generateSkiSwapCode(n);
      if (!existing.has(code)) return code;
      n++;
    }
  }

  private generateSkiSwapCode(n: number): string {
    let code = '';
    let remainder = n;
    while (remainder > 0) {
      code = String.fromCharCode(((remainder - 1) % 26) + 65) + code;
      remainder = Math.floor((remainder - 1) / 26);
    }
    return code;
  }


  // ─── Device me ───────────────────────────────────────────────────────────────

  async getDeviceMe(deviceId: string): Promise<DeviceMeResponse> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        org: true,
      },
    });

    if (!device) {
      throw new UnauthorizedException('Device not found');
    }

    let { skiSwapDeviceCode } = device;

    await this.prisma.$transaction(async (tx) => {
      if (!skiSwapDeviceCode) {
        skiSwapDeviceCode = await this.assignSkiSwapDeviceCode(device.orgId, tx);
        await tx.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date(), skiSwapDeviceCode } });
      } else {
        await tx.device.update({ where: { id: deviceId }, data: { lastSeenAt: new Date() } });
      }
    });

    return {
      id: device.id,
      name: device.name,
      role: device.role as DeviceRole,
      orgId: device.orgId,
      orgName: device.org.name,
      skiSwapDeviceCode,
      sellerSiteUrl: process.env.SELLER_SITE_URL ?? 'https://skiswap.patrolkit.io',
      orgLogoUrl: device.org.logoUrl ?? null,
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
    });

    if (!device || device.orgId !== orgId) throw new NotFoundException('Device not found');

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
