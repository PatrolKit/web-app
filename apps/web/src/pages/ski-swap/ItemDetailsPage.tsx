import { useOutletContext } from 'react-router-dom';
import ItemDetailsCard from './ItemDetailsCard';
import type { SkiSwapContext } from './SkiSwapLayout';

/**
 * The item-description tree, on its own.
 *
 * Wider than the settings column beside it. Not because anything overflowed at
 * `max-w-lg` — the rows stack their actions under the label, so they fit — but
 * because the labels are whatever a seller typed at a counter, and a queue of
 * them reads better when "Rossignol Experience 88 Ti" is not the widest thing on
 * the page.
 */
export default function ItemDetailsPage() {
  const { orgId } = useOutletContext<SkiSwapContext>();
  return (
    <div className="max-w-3xl">
      <ItemDetailsCard orgId={orgId} />
    </div>
  );
}
