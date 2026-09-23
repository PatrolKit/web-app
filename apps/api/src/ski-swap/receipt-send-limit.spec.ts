import { ReceiptService } from './receipt.service';

/**
 * A seller's own receipt sends are limited per destination (Plan 26 §6): at
 * most 3 an hour to one address or number, counting only sends nobody pressed
 * on the seller's behalf.
 *
 * `send` does a great deal before it gets here, none of it about limits, so
 * this reaches the check directly.
 */
function build(deliveries: { destination: string; actorUserId: string | null; createdAt: Date }[]) {
  const where: unknown[] = [];
  const prisma = {
    receiptDelivery: {
      count: async (args: { where: { destination: string; actorUserId: null; createdAt: { gte: Date } } }) => {
        where.push(args.where);
        return deliveries.filter((d) =>
          d.destination === args.where.destination &&
          d.actorUserId === args.where.actorUserId &&
          d.createdAt >= args.where.createdAt.gte).length;
      },
    },
  };
  const usage = { record: jest.fn() };
  const svc = new ReceiptService(prisma as never, {} as never, {} as never, {} as never, {} as never, usage as never);
  const check = (destination: string) =>
    (svc as unknown as { assertDestinationNotLimited: (d: string, s: string) => Promise<void> })
      .assertDestinationNotLimited(destination, 'swap-1');
  return { check, usage, where };
}

const now = () => new Date();
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

describe('receipts a seller sends themselves', () => {
  it('allows the third to one destination in an hour and refuses the fourth', async () => {
    const two = Array.from({ length: 2 }, () => ({ destination: 'a@b.com', actorUserId: null, createdAt: now() }));
    await expect(build(two).check('a@b.com')).resolves.toBeUndefined();

    const three = [...two, { destination: 'a@b.com', actorUserId: null, createdAt: now() }];
    await expect(build(three).check('a@b.com')).rejects.toMatchObject({
      status: 429,
      response: { code: 'TOO_MANY_RECEIPTS' },
    });
  });

  it('does not count what staff sent, or what went elsewhere, or last hour', async () => {
    const { check } = build([
      { destination: 'a@b.com', actorUserId: 'staff-1', createdAt: now() },
      { destination: 'a@b.com', actorUserId: 'staff-1', createdAt: now() },
      { destination: 'other@b.com', actorUserId: null, createdAt: now() },
      { destination: 'a@b.com', actorUserId: null, createdAt: ago(61) },
      { destination: 'a@b.com', actorUserId: null, createdAt: ago(61) },
      { destination: 'a@b.com', actorUserId: null, createdAt: now() },
    ]);
    await expect(check('a@b.com')).resolves.toBeUndefined();
  });

  it('reports the count to the health record, without the destination', async () => {
    const { check, usage } = build([{ destination: 'a@b.com', actorUserId: null, createdAt: now() }]);
    await check('a@b.com');
    expect(usage.record).toHaveBeenCalledWith(
      expect.objectContaining({ limitId: 'receipts.perDestination', hits: 2, refused: false }),
    );
    expect(JSON.stringify(usage.record.mock.calls)).not.toContain('a@b.com');
  });
});
