import { SquarePosAdapterFactory } from './square.pos.adapter';

/**
 * Square refunds an item as an order of its own, its return pointing back at
 * the sale's order and line. Each sale line gives back what was returned, so
 * the dashboard, payouts and Sales check don't count a refunded item as sold.
 */

const money = (cents: number) => ({ amount: BigInt(cents), currency: 'USD' });
const sale = (id: string, closedAt: string, lines: { uid: string; variation: string; qty?: number; cents: number }[]) => ({
  id, state: 'COMPLETED', closedAt,
  lineItems: lines.map((l) => ({ uid: l.uid, catalogObjectId: l.variation, quantity: String(l.qty ?? 1), totalMoney: money(l.cents), basePriceMoney: money(l.cents / (l.qty ?? 1)) })),
});
const refund = (id: string, closedAt: string, sourceOrderId: string, lines: { uid: string; qty?: number }[]) => ({
  id, state: 'COMPLETED', closedAt, lineItems: [],
  returns: [{ sourceOrderId, returnLineItems: lines.map((l) => ({ sourceLineItemUid: l.uid, quantity: String(l.qty ?? 1) })) }],
});

type Order = ReturnType<typeof sale> | ReturnType<typeof refund>;

function harness(orders: Order[]) {
  const searches: { startAt: string; endAt: string }[] = [];
  const client = {
    orders: {
      search: async ({ query }: { query: { filter: { dateTimeFilter: { closedAt: { startAt: string; endAt: string } } } } }) => {
        const { startAt, endAt } = query.filter.dateTimeFilter.closedAt;
        searches.push({ startAt, endAt });
        return { orders: orders.filter((o) => o.closedAt >= startAt && o.closedAt < endAt) };
      },
    },
  };
  const adapter = new SquarePosAdapterFactory({ forOrg: async () => client } as never).forOrg('org');
  return { adapter, searches };
}

const FROM = new Date('2026-10-09T00:00:00Z');
const TO = new Date('2099-01-01T00:00:00Z');
const read = async (orders: Order[], to = TO) => (await (await harness(orders).adapter)!.listSales('loc', FROM, to))
  .map((l) => [l.orderId, l.variationId, l.quantity, l.refundedQuantity]);

describe('Square refunds against the sales they refund', () => {
  it('takes a refunded item off its sale (refunded, restocked, not sold again)', async () => {
    expect(await read([
      sale('s1', '2026-10-09T18:12:00Z', [{ uid: 'a', variation: 'v-52618', cents: 4900 }]),
      refund('r1', '2026-10-09T19:45:00Z', 's1', [{ uid: 'a' }]),
    ])).toEqual([['s1', 'v-52618', 1, 1]]);
  });

  it('counts an item refunded and sold again once', async () => {
    expect(await read([
      sale('s1', '2026-10-09T23:50:00Z', [{ uid: 'a', variation: 'v-87950', cents: 38000 }]),
      refund('r1', '2026-10-09T23:52:00Z', 's1', [{ uid: 'a' }]),
      sale('s2', '2026-10-09T23:55:00Z', [{ uid: 'b', variation: 'v-87950', cents: 38000 }]),
    ])).toEqual([['s1', 'v-87950', 1, 1], ['s2', 'v-87950', 1, 0]]);
  });

  it('takes back one of two scanned in one sale, and only from that line', async () => {
    expect(await read([
      sale('s1', '2026-10-09T21:06:00Z', [{ uid: 'a', variation: 'v-74383', qty: 2, cents: 4000 }, { uid: 'b', variation: 'v-1', cents: 1000 }]),
      refund('r1', '2026-10-09T21:08:00Z', 's1', [{ uid: 'a' }]),
    ])).toEqual([['s1', 'v-74383', 2, 1], ['s1', 'v-1', 1, 0]]);
  });

  it('reads a refund made after the window, once, and never more than was sold', async () => {
    const orders = [
      sale('s1', '2026-10-09T18:00:00Z', [{ uid: 'a', variation: 'v-1', cents: 1000 }]),
      refund('r1', '2026-10-09T21:00:00Z', 's1', [{ uid: 'a' }]),
      refund('r2', '2026-10-09T22:00:00Z', 's1', [{ uid: 'a' }]),
    ];
    const h = harness(orders);
    const lines = await (await h.adapter)!.listSales('loc', FROM, new Date('2026-10-09T20:00:00Z'));
    expect(lines.map((l) => l.refundedQuantity)).toEqual([1]);
    expect(h.searches.map((s) => s.startAt)).toEqual(['2026-10-09T00:00:00.000Z', '2026-10-09T20:00:00.000Z']);
  });

  it('leaves a return within the sale’s own order to that order', async () => {
    const own = {
      ...sale('s1', '2026-10-09T18:00:00Z', [{ uid: 'a', variation: 'v-1', cents: 1000 }]),
      returns: [{ sourceOrderId: 's1', returnLineItems: [{ sourceLineItemUid: 'a', quantity: '1' }] }],
    };
    expect(await read([own as Order])).toEqual([['s1', 'v-1', 1, 1]]);
  });
});
