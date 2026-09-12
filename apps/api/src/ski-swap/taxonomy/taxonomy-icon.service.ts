import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import sharp from 'sharp';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../prisma/prisma.service';
import { S3Service } from '../s3.service';

/**
 * The one size stored (Plan 19 §4.4).
 *
 * The only places an icon is drawn are a ~40px chip and a ~20px list row, and a
 * retina chip wants 80. 128 covers both with room, and is small enough — about
 * 10KB — that a deployment without S3 can keep the bytes in a column.
 */
const ICON_PX = 128;

/** Everything `sharp` will take that is plausibly an icon. */
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif'];

@Injectable()
export class TaxonomyIconService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly s3: S3Service,
    private readonly config: ConfigService,
  ) {}

  /**
   * Stores one node's icon.
   *
   * Everything is re-encoded to a 128px PNG, which normalises the size and is
   * also what makes an SVG upload safe: whatever script or external reference it
   * carried does not survive being rasterised.
   *
   * `orgId` null is the platform path, and scoping is the caller's to enforce —
   * the guards on the two controllers already say who may reach which node.
   */
  async upload(
    nodeId: string,
    file: { buffer: Buffer; mimetype: string },
    scope: { orgId: string | null },
  ): Promise<{ iconUrl: string }> {
    if (!ACCEPTED.includes(file.mimetype)) {
      throw new BadRequestException('An icon must be a PNG, JPEG, WebP or SVG');
    }
    const node = await this.findOrThrow(nodeId, scope);

    const png = await sharp(file.buffer)
      .resize(ICON_PX, ICON_PX, { fit: 'inside', withoutEnlargement: false })
      .png()
      .toBuffer()
      .catch(() => {
        throw new BadRequestException('That file could not be read as an image');
      });

    // Keyed by node id alone, so promoting an org node to global carries its
    // image with nothing to copy and nothing to re-point (§8.4).
    const key = `taxonomy-icons/${nodeId}.png`;

    let iconUrl: string;
    let iconS3Key: string | null = null;
    let iconBlob: Buffer | null = null;

    if (this.s3.configured) {
      iconUrl = await this.s3.upload(key, png, 'image/png');
      iconS3Key = key;
    } else {
      // No bucket: the bytes live in the row and the URL points at our own proxy
      // route. Never a data URI — thirteen inlined category images in one tree
      // response would undo the payload discipline §7.2 exists for.
      iconBlob = png;
      iconUrl = this.proxyUrlFor(node.orgId, nodeId);
    }

    await this.prisma.taxonomyNode.update({
      where: { id: nodeId },
      // An uploaded image and a registry key cannot both be set (D11).
      data: { iconUrl, iconS3Key, iconBlob, iconKey: null },
    });
    await this.bump(node.orgId);

    return { iconUrl };
  }

  /** Clears a node's icon, and the object behind it. */
  async remove(nodeId: string, scope: { orgId: string | null }): Promise<void> {
    const node = await this.findOrThrow(nodeId, scope);
    if (node.iconS3Key) await this.s3.delete(node.iconS3Key).catch(() => {});
    await this.prisma.taxonomyNode.update({
      where: { id: nodeId },
      data: { iconUrl: null, iconS3Key: null, iconBlob: null },
    });
    await this.bump(node.orgId);
  }

  /**
   * The bytes, for a deployment with no bucket.
   *
   * Only ever reached through `iconUrl`, and only when that URL is ours. With S3
   * configured nothing calls this — the client fetches the object directly.
   */
  async read(nodeId: string): Promise<Buffer | null> {
    const node = await this.prisma.taxonomyNode.findUnique({
      where: { id: nodeId },
      select: { iconBlob: true, iconS3Key: true },
    });
    if (!node) throw new NotFoundException('Node not found');
    if (node.iconBlob) return Buffer.from(node.iconBlob);
    // Stored in S3 after all — a deployment that gained a bucket between the
    // upload and this read. Serving it beats a 404 the client cannot explain.
    if (node.iconS3Key) return this.s3.download(node.iconS3Key).catch(() => null);
    return null;
  }

  /**
   * Where a blob-backed icon is served from.
   *
   * An org node goes through that org's route so the existing guards apply; a
   * global one through the platform route, which any signed-in user may read
   * because a shared icon is not org data.
   */
  private proxyUrlFor(orgId: string | null, nodeId: string): string {
    // `api/v1` — the global prefix, which this was missing. Only reachable
    // without S3, which is why no deployment had hit the 404 it produced.
    // Absolute for the same reason the registry URLs are: a native client
    // resolves this against a base that already carries the prefix.
    const base = (this.config.get<string>('app.appUrl') ?? '').replace(/\/$/, '');
    return orgId
      ? `${base}/api/v1/orgs/${orgId}/ski-swap/taxonomy/nodes/${nodeId}/icon`
      : `${base}/api/v1/admin/taxonomy/nodes/${nodeId}/icon`;
  }

  private async findOrThrow(nodeId: string, scope: { orgId: string | null }) {
    const node = await this.prisma.taxonomyNode.findFirst({
      where: {
        id: nodeId,
        ...(scope.orgId === null ? { orgId: null } : { orgId: scope.orgId }),
      },
      select: { id: true, orgId: true, iconS3Key: true },
    });
    if (!node) throw new NotFoundException('Node not found');
    return node;
  }

  /** An icon change is a tree change, so the clients' cache key has to move. */
  private async bump(orgId: string | null): Promise<void> {
    if (orgId) {
      await this.prisma.skiSwapSettings.upsert({
        where: { orgId },
        update: { taxonomyVersion: { increment: 1 } },
        create: { orgId, taxonomyVersion: 2 },
      });
    } else {
      await this.prisma.skiSwapSettings.updateMany({
        data: { taxonomyVersion: { increment: 1 } },
      });
    }
  }
}
