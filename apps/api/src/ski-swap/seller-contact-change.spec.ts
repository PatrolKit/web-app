import { SellerService } from './seller.service';

/**
 * Staff correcting a seller's email or phone unverifies it. Receipts and
 * payouts go only to a proven address, so they stop going to the old one, and
 * a payout already pointed at that contact is left for the run to flag rather
 * than refusing the correction.
 */
describe('a seller’s contact changed by staff', () => {
  function build(user: Record<string, unknown>) {
    const writes: Record<string, unknown>[] = [];
    const prisma = {
      user: {
        findUniqueOrThrow: async () => user,
        update: async ({ data }: { data: Record<string, unknown> }) => { writes.push(data); return {}; },
      },
    };
    const touch = { touchAllForUser: async () => undefined };
    const svc = new SellerService(prisma as never, {} as never, {} as never, touch as never, {} as never);
    const write = (data: Record<string, unknown>) =>
      (svc as unknown as { writeUserFields: (id: string, d: object, o: object) => Promise<void> })
        .writeUserFields('user-1', data, { overwrite: true });
    return { write, writes };
  }

  const dana = {
    firstName: 'Dana', lastName: 'Reyes', street: null, city: null, state: null, zip: null,
    email: 'dana@example.com', emailVerifiedAt: new Date(), verifiedEmail: 'dana@example.com',
    phone: null, phoneVerifiedAt: null, verifiedPhone: null,
    payoutMethod: 'PAYPAL', payoutTarget: 'EMAIL', payoutHandle: null,
  };

  it('unverifies the email in the same write', async () => {
    const { write, writes } = build(dana);
    await write({ email: 'Dana@New.example' });
    expect(writes).toEqual([{ email: 'dana@new.example', emailVerifiedAt: null, verifiedEmail: null }]);
  });

  it('isn’t refused for a PayPal payout already pointed at that email', async () => {
    const { write } = build(dana);
    await expect(write({ email: 'dana@new.example' })).resolves.toBeUndefined();
  });

  it('can’t point a payout at the new, unproven email in the same breath', async () => {
    const { write } = build({ ...dana, payoutMethod: null, payoutTarget: null });
    await expect(write({ email: 'dana@new.example', payoutMethod: 'PAYPAL', payoutTarget: 'EMAIL' }))
      .rejects.toThrow(/not been verified/);
  });

  it('leaves a verification alone when the email doesn’t change', async () => {
    const { write, writes } = build(dana);
    await write({ firstName: 'Danielle', email: 'dana@example.com' });
    expect(writes[0]).not.toHaveProperty('verifiedEmail');
  });
});
