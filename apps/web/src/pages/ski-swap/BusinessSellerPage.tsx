import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import type { SkiSwapContext } from './SkiSwapLayout';
import SwapItemsPanel from './SwapItemsPanel';
import TicketItemImportModal from './TicketItemImportModal';

export default function BusinessSellerPage() {
  const { orgId, sellerSelectedSwapId, setSellerSelectedSwapId, sellerSwaps } = useOutletContext<SkiSwapContext>();
  const labelsPerItem = sellerSwaps.find((s) => s.id === sellerSelectedSwapId)?.labelsPerItem ?? 1;
  void setSellerSelectedSwapId; // consumed by SkiSwapLayout
  const qc = useQueryClient();

  /**
   * Whether this seller holds issued tickets, which number to offer, and
   * whether the swap's web takes tickets only (Plan 31).
   *
   * A seller with no ranges gets `ranges: []`, and the panel keeps its ordinary
   * shape: generated SKU, printable label. One with ranges is offered the next
   * ticket, and, unless the web is tickets-only, may clear it to print a label
   * instead.
   */
  const ticketQueryKey = ['ski-swap/ticket-state', orgId, sellerSelectedSwapId];
  const { data: ticketState } = useQuery({
    queryKey: ticketQueryKey,
    queryFn: () => api.skiSwap.ticketState(orgId, sellerSelectedSwapId!),
    enabled: !!sellerSelectedSwapId,
  });

  /**
   * An individual seller adds items only while checking in at the swap, from
   * its QR code, and can't change them here afterwards; staff can. A shop
   * manages its own from its desk.
   */
  const { data: profile } = useQuery({
    queryKey: ['seller/profile', orgId],
    queryFn: () => api.skiSwap.sellerGetProfile(orgId),
    enabled: !!orgId,
  });
  const isShop = !!profile?.businessName;

  const onTickets = !!ticketState && ticketState.ranges.length > 0;
  const webTicketsOnly = !!ticketState?.webTicketsOnly;
  const [importing, setImporting] = useState(false);

  return (
    <>
    <SwapItemsPanel
      orgId={orgId}
      swapId={sellerSelectedSwapId}
      canManage={isShop}
      selfService
      queryKeyPrefix="seller/items"
      labelsPerItem={labelsPerItem}
      emptyMessage="No items yet."
      toolbarNote={
        profile && !isShop ? (
          <p className="text-xs text-gray-500 max-w-xs text-right">
            Add items when you check in at the swap, by scanning its check-in QR code. Staff there can change them.
          </p>
        ) : undefined
      }
      tickets={
        onTickets
          ? {
              ranges: ticketState.ranges,
              suggested: ticketState.suggested,
              exhausted: ticketState.exhausted,
              optional: !webTicketsOnly,
              onUsed: () => { void qc.invalidateQueries({ queryKey: ticketQueryKey }); },
            }
          : undefined
      }
      // A shop can import when its rows can be made into items: on tickets, or
      // with generated SKUs when the swap's web isn't tickets-only (Plan 31).
      actions={isShop && (onTickets || (ticketState && !webTicketsOnly)) && sellerSelectedSwapId
        ? [{ key: 'import', label: 'Import items from a file', onSelect: () => setImporting(true) }]
        : []}
      addBlockedBecause={
        webTicketsOnly && ticketState && !onTickets
          ? 'This swap takes legacy tickets only. Ask the organizer for a block of tickets.'
          : undefined
      }
      panelApi={{
        fetchItems: (sid, opts) => api.skiSwap.sellerListItems(orgId, sid, opts),
        createItem: (_sid, data) => api.skiSwap.sellerCreateItem(orgId, {
          swapId: sellerSelectedSwapId!,
          categoryId: data.categoryId,
          attributes: data.attributes,
          description: data.description,
          priceCents: data.priceCents,
          quantity: data.quantity,
          donateProceeds: data.donateProceeds,
          sku: data.sku,
          generateSku: data.generateSku,
        }),
        patchItem: (iid, data) => api.skiSwap.sellerPatchItem(orgId, iid, data),
        deleteItem: (iid) => api.skiSwap.sellerDeleteItem(orgId, iid),
        uploadPhoto: (iid, file) => api.skiSwap.sellerUploadPhoto(orgId, iid, file),
        deletePhoto: (iid, pid) => api.skiSwap.sellerDeletePhoto(orgId, iid, pid),
      }}
      />

      {importing && sellerSelectedSwapId && (
        <TicketItemImportModal
          orgId={orgId}
          swapId={sellerSelectedSwapId}
          allowGenerate={!webTicketsOnly}
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
