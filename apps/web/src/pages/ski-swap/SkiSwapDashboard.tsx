import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api } from '../../lib/api';
import { payoutGaps } from '@patrolkit/contracts/payout-gaps';
import type { SkiSwapContext } from './SkiSwapLayout';

/** How many unpayable sellers the card names before linking to the rest. */
const NAMED_SELLERS = 5;

const issueCard = 'block bg-amber-900/30 border border-amber-800 rounded-lg p-4';

function StatTile({ label, value, note }: { label: string; value: string | number; note?: string }) {
  return (
    <div className="bg-surface-50 border border-gray-800 rounded-lg p-4">
      <p className="text-gray-400 text-xs uppercase tracking-wide mb-1">{label}</p>
      <p className="text-2xl font-bold text-white">{value}</p>
      {note && <p className="text-xs text-gray-500 mt-0.5">{note}</p>}
    </div>
  );
}

const dollars = (cents: number) => `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function SkiSwapDashboard() {
  const { orgId, selectedSwap, perms, requireConsignmentScan } = useOutletContext<SkiSwapContext>();
  // Fixing a seller or pricing a ticket is staff's; a viewer gets the list.
  const canManage = perms.has('ski_swap:manage');

  const { data: stats } = useQuery({
    queryKey: ['ski-swap/stats', orgId, selectedSwap?.id],
    queryFn: () => api.skiSwap.getStats(orgId, selectedSwap!.id),
    enabled: !!selectedSwap,
    // Sales move at the register, not on this page: read again each minute,
    // or the figures stand still until a reload.
    refetchInterval: 60_000,
  });

  // Sellers missing an address or a way to be paid. Invisible until someone
  // tries to act on the gap — a cheque with nowhere to go, an unsold item
  // nobody can return — so it is worth a tile while the swap is still running.
  const { data: unpayable = [] } = useQuery({
    queryKey: ['ski-swap/sellers', orgId, true],
    queryFn: () => api.skiSwap.listSellers(orgId, undefined, true),
    enabled: !!orgId,
    staleTime: 30_000,
  });

  /**
   * How many people are standing next to a pile waiting for a volunteer.
   *
   * Asked for only when the scan is on: with it off every item is consigned at
   * creation, so the answer is always zero and the request buys nothing. One
   * item is fetched because only `total` is read.
   */
  const { data: waiting } = useQuery({
    queryKey: ['ski-swap/items', orgId, selectedSwap?.id, 'awaiting-consignment'],
    queryFn: () => api.skiSwap.listItems(orgId, selectedSwap!.id, { consigned: false, take: 1 }),
    enabled: !!selectedSwap && requireConsignmentScan,
    // Short: this is the number that moves during a swap, and it is read by
    // someone deciding whether to send another volunteer to the tables.
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // Sellers with items in this swap first: theirs are the payments coming up.
  const inSwap = (s: (typeof unpayable)[number]) => s.receiptSwaps.some((w) => w.id === selectedSwap?.id);
  const named = [...unpayable].sort((a, b) => Number(inSwap(b)) - Number(inSwap(a))).slice(0, NAMED_SELLERS);

  if (!selectedSwap) {
    return (
      <p className="text-gray-400 text-sm">
        {perms.has('ski_swap:admin')
          ? "No active swaps found. Create one on the 'Swaps' page."
          : 'No active swaps found. Contact your swap administrator to create one.'}
      </p>
    );
  }

  // Sold and revenue come from Square. When it could not be read they are
  // unknown, not zero, and a dash says so where a number would be believed.
  const stockKnown = stats?.inventoryKnown ?? false;
  const revenue = stats && stockKnown ? dollars(stats.grossRevenueCents) : '—';
  const consignedUnpriced = stats?.consignedUnpriced ?? 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <StatTile label="Total Items" value={stats?.totalItems ?? '—'} />
        <StatTile label="Sellers" value={stats?.totalSellers ?? '—'} />
        {/* What's on the floor, from our own rows: it climbs through check-in,
            while revenue waits for the first sale. */}
        <StatTile
          label="Consigned Value"
          value={stats ? dollars(stats.consignedValueCents) : '—'}
          note={stats
            ? `${stats.consignedItems.toLocaleString('en-US')} accepted`
              + (consignedUnpriced > 0 ? ` · ${consignedUnpriced.toLocaleString('en-US')} not priced yet` : '')
            : undefined}
        />
        <StatTile label="Items Sold" value={stockKnown ? (stats?.itemsSold ?? '—') : '—'} />
        <StatTile label="Est. Revenue" value={revenue} note="Items sold, at listed prices" />
      </div>
      {stats && !stockKnown && (
        <p className="text-xs text-amber-300">
          Square could not be read just now, so sold counts and revenue are unavailable. Reload in a moment.
        </p>
      )}
      {stats && stockKnown && stats.unpricedSold > 0 && (
        <p className="text-xs text-gray-400">
          Revenue leaves out {stats.unpricedSold} ticket{stats.unpricedSold === 1 ? '' : 's'} sold before
          {stats.unpricedSold === 1 ? ' it was' : ' they were'} priced, at a price typed at the register. A payout run records those prices.
        </p>
      )}

      {/* Each card says what's wrong and what to do, and goes where it's
          done. Shown only when there is something to act on: a zero here is
          the normal state, and a card reading zero every day stops being read. */}

      {/* Nothing here accepts an item: that happens at the table, on the
          staff iPad. The link shows which ones. */}
      {(waiting?.total ?? 0) > 0 && (
        <Link to="/dashboard/ski-swap/items?show=not-received" className={`${issueCard} hover:border-amber-600`}>
          <p className="text-amber-300 text-sm font-medium">
            {waiting!.total} {waiting!.total === 1 ? 'item is' : 'items are'} waiting to be accepted
          </p>
          <p className="text-xs text-amber-500/80 mt-0.5">
            Their sellers are standing with them. At the check-in table, scan each tag on the staff iPad
            to accept it. Click to see which items.
          </p>
        </Link>
      )}

      {(stats?.unpricedItems ?? 0) > 0 && (
        <Link
          to={canManage ? '/dashboard/ski-swap/items?show=needs-price&fast-edit=1' : '/dashboard/ski-swap/items?show=needs-price'}
          className={`${issueCard} hover:border-amber-600`}
        >
          <p className="text-amber-300 text-sm font-medium">
            {stats!.unpricedItems} {stats!.unpricedItems === 1 ? 'ticket has' : 'tickets have'} no price yet
          </p>
          <p className="text-xs text-amber-500/80 mt-0.5">
            {canManage
              ? 'Click to open Fast Edit Tickets, and enter each ticket from its stub: SKU, details and price. '
              : 'Click to see them. '}
            Price them before sales start: one that reaches the register unpriced needs the clerk to type a price.
          </p>
        </Link>
      )}

      {unpayable.length > 0 && (
        <div className={issueCard}>
          <Link to="/dashboard/ski-swap/sellers?show=unpayable" className="text-amber-300 text-sm font-medium hover:underline">
            {unpayable.length} {unpayable.length === 1 ? 'seller' : 'sellers'} cannot be paid
          </Link>
          <p className="text-xs text-amber-500/80 mt-0.5">
            Fix before the swap closes.{canManage && ' Click a seller to open them, with what to fix at the top.'}
          </p>
          <ul className="mt-2 space-y-1.5">
            {named.map((s) => (
              <li key={s.id}>
                {canManage ? (
                  <Link to={`/dashboard/ski-swap/sellers?edit=${s.id}`} className="text-sm text-white hover:underline">
                    {s.displayName}
                  </Link>
                ) : (
                  <span className="text-sm text-white">{s.displayName}</span>
                )}
                {payoutGaps(s).map((g) => (
                  <p key={g.key} className="text-xs">
                    <span className="text-amber-300">{g.problem}.</span>{' '}
                    <span className="text-amber-500/80">{g.fix}</span>
                  </p>
                ))}
              </li>
            ))}
          </ul>
          {unpayable.length > NAMED_SELLERS && (
            <Link to="/dashboard/ski-swap/sellers?show=unpayable" className="inline-block mt-2 text-xs text-amber-300 hover:underline">
              See all {unpayable.length} on the Sellers page
            </Link>
          )}
        </div>
      )}
    </div>
  );
}
