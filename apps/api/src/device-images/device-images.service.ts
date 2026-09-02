import { Injectable, NotFoundException, ServiceUnavailableException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  DeviceImageIndexSchema,
  type DeviceImageEntry,
  type DeviceImageDownload,
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
  constructor(private readonly config: ConfigService) {
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
