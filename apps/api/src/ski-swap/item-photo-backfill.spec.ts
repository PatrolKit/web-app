import { ItemService } from './item.service';

/**
 * Whether photos taken before an item existed in Square ever reach it.
 *
 * A station check-in defers the Square sync until the seller finishes, so the
 * picture is always taken while `squareItemId` is still null — which is exactly
 * when the upload path skips Square. The item appeared in the catalogue minutes
 * later with no image, and nothing went back for it.
 *
 * Stubbed rather than run against Square: the failure is images landing in a
 * real shop's catalogue, and a test that uploaded some to prove it would be
 * doing the thing it is meant to check.
 */

type Photo = { id: string; s3Key: string; squareImageId: string | null; displayOrder: number };

function harness(photos: Photo[]) {
  const uploaded: { posItemId: string; bytes: string }[] = [];
  const downloaded: string[] = [];
  const saved: { id: string; squareImageId: string }[] = [];
  let nextImage = 0;

  const service = Object.create(ItemService.prototype) as ItemService;

  Object.assign(service, {
    prisma: {
      swapItemPhoto: {
        // Applies the ordering it is given rather than assuming one, so a query
        // that stopped asking for `displayOrder` would fail the order test
        // instead of passing on the array's happenstance order.
        findMany: async ({ orderBy }: { orderBy?: { displayOrder?: 'asc' | 'desc' } }) => {
          const rows = photos.filter((p) => p.squareImageId === null && p.s3Key !== '');
          if (orderBy?.displayOrder === 'asc') rows.sort((a, b) => a.displayOrder - b.displayOrder);
          if (orderBy?.displayOrder === 'desc') rows.sort((a, b) => b.displayOrder - a.displayOrder);
          return rows;
        },
        update: async ({ where, data }: { where: { id: string }; data: { squareImageId: string } }) => {
          saved.push({ id: where.id, squareImageId: data.squareImageId });
        },
      },
    },
    s3: {
      download: async (key: string) => {
        downloaded.push(key);
        return key === 'missing-from-storage' ? null : Buffer.from(`bytes:${key}`);
      },
    },
  });

  const pos = {
    uploadImage: async (posItemId: string, bytes: Buffer) => {
      uploaded.push({ posItemId, bytes: bytes.toString() });
      return { posImageId: `img-${++nextImage}`, imageUrl: '' };
    },
  };

  const run = (itemId: string, posItemId: string) =>
    (
      service as unknown as {
        attachPendingPhotos: (o: string, i: string, p: string, a: unknown) => Promise<void>;
      }
    ).attachPendingPhotos('org-1', itemId, posItemId, pos);

  return { run, uploaded, downloaded, saved };
}

describe('attaching photos once an item reaches Square', () => {
  it('sends up a photo taken before the item existed', async () => {
    const h = harness([{ id: 'p1', s3Key: 'photos/a.jpg', squareImageId: null, displayOrder: 0 }]);

    await h.run('item-1', 'square-item-1');

    expect(h.downloaded).toEqual(['photos/a.jpg']);
    expect(h.uploaded).toEqual([{ posItemId: 'square-item-1', bytes: 'bytes:photos/a.jpg' }]);
    expect(h.saved).toEqual([{ id: 'p1', squareImageId: 'img-1' }]);
  });

  it('leaves a photo Square already has alone', async () => {
    const h = harness([
      { id: 'p1', s3Key: 'photos/a.jpg', squareImageId: 'already-there', displayOrder: 0 },
    ]);

    await h.run('item-1', 'square-item-1');

    // Re-sending would leave the catalogue holding the same picture twice.
    expect(h.uploaded).toEqual([]);
    expect(h.saved).toEqual([]);
  });

  it('keeps the order the seller took them in', async () => {
    const h = harness([
      { id: 'p2', s3Key: 'photos/second.jpg', squareImageId: null, displayOrder: 1 },
      { id: 'p1', s3Key: 'photos/first.jpg', squareImageId: null, displayOrder: 0 },
    ]);

    await h.run('item-1', 'square-item-1');

    expect(h.downloaded).toEqual(['photos/first.jpg', 'photos/second.jpg']);
  });

  it('carries on when one photo cannot be read back', async () => {
    const h = harness([
      { id: 'p1', s3Key: 'missing-from-storage', squareImageId: null, displayOrder: 0 },
      { id: 'p2', s3Key: 'photos/b.jpg', squareImageId: null, displayOrder: 1 },
    ]);

    await h.run('item-1', 'square-item-1');

    // The readable one still gets there, and the unreadable one is not recorded
    // as sent — so a later sync will try it again.
    expect(h.uploaded).toEqual([{ posItemId: 'square-item-1', bytes: 'bytes:photos/b.jpg' }]);
    expect(h.saved).toEqual([{ id: 'p2', squareImageId: 'img-1' }]);
  });

  it('does nothing when there is nothing pending', async () => {
    const h = harness([]);

    await h.run('item-1', 'square-item-1');

    expect(h.downloaded).toEqual([]);
    expect(h.uploaded).toEqual([]);
  });
});
