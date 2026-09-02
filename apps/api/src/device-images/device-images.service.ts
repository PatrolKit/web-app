import { Injectable, NotFoundException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PrismaService } from '../prisma/prisma.service';
import {
  DeviceImageIndexSchema,
  type DeviceImageEntry,
  type DeviceImageDownload,
  type AdminDeviceImage,
} from '../contracts/device-images.contracts';

/**
 * The images somebody flashes onto a card.
 *
 * The bucket is private and stays private. Downloads are presigned per request
 * so the bytes come straight from S3 rather than through this process — a
 * 600 MB image streamed through the API would tie up a worker for the length of
 * somebody's hotel wifi.
 */
@Injectable()
export class DeviceImagesService {
  private readonly log = new Logger(DeviceImagesService.name);
  private readonly client: S3Client | null;
  private readonly bucket: string;

  /** Comfortably longer than a 600 MB download on a bad connection. */
  private static readonly URL_TTL_SEC = 3600;

  /**
   * The index is small and changes only when somebody publishes, but it is
   * fetched per request rather than cached: a stale list after a release is
   * confusing in a way that one extra S3 GET per page view is not.
   */
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.bucket = this.config.get<string>('app.deviceImageBucket') ?? '';
    this.client = this.bucket
      ? new S3Client({ region: this.config.get<string>('app.awsRegion') ?? 'us-east-2' })
      : null;
  }

  get configured(): boolean {
    return !!this.client && !!this.bucket;
  }

  async list(): Promise<DeviceImageEntry[]> {
    if (!this.client) {
      // Not an error: a deployment without the bucket configured should render
      // an empty list and say so, not 500.
      this.log.warn('app.deviceImageBucket is unset; no device images will be listed');
      return [];
    }
    let raw: string;
    try {
      const res = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: 'index.json' }),
      );
      raw = (await res.Body?.transformToString()) ?? '';
    } catch (err) {
      this.log.error(`could not read s3://${this.bucket}/index.json: ${String(err)}`);
      throw new ServiceUnavailableException('The image catalogue is unavailable');
    }

    const parsed = DeviceImageIndexSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      // Publishing wrote something this cannot read. Loud, because the symptom
      // otherwise is a download page that is simply empty.
      this.log.error(`malformed image index: ${parsed.error.message}`);
      throw new ServiceUnavailableException('The image catalogue is malformed');
    }
    return parsed.data.images;
  }

  /**
   * The one image end users are offered, or null.
   *
   * Null when nothing has been promoted, and null when the promoted version is
   * no longer in the catalogue. Both mean "there is nothing to download", which
   * is a truthful and fixable state — quietly falling back to the newest
   * available would hand customers an image nobody chose, which is the whole
   * thing promotion exists to prevent.
   */
  async current(): Promise<DeviceImageEntry | null> {
    const release = await this.prisma.deviceImageRelease.findFirst({
      orderBy: { promotedAt: 'desc' },
    });
    if (!release) return null;
    const found = (await this.list()).find(
      (i) => i.name === release.name && i.version === release.version,
    );
    if (!found) {
      this.log.warn(
        `promoted image ${release.name} ${release.version} is not in the catalogue; ` +
          'offering nothing rather than substituting another version',
      );
      return null;
    }
    return found;
  }

  /** Every published image, marked with which one is promoted. For admins. */
  async listForAdmin(): Promise<AdminDeviceImage[]> {
    const [images, release] = await Promise.all([
      this.list(),
      this.prisma.deviceImageRelease.findFirst({ orderBy: { promotedAt: 'desc' } }),
    ]);
    return images.map(({ key: _key, ...rest }) => ({
      ...rest,
      promoted: !!release && release.name === rest.name && release.version === rest.version,
      promotedAt:
        release && release.name === rest.name && release.version === rest.version
          ? release.promotedAt.toISOString()
          : null,
      promotedBy:
        release && release.name === rest.name && release.version === rest.version
          ? release.promotedBy
          : null,
    }));
  }

  /**
   * Promote one image. Replaces whatever was promoted before.
   *
   * Refuses a version that is not in the catalogue, because the failure would
   * otherwise be silent and land on customers rather than on the person who
   * made it: the download page would simply stop offering anything.
   */
  async promote(name: string, version: string, userId: string): Promise<AdminDeviceImage[]> {
    const exists = (await this.list()).some((i) => i.name === name && i.version === version);
    if (!exists) throw new NotFoundException(`No such image: ${name} ${version}`);

    // One promoted image, platform-wide. Replacing the row rather than adding a
    // flag to every other one keeps "which is current" a single fact.
    await this.prisma.$transaction([
      this.prisma.deviceImageRelease.deleteMany({}),
      this.prisma.deviceImageRelease.create({
        data: { name, version, promotedBy: userId },
      }),
    ]);
    this.log.log(`device image ${name} ${version} promoted by ${userId}`);
    return this.listForAdmin();
  }

  async presign(name: string, version: string): Promise<DeviceImageDownload> {
    if (!this.client) throw new NotFoundException('No image catalogue is configured');

    // Resolved from the index rather than built from the path parameters, so a
    // caller cannot steer the key and read another object out of the bucket.
    const entry = (await this.list()).find((i) => i.name === name && i.version === version);
    if (!entry) throw new NotFoundException(`No such image: ${name} ${version}`);

    const url = await getSignedUrl(
      // pnpm isolates a second copy of the smithy types for the presigner, so
      // this S3Client and the one getSignedUrl expects are structurally
      // identical but nominally distinct — the compiler objects to a private
      // property it cannot see across the two copies. Casting here rather than
      // pinning smithy internals across every AWS client in the repo, which
      // would constrain ses and sns for a problem neither has.
      this.client as unknown as Parameters<typeof getSignedUrl>[0],
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: entry.key,
        // Makes the browser save it under the published name rather than the
        // key's last segment with a query string stuck to it.
        ResponseContentDisposition: `attachment; filename="${entry.filename}"`,
      }),
      { expiresIn: DeviceImagesService.URL_TTL_SEC },
    );

    return {
      url,
      expiresInSec: DeviceImagesService.URL_TTL_SEC,
      filename: entry.filename,
      sha256: entry.sha256,
      sizeBytes: entry.sizeBytes,
    };
  }
}
