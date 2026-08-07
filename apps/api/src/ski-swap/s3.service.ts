import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

@Injectable()
export class S3Service {
  private readonly client: S3Client | null;
  private readonly bucket: string;
  private readonly baseUrl: string;

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('app.photoBucket') ?? '';
    this.baseUrl = this.config.get<string>('app.photoBaseUrl') ?? '';
    // Only initialise the client when a bucket is configured
    this.client = this.bucket
      ? new S3Client({ region: this.config.get<string>('app.awsRegion') ?? 'us-east-2' })
      : null;
  }

  get configured(): boolean {
    return !!this.client && !!this.bucket;
  }

  async upload(key: string, buffer: Buffer, contentType: string): Promise<string> {
    if (!this.client) throw new Error('S3 not configured');
    await this.client.send(new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    }));
    return this.baseUrl ? `${this.baseUrl.replace(/\/$/, '')}/${key}` : `https://${this.bucket}.s3.amazonaws.com/${key}`;
  }

  async delete(key: string): Promise<void> {
    if (!this.client || !key) return;
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}
