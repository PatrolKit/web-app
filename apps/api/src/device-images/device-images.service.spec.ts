import { ServiceUnavailableException, NotFoundException } from '@nestjs/common';
import { DeviceImagesService } from './device-images.service';

/**
 * The failure modes worth pinning are the quiet ones: a catalogue that cannot
 * be read looks exactly like a catalogue with nothing in it, and both render an
 * empty page unless the service distinguishes them.
 */
function serviceWith(index: unknown, bucket = 'patrolkit-images') {
  const config = { get: (k: string) => (k === 'app.deviceImageBucket' ? bucket : 'us-east-2') };
  const svc = new DeviceImagesService(config as never);
  // The S3 client is created in the constructor; replace it rather than reach
  // for the network.
  (svc as unknown as { client: unknown }).client = {
    send: async () => {
      if (index instanceof Error) throw index;
      return { Body: { transformToString: async () => JSON.stringify(index) } };
    },
  };
  return svc;
}

const VALID = {
  images: [
    {
      name: 'patrolkit-device',
      version: '1.0.0',
      key: 'patrolkit-device/1.0.0/image.img.xz',
      filename: 'image.img.xz',
      sha256: 'a'.repeat(64),
      sizeBytes: 617041600,
      gitSha: 'abc1234',
      builtAt: '2026-09-02T13:51:06Z',
      trustedKeys: ['A267DE35610137808C467188B7B81B42B960F4F0'],
      notes: '',
    },
  ],
};

describe('DeviceImagesService', () => {
  it('lists what the publisher wrote', async () => {
    const images = await serviceWith(VALID).list();
    expect(images).toHaveLength(1);
    expect(images[0].version).toBe('1.0.0');
  });

  it('returns nothing, rather than failing, when no bucket is configured', async () => {
    const svc = new DeviceImagesService({ get: () => '' } as never);
    await expect(svc.list()).resolves.toEqual([]);
    expect(svc.configured).toBe(false);
  });

  it('reports a malformed index rather than showing an empty catalogue', async () => {
    // Publishing wrote something unreadable. An empty list here would be
    // indistinguishable from "no images published yet", which is the wrong
    // thing to tell somebody waiting to flash a card.
    await expect(serviceWith({ images: [{ name: 'x' }] }).list())
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('reports an unreachable catalogue rather than an empty one', async () => {
    await expect(serviceWith(new Error('AccessDenied')).list())
      .rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('refuses to presign an image that is not in the index', async () => {
    // The key is resolved from the index, never built from the path, so a
    // caller cannot steer it at another object in the bucket.
    await expect(serviceWith(VALID).presign('patrolkit-device', '9.9.9'))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
