import type { PublicSkuStatus } from '../../lib/api.types';

/** A status in words. "2 of 3 sold" where there's more than one. */
export function statusText(result: PublicSkuStatus): { text: string; tone: string } {
  switch (result.status) {
    case 'sold':
      return { text: 'Sold', tone: 'text-green-400' };
    case 'for_sale':
      return result.soldCount
        ? { text: `${result.soldCount} of ${result.quantity} sold`, tone: 'text-brand-400' }
        : { text: 'For sale', tone: 'text-brand-400' };
    case 'not_received':
      return { text: 'Not checked in yet', tone: 'text-gray-300' };
    case 'returned':
      return { text: 'Returned to seller', tone: 'text-gray-300' };
    default:
      return { text: 'We can’t check right now. Try again in a minute.', tone: 'text-amber-300' };
  }
}
