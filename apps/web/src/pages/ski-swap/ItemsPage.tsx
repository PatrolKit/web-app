import { useState } from 'react';
import { useOutletContext, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import SwapItemsPanel from './SwapItemsPanel';
import ProxyItemImportModal from './ProxyItemImportModal';

export default function ItemsPage() {
  const { orgId, perms, selectedSwap } = useOutletContext<SkiSwapContext>();
  const labelsPerItem = selectedSwap?.labelsPerItem ?? 1;
  const canManage = perms.has('ski_swap:manage');
  const swapId = selectedSwap?.id ?? null;
  const qc = useQueryClient();
  const [importing, setImporting] = useState(false);
  const [searchParams] = useSearchParams();

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
        ? 'Nobody has been issued tickets for this swap yet. Issue a block from a seller’s Ticket source.'
        : 'No business sellers yet. Add a shop on the Sellers page.'
      : '';

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
      initialNeedsPrice={searchParams.get('show') === 'needs-price'}
      sellers={sellers}
      queryKeyPrefix="ski-swap/items"
      labelsPerItem={labelsPerItem}
      toolbarExtra={
        canManage ? (
          // The title sits on the wrapper, not the button: a disabled control
          // takes no pointer events in some browsers, and the tooltip explaining
          // why it is disabled is exactly the one nobody would then see.
          <span title={importBlockedBecause || undefined}>
            <button
              onClick={() => setImporting(true)}
              disabled={!!importBlockedBecause}
              className="bg-surface-100 hover:bg-surface-200 text-gray-200 px-4 py-2 rounded text-sm disabled:opacity-40 disabled:hover:bg-surface-100"
            >
              Import for a seller
            </button>
          </span>
        ) : undefined
      }
      panelApi={{
        fetchItems: (sid, opts) => api.skiSwap.listItems(orgId, sid, opts),
        createItem: (sid, data) => api.skiSwap.createItem(orgId, sid, data),
        patchItem: (iid, data) => api.skiSwap.patchItem(orgId, swapId, iid, data),
        deleteItem: (iid) => api.skiSwap.deleteItem(orgId, swapId, iid),
        uploadPhoto: (iid, file) => api.skiSwap.uploadPhoto(orgId, swapId, iid, file),
        deletePhoto: (iid, pid) => api.skiSwap.deletePhoto(orgId, swapId, iid, pid),
        // Staff only. The seller's own page does not pass this, so the button
        // never appears there — accepting your own goods is not a thing.
        consignAllForSeller: (sid, sellerId) => api.skiSwap.consignAllForSeller(orgId, sid, sellerId),
      }}
    />

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

