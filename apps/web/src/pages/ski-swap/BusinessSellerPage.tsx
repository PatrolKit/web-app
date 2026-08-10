import { useOutletContext } from 'react-router-dom';
import { api } from '../../lib/api';
import type { SkiSwapContext } from './SkiSwapLayout';
import SwapItemsPanel from './SwapItemsPanel';

export default function BusinessSellerPage() {
  const { orgId, sellerSelectedSwapId, setSellerSelectedSwapId } = useOutletContext<SkiSwapContext>();
  void setSellerSelectedSwapId; // consumed by SkiSwapLayout

  return (
    <SwapItemsPanel
      orgId={orgId}
      swapId={sellerSelectedSwapId}
      canManage={true}
      queryKeyPrefix="seller/items"
      emptyMessage="No items yet."

        panelApi={{
          fetchItems: (sid) => api.skiSwap.sellerListItems(orgId, sid),
          createItem: (_sid, data) => api.skiSwap.sellerCreateItem(orgId, {
            swapId: sellerSelectedSwapId!,
            name: data.name,
            description: data.description,
            priceCents: data.priceCents,
            quantity: data.quantity,
            donateProceeds: data.donateProceeds,
          }),
          patchItem: (iid, data) => api.skiSwap.sellerPatchItem(orgId, iid, data),
          deleteItem: (iid) => api.skiSwap.sellerDeleteItem(orgId, iid),
          uploadPhoto: async (iid, file) => {
            const r = await api.skiSwap.sellerUploadPhoto(orgId, iid, file);
            return r.data;
          },
          deletePhoto: (iid, pid) => api.skiSwap.sellerDeletePhoto(orgId, iid, pid),
        }}
      />
  );
}


