import { useOutletContext } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import type { SellerResponse } from '../../lib/api.types';
import type { SkiSwapContext } from './SkiSwapLayout';
import SwapItemsPanel from './SwapItemsPanel';

export default function ItemsPage() {
  const { orgId, perms, selectedSwap, labelsPerItem } = useOutletContext<SkiSwapContext>();
  const canManage = perms.has('ski_swap:manage');
  const swapId = selectedSwap?.id ?? null;

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
    <SwapItemsPanel
      orgId={orgId}
      swapId={swapId}
      canManage={canManage}
      showSearch
      sellers={sellers}
      queryKeyPrefix="ski-swap/items"
      labelsPerItem={labelsPerItem}
      panelApi={{
        fetchItems: (sid, opts) => api.skiSwap.listItems(orgId, sid, opts),
        createItem: (sid, data) => api.skiSwap.createItem(orgId, sid, data),
        patchItem: (iid, data) => api.skiSwap.patchItem(orgId, swapId, iid, data),
        deleteItem: (iid) => api.skiSwap.deleteItem(orgId, swapId, iid),
        uploadPhoto: async (iid, file) => {
          const r = await api.skiSwap.uploadPhoto(orgId, swapId, iid, file);
          return r.data;
        },
        deletePhoto: (iid, pid) => api.skiSwap.deletePhoto(orgId, swapId, iid, pid),
      }}
    />
  );
}

