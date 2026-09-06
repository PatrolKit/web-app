import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import type { SkiSwapContext } from './SkiSwapLayout';
import SwapItemsPanel from './SwapItemsPanel';
import TicketItemImportModal from './TicketItemImportModal';

export default function BusinessSellerPage() {
  const { orgId, sellerSelectedSwapId, setSellerSelectedSwapId, labelsPerItem } = useOutletContext<SkiSwapContext>();
  void setSellerSelectedSwapId; // consumed by SkiSwapLayout
  const qc = useQueryClient();

  /**
   * Whether this seller is on issued tickets, and which number to offer.
   *
   * A seller with no ranges gets `ranges: []`, and the panel keeps its ordinary
   * shape — minted SKU, printable tag. The two are alternatives, so nothing
   * here has to ask which kind of seller this is.
   */
  const ticketQueryKey = ['ski-swap/ticket-state', orgId, sellerSelectedSwapId];
  const { data: ticketState } = useQuery({
    queryKey: ticketQueryKey,
    queryFn: () => api.skiSwap.ticketState(orgId, sellerSelectedSwapId!),
    enabled: !!sellerSelectedSwapId,
  });

  const onTickets = !!ticketState && ticketState.ranges.length > 0;
  const [importing, setImporting] = useState(false);

  return (
    <>
    <SwapItemsPanel
      orgId={orgId}
      swapId={sellerSelectedSwapId}
      canManage={true}
      queryKeyPrefix="seller/items"
      labelsPerItem={labelsPerItem}
      emptyMessage="No items yet."
      tickets={
        onTickets
          ? {
              ranges: ticketState.ranges,
              suggested: ticketState.suggested,
              exhausted: ticketState.exhausted,
              onUsed: () => { void qc.invalidateQueries({ queryKey: ticketQueryKey }); },
            }
          : undefined
      }
      panelApi={{
        fetchItems: (sid) => api.skiSwap.sellerListItems(orgId, sid),
        createItem: (_sid, data) => api.skiSwap.sellerCreateItem(orgId, {
          swapId: sellerSelectedSwapId!,
          name: data.name,
          description: data.description,
          priceCents: data.priceCents,
          quantity: data.quantity,
          donateProceeds: data.donateProceeds,
          sku: data.sku,
        }),
        patchItem: (iid, data) => api.skiSwap.sellerPatchItem(orgId, iid, data),
        deleteItem: (iid) => api.skiSwap.sellerDeleteItem(orgId, iid),
        uploadPhoto: (iid, file) => api.skiSwap.sellerUploadPhoto(orgId, iid, file),
        deletePhoto: (iid, pid) => api.skiSwap.sellerDeletePhoto(orgId, iid, pid),
      }}
      />

      {/* Only a shop on issued tickets can import: every row is a ticket
          number, and a seller who prints their own has none to give. */}
      {onTickets && sellerSelectedSwapId && (
        <div className="flex justify-end">
          <button
            onClick={() => setImporting(true)}
            className="text-sm text-brand-500 hover:underline"
          >
            Import items from a file
          </button>
        </div>
      )}

      {importing && sellerSelectedSwapId && (
        <TicketItemImportModal
          orgId={orgId}
          swapId={sellerSelectedSwapId}
          onClose={() => setImporting(false)}
          onImported={() => {
            void qc.invalidateQueries({ queryKey: ['seller/items', orgId] });
            void qc.invalidateQueries({ queryKey: ticketQueryKey });
          }}
        />
      )}
    </>
  );
}
