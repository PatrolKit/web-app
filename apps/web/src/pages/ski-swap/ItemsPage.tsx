import { useCallback, useState } from 'react';
import { Link, useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  faBarcodeRead as faBarcodeReadDuo,
  faBarcodeScan as faBarcodeScanDuo,
  faCloudArrowUp as faCloudArrowUpDuo,
  faFileImport as faFileImportDuo,
  faKeyboard as faKeyboardDuo,
  faRotateLeft as faRotateLeftDuo,
  faHandHoldingBox as faHandHoldingBoxDuo,
  faTags as faTagsDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api } from '../../lib/api';
import type { SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import SwapItemsPanel, { itemState } from './SwapItemsPanel';
import ProxyItemImportModal from './ProxyItemImportModal';
import TicketFastEdit from './TicketFastEdit';
import ReturnTicketsModal from './ReturnTicketsModal';
import BatchAddTicketsModal from './BatchAddTicketsModal';
import ScanTicketModal from './ScanTicketModal';
import ReturnItemsModal from './ReturnItemsModal';
import BatchSetCategoryModal from './BatchSetCategoryModal';
import TicketSquareModal, { useTicketPushStatus } from './TicketSquareModal';

export default function ItemsPage() {
  const { orgId, perms, selectedSwap } = useOutletContext<SkiSwapContext>();
  const labelsPerItem = selectedSwap?.labelsPerItem ?? 1;
  const canManage = perms.has('ski_swap:manage');
  const swapId = selectedSwap?.id ?? null;
  const qc = useQueryClient();
  // Stable, for Batch set category's queue, which re-runs when it changes.
  const onItemsChanged = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId] });
    void qc.invalidateQueries({ queryKey: ['ski-swap/stats', orgId] });
  }, [qc, orgId]);
  const [searchParams, setSearchParams] = useSearchParams();
  const [importing, setImporting] = useState(false);
  // The dashboard's unpriced-tickets card opens Fast Edit directly.
  const [fastEditing, setFastEditing] = useState(canManage && searchParams.get('fast-edit') === '1');
  const [returning, setReturning] = useState(false);
  const [batchAdding, setBatchAdding] = useState(false);
  const [scanning, setScanning] = useState(false);
  /** Handing unsold items back to their sellers (Plan 43). */
  const [returningItems, setReturningItems] = useState(false);
  const [categorizing, setCategorizing] = useState(false);
  const [pushingOpen, setPushingOpen] = useState(false);
  const canAdmin = perms.has('ski_swap:admin');

  /** The swap's web takes no print tickets, so no row may get a generated SKU (Plan 34). */
  const webTicketsOnly = selectedSwap ? !selectedSwap.allowPrintWeb : false;

  /**
   * Who could be uploaded for: sellers holding tickets in this swap, and, when
   * its web isn't tickets-only, every business seller (Plan 31).
   */
  const { data: ticketSellers = [], isLoading: ticketSellersLoading } = useQuery({
    queryKey: ['ski-swap/ticket-sellers', orgId, swapId],
    queryFn: () => api.skiSwap.listTicketSellers(orgId, swapId!),
    enabled: !!swapId && canManage,
  });

  /**
   * Why the import cannot be used, or empty when it can.
   *
   * The button stays put and goes grey rather than disappearing. A control that
   * comes and going teaches staff it is unreliable and gives them nowhere to
   * look for the reason; one that is visible and says what is missing points at
   * the thing to go and do.
   */
  const importBlockedBecause = ticketSellersLoading
    ? 'Checking who can be uploaded for…'
    : ticketSellers.length === 0
      ? webTicketsOnly
        ? 'Nobody has been issued tickets for this swap yet. Issue a range from a shop’s row on the Sellers page.'
        : 'No business sellers yet. Add a shop on the Sellers page.'
      : '';

  /** Tickets still needing a price, for the fast edit's button (Plan 37). */
  const { data: unpriced } = useQuery({
    queryKey: ['ski-swap/unpriced-tickets', orgId, swapId],
    queryFn: () => api.skiSwap.unpricedTickets(orgId, swapId!),
    enabled: !!swapId && canManage,
  });
  const unpricedCount = unpriced?.length ?? 0;
  const takesTickets = !!selectedSwap && (selectedSwap.allowLegacyCheckin || selectedSwap.allowLegacyWeb);

  /** Shops holding issued tickets here: who unused ones can be taken back from (Plan 38). */
  const ticketHolders = ticketSellers.filter((t) => t.ticketCount > 0);
  const { data: pushStatus } = useTicketPushStatus(orgId, swapId, canAdmin);
  const notInSquare = pushStatus?.notInSquare ?? 0;

  const { data: sellers = [] } = useQuery<SellerResponse[]>({
    queryKey: ['ski-swap/sellers', orgId],
    queryFn: () => api.skiSwap.listSellers(orgId),
    enabled: !!orgId && canManage,
  });

  if (!swapId) {
    return (
      <p className="text-gray-400 text-sm">
        {perms.has('ski_swap:admin')
          ? "No active swaps found. Create one on the 'Swaps' page."
          : 'No active swaps found. Contact your swap administrator to create one.'}
      </p>
    );
  }

  return (
    <>
    <SwapItemsPanel
      orgId={orgId}
      swapId={swapId}
      canManage={canManage}
      showSearch
      sellers={sellers}
      queryKeyPrefix="ski-swap/items"
      labelsPerItem={labelsPerItem}
      batchPrint={canManage}
      // Plan 49: an admin records an exchange of a sold item from its row.
      rowAction={perms.has('ski_swap:admin') ? (item) => itemState(item).key === 'sold' && (
        <Link to={`../exchanges?ticket=${encodeURIComponent(item.sku)}`} className="text-xs text-brand-500 hover:underline">Exchange…</Link>
      ) : undefined}
      actions={canManage ? [
        // Where the swap takes legacy tickets, or has some waiting for a
        // price (Plan 37).
        ...(takesTickets || unpricedCount > 0
          ? [{
              key: 'fast-edit',
              label: `Fast edit tickets (${unpricedCount})`,
              icon: faKeyboardDuo,
              disabledReason: unpricedCount === 0 ? 'No tickets need a price.' : undefined,
              onSelect: () => setFastEditing(true),
            }]
          : []),
        // Looking items up by their tags, any swap: tickets and our labels alike.
        {
          key: 'scan-ticket',
          label: 'Scan ticket',
          icon: faBarcodeScanDuo,
          onSelect: () => setScanning(true),
        },
        // Scanning a stack of legacy tickets to one seller (Plan 40): where the
        // swap takes legacy tickets, as the fast edit is.
        ...(takesTickets
          ? [{
              key: 'batch-add',
              label: 'Batch add to seller',
              icon: faBarcodeReadDuo,
              onSelect: () => setBatchAdding(true),
            }]
          : []),
        // Issued tickets (Plan 38): finishing a push that stopped, and taking
        // back what a shop returned. Staff who can issue them.
        ...(canAdmin && notInSquare > 0
          ? [{
              key: 'push',
              label: `Put tickets in Square (${notInSquare.toLocaleString('en-US')})`,
              icon: faCloudArrowUpDuo,
              disabledReason: pushStatus?.pushing
                ? 'Putting them in Square now.'
                : !pushStatus?.squareReady ? 'Square isn’t set up for this swap.' : undefined,
              onSelect: () => setPushingOpen(true),
            }]
          : []),
        ...(canAdmin && ticketHolders.length > 0
          ? [{
              key: 'return',
              label: 'Return unused tickets',
              icon: faRotateLeftDuo,
              onSelect: () => setReturning(true),
            }]
          : []),
        // End of the swap (Plan 43): unsold items back to their sellers.
        {
          key: 'return-items',
          label: 'Return items to sellers',
          icon: faHandHoldingBoxDuo,
          onSelect: () => setReturningItems(true),
        },
        // Plan 45: scanned items with no category get one.
        {
          key: 'batch-category',
          label: 'Batch set category',
          icon: faTagsDuo,
          onSelect: () => setCategorizing(true),
        },
        {
          key: 'import',
          label: 'Import for a seller',
          icon: faFileImportDuo,
          // Said, not hidden: a control that comes and goes teaches staff it's
          // unreliable and gives them nowhere to look for the reason.
          disabledReason: importBlockedBecause || undefined,
          onSelect: () => setImporting(true),
        },
      ] : []}
      panelApi={{
        fetchItems: (sid, opts) => api.skiSwap.listItems(orgId, sid, opts),
        createItem: (sid, data) => api.skiSwap.createItem(orgId, sid, data),
        patchItem: (iid, data) => api.skiSwap.patchItem(orgId, swapId, iid, data),
        deleteItem: (iid) => api.skiSwap.deleteItem(orgId, swapId, iid),
        undoReturn: canManage ? (iid) => api.skiSwap.undoItemReturn(orgId, swapId, iid) : undefined,
        uploadPhoto: (iid, file) => api.skiSwap.uploadPhoto(orgId, swapId, iid, file),
        deletePhoto: (iid, pid) => api.skiSwap.deletePhoto(orgId, swapId, iid, pid),
        // Staff only. The seller's own page does not pass this, so the button
        // never appears there — accepting your own goods is not a thing.
        consignAllForSeller: (sid, sellerId) => api.skiSwap.consignAllForSeller(orgId, sid, sellerId),
      }}
    />

    {fastEditing && swapId && (
      <TicketFastEdit
        orgId={orgId}
        swapId={swapId}
        onClose={() => {
          setFastEditing(false);
          // So a reload doesn't open it again.
          setSearchParams((p) => { p.delete('fast-edit'); return p; }, { replace: true });
          void qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId] });
          void qc.invalidateQueries({ queryKey: ['ski-swap/unpriced-tickets', orgId, swapId] });
        }}
      />
    )}

    {scanning && swapId && (
      <ScanTicketModal orgId={orgId} swapId={swapId} onClose={() => setScanning(false)} />
    )}

    {returningItems && swapId && (
      <ReturnItemsModal
        orgId={orgId}
        swapId={swapId}
        sellers={sellers}
        onClose={() => setReturningItems(false)}
        onChanged={() => {
          void qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId] });
          void qc.invalidateQueries({ queryKey: ['ski-swap/stats', orgId] });
        }}
      />
    )}

    {categorizing && swapId && (
      <BatchSetCategoryModal
        orgId={orgId}
        swapId={swapId}
        onClose={() => setCategorizing(false)}
        onChanged={onItemsChanged}
      />
    )}

    {batchAdding && swapId && (
      <BatchAddTicketsModal
        orgId={orgId}
        swapId={swapId}
        sellers={sellers}
        onClose={() => setBatchAdding(false)}
        onSaved={() => {
          void qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId] });
          void qc.invalidateQueries({ queryKey: ['ski-swap/unpriced-tickets', orgId, swapId] });
          void qc.invalidateQueries({ queryKey: ['ski-swap/ticket-push', orgId, swapId] });
          void qc.invalidateQueries({ queryKey: ['ski-swap/stats', orgId] });
        }}
      />
    )}

    {returning && swapId && (
      <ReturnTicketsModal
        orgId={orgId}
        swapId={swapId}
        holders={ticketHolders}
        onClose={() => setReturning(false)}
        onRemoved={() => {
          void qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId] });
          void qc.invalidateQueries({ queryKey: ['ski-swap/ticket-sellers', orgId, swapId] });
          void qc.invalidateQueries({ queryKey: ['ski-swap/unpriced-tickets', orgId, swapId] });
          void qc.invalidateQueries({ queryKey: ['ski-swap/ticket-push', orgId, swapId] });
          void qc.invalidateQueries({ queryKey: ['ski-swap/issued-tickets', orgId] });
        }}
      />
    )}

    {pushingOpen && swapId && (
      <TicketSquareModal orgId={orgId} swapId={swapId} onClose={() => setPushingOpen(false)} />
    )}

    {importing && swapId && (
      <ProxyItemImportModal
        orgId={orgId}
        swapId={swapId}
        allowGenerate={!webTicketsOnly}
        onClose={() => setImporting(false)}
        onImported={() => {
          void qc.invalidateQueries({ queryKey: ['ski-swap/items', orgId] });
          void qc.invalidateQueries({ queryKey: ['ski-swap/ticket-sellers', orgId, swapId] });
        }}
      />
    )}
    </>
  );
}

