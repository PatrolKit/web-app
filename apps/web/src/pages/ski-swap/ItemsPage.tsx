import { useState } from 'react';
import { useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import SwapItemsPanel from './SwapItemsPanel';
import ProxyItemImportModal from './ProxyItemImportModal';

export default function ItemsPage() {
  const { orgId, perms, selectedSwap, labelsPerItem } = useOutletContext<SkiSwapContext>();
  const canManage = perms.has('ski_swap:manage');
  const swapId = selectedSwap?.id ?? null;
  const qc = useQueryClient();
  const [importing, setImporting] = useState(false);

  const legacyOn = !!selectedSwap?.legacyTicketsEnabled;

  /** Who could be uploaded for. Not asked when the swap takes no tickets. */
  const { data: ticketSellers = [], isLoading: ticketSellersLoading } = useQuery({
    queryKey: ['ski-swap/ticket-sellers', orgId, swapId],
    queryFn: () => api.skiSwap.listTicketSellers(orgId, swapId!),
    enabled: !!swapId && canManage && legacyOn,
  });

  /**
   * Why the import cannot be used, or empty when it can.
   *
   * The button stays put and goes grey rather than disappearing. A control that
   * comes and going teaches staff it is unreliable and gives them nowhere to
   * look for the reason; one that is visible and says what is missing points at
   * the thing to go and do.
   */
  const importBlockedBecause = !legacyOn
    ? 'This swap does not take tickets from the stockpile. Turn that on when you edit the swap.'
    : ticketSellersLoading
      ? 'Checking who holds tickets…'
      : ticketSellers.length === 0
        ? 'Nobody has been issued tickets for this swap yet. Issue a block from a seller’s Ticket source.'
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
      }}
    />

    {importing && swapId && (
      <ProxyItemImportModal
        orgId={orgId}
        swapId={swapId}
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

