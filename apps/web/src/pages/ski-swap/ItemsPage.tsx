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

  /**
   * Offered only when somebody could actually be uploaded for: the swap takes
   * legacy tickets and at least one shop holds a block. A button that can only
   * open onto an empty picker is a button staff learn to ignore.
   */
  const { data: ticketSellers = [] } = useQuery({
    queryKey: ['ski-swap/ticket-sellers', orgId, swapId],
    queryFn: () => api.skiSwap.listTicketSellers(orgId, swapId!),
    enabled: !!swapId && canManage && !!selectedSwap?.legacyTicketsEnabled,
  });

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
        ticketSellers.length > 0 ? (
          <button
            onClick={() => setImporting(true)}
            className="bg-surface-100 hover:bg-surface-200 text-gray-200 px-4 py-2 rounded text-sm"
          >
            Import for a seller
          </button>
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

