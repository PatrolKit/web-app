import { claimForSquareCreate, releaseSquareCreateClaim } from './square-create-claim';
import { claimRead, claimUpdate } from './__fixtures__/claim-fake';

/**
 * Plan 47: one path creates an item in Square, never two. On 2026-10-09 an
 * iPad's ticket sync and a batch push both created tickets 74819–74822, a
 * second apart, and each ticket ended up in Square twice.
 */

type Row = Record<string, unknown> & { id: string };

function db(rows: Row[]) {
  return {
    swapItem: {
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => claimUpdate(rows, where, data as Record<string, unknown>),
      findMany: async ({ where }: { where: Record<string, unknown> }) => claimRead(rows, where),
    },
  };
}

const item = (id: string, over: Partial<Row> = {}): Row => ({ id, squareItemId: null, deletedAt: null, squareCreateClaim: null, squareCreateClaimedAt: null, ...over });

describe('claiming items before creating them in Square', () => {
  it('gives an item to one of two paths claiming it at once, never both', async () => {
    const rows = [item('t74820')];
    const [a, b] = await Promise.all([claimForSquareCreate(db(rows) as never, ['t74820']), claimForSquareCreate(db(rows) as never, ['t74820'])]);
    expect([...a.ids, ...b.ids]).toEqual(['t74820']);
  });

  it('skips an item already in Square, withdrawn, or held by a live claim', async () => {
    const rows = [
      item('in-square', { squareItemId: 'sq-1' }),
      item('withdrawn', { deletedAt: new Date() }),
      item('held', { squareCreateClaim: 'other', squareCreateClaimedAt: new Date() }),
      item('free'),
    ];
    const claim = await claimForSquareCreate(db(rows) as never, rows.map((r) => r.id));
    expect(claim.ids).toEqual(['free']);
  });

  it('takes over a claim abandoned more than two minutes ago', async () => {
    const rows = [item('t1', { squareCreateClaim: 'crashed', squareCreateClaimedAt: new Date(Date.now() - 3 * 60 * 1000) })];
    expect((await claimForSquareCreate(db(rows) as never, ['t1'])).ids).toEqual(['t1']);
  });

  it('frees what it held on release, and only that', async () => {
    const rows = [item('mine'), item('theirs', { squareCreateClaim: 'other', squareCreateClaimedAt: new Date() })];
    const claim = await claimForSquareCreate(db(rows) as never, ['mine', 'theirs']);
    await releaseSquareCreateClaim(db(rows) as never, claim);
    expect(rows.map((r) => r.squareCreateClaim)).toEqual([null, 'other']);
    expect((await claimForSquareCreate(db(rows) as never, ['mine'])).ids).toEqual(['mine']);
  });
});
