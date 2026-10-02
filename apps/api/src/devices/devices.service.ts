import { BRIDGED_STATIONS_SELECT, bridgedStationNames } from '../ski-swap/bridge-stations.util';
import {
  BadRequestException,
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
} from '../contracts/devices.contracts';
import { moduleOfRole } from '../contracts/devices.contracts';
import { PermissionsService } from '../permissions/permissions.service';
import { BRIDGE_ONLINE_MS } from '../ski-swap/print-queue.service';
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
  // `manage` rather than `admin`, following time tracking: whoever runs the
  // displays supplies the hardware for them. A separate `signage:admin` gate
  // would mean the person who publishes to a screen cannot provision one.
  signage: { moduleKey: 'signage', permission: 'signage:manage' },
};

/**
 * The roles that stand somewhere, and whether a resort is required to provision
 * one.
 *
 * A time-clock tablet may sit unbound — that is how one is taken out of service
 * without being revoked, and an unbound terminal says so and boards nothing. A
 * display cannot: it has no state to refuse from, so an unbound one is a dark
 * screen, which is indistinguishable from a broken one.
 */
const RESORT_BOUND: Record<string, { required: boolean }> = {
  'time_clock.terminal': { required: false },
  'signage.display': { required: true },
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
    if (data.resortId !== undefined) {
      await this.assertResortBindable(orgId, data.role, data.resortId);
    } else if (RESORT_BOUND[data.role]?.required) {
      throw new BadRequestException('This device must be given a resort before it is provisioned');
    }

    const clientId = createId();
    const clientSecret = randomBytes(32).toString('hex');
    const secretHash = await argon2.hash(clientSecret, { type: argon2.argon2id });

    // No code here. A device gets its SKU namespace from the station it is bound
    // to, so an unbound one has none — and a bridge never needs one at all.
    const device = await this.prisma.device.create({
      data: {
        id: createId(),
        orgId,
        // A bridge is named after its printer, chosen later, so it stores a
        // constant that nothing renders rather than an empty string.
        name: data.name ?? 'Print bridge',
        role: data.role,
        clientId,
        secretHash,
        createdBy: actorUserId,
        resortId: data.resortId ?? null,
      },
    });

    await this.auditService.log({
      actorType: 'user',
      actorId: actorUserId,
      orgId,
      action: 'device.provisioned',
      targetType: 'device',
      targetId: device.id,
      metadata: { name: data.name ?? null, role: data.role },
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
      include: { bridgedPrinter: true, bridgedStations: BRIDGED_STATIONS_SELECT, resort: true },
    });

    return devices.map((d) => ({
      id: d.id,
      clientId: d.clientId,
      name: d.name,
      role: d.role as DeviceRole,
      orgId: d.orgId,
      lastSeenAt: d.lastSeenAt,
      printerLink: (d.printerLink as 'ready' | 'down' | null) ?? null,
      printerLinkAt: d.printerLinkAt,
      printerName: d.bridgedPrinter?.name ?? null,
      ...bridgedStationNames(d.bridgedStations),
      // A retired resort reads as unbound, the same way a retired station does.
      resortId: d.resort && !d.resort.deletedAt ? d.resort.id : null,
      resortName: d.resort && !d.resort.deletedAt ? d.resort.name : null,
      hardwareId: d.hardwareId,
      imageName: d.imageName,
      imageVersion: d.imageVersion,
      installedPackages: d.installedPackages,
      bootstrapAt: d.bootstrapAt,
      createdAt: d.createdAt,
    }));
  }

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

  // ─── Resort binding ──────────────────────────────────────────────────────────

  /**
   * Where a device stands, set by whoever administers that module's hardware.
   *
   * Passing null unbinds it, which is how a tablet is taken out of service
   * without being revoked — it keeps its credentials and stops being anywhere.
   * A display can be unbound the same way; it simply has nothing to show until
   * it is placed again.
   */
  async bindResort(
    orgId: string,
    actorUserId: string,
    deviceId: string,
    resortId: string | null,
  ): Promise<DeviceListItem> {
    const device = await this.prisma.device.findFirst({ where: { id: deviceId, orgId } });
    if (!device) throw new NotFoundException('Device not found');

    await this.assertMayManage(orgId, actorUserId, device.role as DeviceRole);
    if (resortId !== null) {
      await this.assertResortBindable(orgId, device.role as DeviceRole, resortId);
    }

    await this.prisma.device.update({ where: { id: deviceId }, data: { resortId } });

    await this.auditService.log({
      actorType: 'user',
      actorId: actorUserId,
      orgId,
      action: resortId ? 'device.resort_bound' : 'device.resort_unbound',
      targetType: 'device',
      targetId: deviceId,
      metadata: { resortId },
    });

    const [updated] = await this.listDevices(orgId, actorUserId).then((all) =>
      all.filter((d) => d.id === deviceId),
    );
    return updated;
  }

  /**
   * A terminal rebinding itself, having been carried to another lodge.
   *
   * Rebinding is wanted exactly when a computer is least available — someone is
   * holding the iPad, in the building it just moved to. The device names a
   * resort in its own org and nothing else: it cannot reach another org's, a
   * retired one, or any device but itself.
   */
  async rebindSelf(deviceId: string, resortId: string): Promise<DeviceMeResponse> {
    const device = await this.prisma.device.findUnique({ where: { id: deviceId } });
    if (!device) throw new UnauthorizedException('Device not found');

    await this.assertResortBindable(device.orgId, device.role as DeviceRole, resortId);
    await this.prisma.device.update({ where: { id: deviceId }, data: { resortId } });

    await this.auditService.log({
      actorType: 'device',
      actorId: deviceId,
      orgId: device.orgId,
      action: 'device.resort_rebound',
      targetType: 'device',
      targetId: deviceId,
      metadata: { resortId },
    });

    return this.getDeviceMe(deviceId);
  }

  /**
   * The one rule every write path shares: a resort binding belongs to a device
   * that stands somewhere, and names a live resort in the device's own org.
   *
   * Checked rather than merely documented — unlike `printerLink`, which no
   * endpoint sets directly — because every caller here is a write, and a
   * binding on a print bridge would be a field nothing reads and nobody can see
   * to correct.
   */
  private async assertResortBindable(
    orgId: string,
    role: DeviceRole,
    resortId: string,
  ): Promise<void> {
    if (!RESORT_BOUND[role]) {
      throw new BadRequestException('This kind of device does not stand at a resort');
    }
    const resort = await this.prisma.resort.findFirst({
      where: { id: resortId, orgId, deletedAt: null },
      select: { id: true },
    });
    if (!resort) throw new NotFoundException('Resort not found');
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────




  // ─── Device me ───────────────────────────────────────────────────────────────

  async getDeviceMe(deviceId: string): Promise<DeviceMeResponse> {
    const device = await this.prisma.device.findUnique({
      where: { id: deviceId },
      include: {
        org: true,
        attendedStation: { select: { id: true, name: true, code: true, deletedAt: true, bridgeDeviceId: true } },
        bridgedStations: BRIDGED_STATIONS_SELECT,
        resort: { select: { id: true, name: true, timeZone: true, deletedAt: true } },
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
    // A bridge may serve several staffed stations (Plan 27); `station` is then
    // the first by name, and `stations` has them all.
    const stations = (
      device.attendedStation && !device.attendedStation.deletedAt ? [device.attendedStation] : device.bridgedStations
    ).map((s) => ({ id: s.id, name: s.name, code: s.code }));
    const first = stations[0] ?? null;

    // The bridge a tablet's station prints through (Plan 28), so the iPad can
    // tell whether to ask it for helper labels without asking and being told
    // NO_BRIDGE. A bridge's own station names the bridge itself.
    const bridgeId = device.attendedStation && !device.attendedStation.deletedAt
      ? device.attendedStation.bridgeDeviceId
      : first ? device.id : null;
    const bridge = bridgeId
      ? await this.prisma.device.findUnique({
          where: { id: bridgeId },
          select: {
            id: true, name: true, lastSeenAt: true, printerLink: true,
            bridgedPrinter: { select: { id: true, model: true, paperSize: true } },
          },
        })
      : null;
    const station = first && {
      ...first,
      printBridge: bridge
        ? {
            deviceId: bridge.id,
            name: bridge.name,
            online: !!bridge.lastSeenAt && Date.now() - bridge.lastSeenAt.getTime() <= BRIDGE_ONLINE_MS,
            lastSeenAt: bridge.lastSeenAt?.toISOString() ?? null,
            printer: bridge.bridgedPrinter
              ? { ...bridge.bridgedPrinter, ready: bridge.printerLink === 'ready' }
              : null,
          }
        : null,
    };

    return {
      id: device.id,
      name: device.name,
      role: device.role as DeviceRole,
      orgId: device.orgId,
      orgName: device.org.name,
      /// Null until bound. A client that mints SKUs itself cannot do so without
      /// a station, and should say so rather than failing at the first item.
      station,
      stations,
      /**
       * Null until someone places it. A retired resort reads as unbound rather
       * than as a name nobody can act on — the tablet is genuinely somewhere
       * the org no longer patrols, and should say so.
       */
      resort: device.resort && !device.resort.deletedAt
        ? {
            id: device.resort.id,
            name: device.resort.name,
            timeZone: device.resort.timeZone,
          }
        : null,
      sellerSiteUrl: this.config.get<string>('app.sellerSiteUrl')!,
      orgLogoUrl: device.org.logoUrl ?? null,
    };
  }
}
