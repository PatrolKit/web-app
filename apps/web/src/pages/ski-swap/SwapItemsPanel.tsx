import { useEffect, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faPrint as faPrintDuo, faRotateRight as faRotateRightDuo, faTag as faTagDuo, faTriangleExclamation as faTriangleExclamationDuo } from '@fortawesome/pro-duotone-svg-icons';
import type { ItemAttributeInput, ItemResponse, SellerResponse } from '../../lib/api.types';
import SearchableSelect from '../../components/SearchableSelect';
import ActionsMenu, { type MenuAction } from '../../components/ActionsMenu';
import ItemDescriber, {
  emptyDescriber, toAttributeInputs, NamePreview, type DescriberState,
} from '../../components/ItemDescriber';
import { usePrinter } from '../../contexts/PrinterContext';
import { isWebBluetoothSupported } from '../../lib/printing/PhomemoPrinterService';
import { priceInput, priceInputCents } from '../../lib/money';

// ─── API adapter interface ────────────────────────────────────────────────────

export interface SwapItemsPanelApi {
  /**
   * `sellerId` is applied by the server, not by filtering what came back.
   *
   * The server answers a page at a time (`skip`/`take`), and the panel asks
   * for every page: the state and tag filters are applied here, so a list
   * that stopped at the server's default of fifty hid everything past it from
   * "Not printed" and "Not yet received" with nothing on screen to say so.
   */
  fetchItems: (
    swapId: string,
    opts?: { query?: string; sellerId?: string; skip?: number; take?: number },
  ) => Promise<{ items: ItemResponse[]; total: number }>;
  /** Accepts every item this seller is still waiting on. Staff pages only. */
  consignAllForSeller?: (swapId: string, sellerId: string) => Promise<{ consigned: number }>;
  createItem: (swapId: string, data: CreateItemInput) => Promise<ItemResponse>;
  patchItem: (itemId: string, data: PatchItemInput) => Promise<ItemResponse>;
  deleteItem: (itemId: string) => Promise<void>;
  uploadPhoto?: (itemId: string, file: File) => Promise<{ id: string; url: string }>;
  deletePhoto?: (itemId: string, photoId: string) => Promise<void>;
}

export interface CreateItemInput {
  /** A ticket number, for a seller on issued tickets. Absent otherwise. */
  sku?: string;
  /** A ticket seller leaving the number blank, to print a label instead (Plan 31). */
  generateSku?: boolean;
  /**
   * What the item is. The name is derived from this and the answers (Plan 19).
   * Optional: without one the server calls the item by its number, `Item #<sku>`.
   */
  categoryId?: string;
  attributes?: ItemAttributeInput[];
  description?: string;
  /** Null only for a legacy ticket, priced later (Plan 32). */
  priceCents: number | null;
  quantity: number;
  sellerId?: string;
  donateProceeds?: boolean;
}

export interface PatchItemInput {
  categoryId?: string;
  attributes?: ItemAttributeInput[];
  description?: string | null;
  priceCents?: number;
  quantity?: number;
  sellerId?: string | null;
  donateProceeds?: boolean;
  hasPrintedTag?: boolean;
}

// ─── Props ────────────────────────────────────────────────────────────────────

export interface SwapItemsPanelProps {
  orgId: string;
  swapId: string | null;
  canManage: boolean;
  queryKeyPrefix: string;
  panelApi: SwapItemsPanelApi;
  /**
   * Present when the seller is on issued tickets rather than a printer. The
   * number replaces the minted SKU, the name stops being required, and there is
   * nothing to print — the tag is already on the goods.
   */
  tickets?: {
    ranges: { startNumber: number; endNumber: number }[];
    /** The number to offer. Null past the top of the ranges, which is not an error. */
    suggested: number | null;
    /** True only when nothing at all is unused — the one state that refuses. */
    exhausted: boolean;
    /**
     * The number may be left blank, for an item that gets a generated SKU and
     * a printed label instead (Plan 31): the swap's web isn't tickets-only.
     */
    optional?: boolean;
    onUsed: () => void;
  };
  /**
   * Why nothing can be added here, shown in place of the Add button. A seller
   * with no tickets in a swap whose web takes tickets only (Plan 31).
   */
  addBlockedBecause?: string;
  /**
   * True on a seller's own "My Items" page, false on the staff Items page.
   *
   * A seller may withdraw their own item until it is consigned — the moment it
   * becomes sellable, and on every path the same moment it reaches Square.
   * After that it has to be done at the counter, where somebody can see both
   * the gear and the tag. The server refuses either way; this stops the screen
   * offering a button that would be.
   */
  selfService?: boolean;
  showSearch?: boolean;
  /** Open with only unpriced tickets showing, as the dashboard's link asks (Plan 32). */
  initialNeedsPrice?: boolean;
  sellers?: SellerResponse[];
  emptyMessage?: string;
  labelsPerItem?: number;
  /**
   * The page's own actions, in the toolbar's one Actions menu after Add item:
   * the staff page's fast edit and seller import, a shop's file upload.
   */
  actions?: MenuAction[];
  /** A line at the end of the toolbar, for a page that has nothing to add. */
  toolbarNote?: ReactNode;
}

// ─── Form state ───────────────────────────────────────────────────────────────

interface ItemFormData {
  describer: DescriberState;
  description: string;
  priceDollars: string;
  quantity: string;
  sellerId: string;
  donateProceeds: boolean;
  /** The ticket on the item, for a seller on issued tickets. */
  sku: string;
}

/**
 * What the item form still needs before it can be saved, in the words shown
 * under its buttons. Empty means Add or Save is enabled.
 *
 * A seller is needed only where the form offers one: on staff screens. A
 * seller's own form has no picker, because the item is theirs. Quantity shows
 * only when editing; a new item is always one.
 *
 * A legacy ticket may be left without a price, to be priced before sales start
 * (Plan 32): `priceOptional`. A price that's typed still has to be one.
 */
export function missingItemFields(
  form: Pick<ItemFormData, 'priceDollars' | 'quantity' | 'sellerId'>,
  opts: { picksSeller: boolean; editing: boolean; priceOptional?: boolean },
): string[] {
  const missing: string[] = [];
  const typed = form.priceDollars.trim() !== '';
  if ((typed || !opts.priceOptional) && !(Math.round(parseFloat(form.priceDollars) * 100) > 0)) {
    missing.push(typed ? 'a price above $0.00' : 'a price');
  }
  if (opts.editing && !(parseInt(form.quantity, 10) >= 1)) missing.push('a quantity');
  if (opts.picksSeller && !form.sellerId) missing.push('a seller');
  return missing;
}

/** The form's price as cents, or null when it's left blank. */
const formPriceCents = priceInputCents;

const emptyForm: ItemFormData = { describer: emptyDescriber, description: '', priceDollars: '', quantity: '1', sellerId: '', donateProceeds: false, sku: '' };

/** "67000–67499", or "67000–67499, 68000–68499" for a shop with two pads. */
function describeRanges(ranges: { startNumber: number; endNumber: number }[]): string {
  return ranges.map((r) => `${r.startNumber}–${r.endNumber}`).join(', ');
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * What is true of an item right now, as one cell.
 *
 * This replaces an "In Stock" and a "Sold" column which between them told a
 * lie. `soldCount` is not recorded anywhere — it is `originalQuantity - inStock`
 * — and `inStock` is zero for anything Square has never heard of. So an item
 * waiting for a volunteer to scan it, which has never been pushed, read as
 * fully **sold**: the one state where nothing has happened looked like the one
 * where everything had.
 *
 * Ordered by what stops a sale first, because only the first answer matters: an
 * unscanned item is not also "not in Square" as far as anybody acting on this
 * screen is concerned, it is unscanned, and scanning it fixes both.
 */
export type ItemStateKey = 'not_received' | 'not_in_square' | 'stock_unknown' | 'for_sale' | 'sold';

/**
 * What the status filter offers. Where an item is in its life, then the two
 * things staff go looking for: an item that never reached Square, and a
 * ticket still waiting for its price (Plan 32).
 *
 * "Stock unknown" isn't one: it's Square not answering when the page loaded,
 * not something true of the item, and a notice above the table says so.
 */
export type StatusFilter = Exclude<ItemStateKey, 'stock_unknown'> | 'needs_price';

export const ITEM_STATE_FILTERS: { value: StatusFilter; label: string }[] = [
  { value: 'not_received', label: 'Not yet received' },
  { value: 'for_sale', label: 'For sale' },
  { value: 'sold', label: 'Sold' },
  { value: 'not_in_square', label: 'Not in Square' },
  { value: 'needs_price', label: 'Needs a price' },
];

/** Whether an item passes the status filter. */
export function matchesStatus(item: ItemResponse, filter: '' | StatusFilter): boolean {
  if (!filter) return true;
  if (filter === 'needs_price') return item.priceCents === null;
  return itemState(item).key === filter;
}

export function itemState(item: ItemResponse): {
  key: ItemStateKey;
  label: string;
  tone: string;
  title: string;
} {
  const qty = item.originalQuantity;
  // Only where there is something to count. Nearly every row is one item, and
  // "1 of 1" on all of them buries the rows that are not.
  const of = (n: number) => (qty > 1 ? ` · ${n} of ${qty}` : '');

  if (!item.consignedAt) {
    return {
      key: 'not_received',
      // Not "Awaiting scan" any more. A shop's uploaded inventory sits here too
      // and nobody is going to scan it — staff accept the boxes when they
      // arrive. The word has to be true for both.
      label: 'Not yet received',
      tone: 'bg-gray-700/50 text-gray-300',
      title: 'Staff have not accepted this item yet. It is not in Square and cannot sell.',
    };
  }

  // Accepted, but the push did not land — `finish()` counts these as
  // `squareFailures`. It cannot sell, and nothing on this screen said so.
  if (!item.squareSynced) {
    return {
      key: 'not_in_square',
      label: 'Not in Square',
      tone: 'bg-amber-900/40 text-amber-300',
      title: 'Accepted, but it never reached Square. It cannot sell until it does — re-push it from here.',
    };
  }

  // Square did not answer. The numbers below are the server's placeholder, not
  // a reading, and a Square outage used to show every item in the swap as sold.
  if (!item.inventoryKnown) {
    return {
      key: 'stock_unknown',
      label: 'Stock unknown',
      tone: 'bg-amber-900/40 text-amber-300',
      title: 'In Square, but Square could not be read just now. Whether it has sold is not known until it answers.',
    };
  }

  if (item.inStock > 0) {
    return {
      key: 'for_sale',
      label: `For sale${qty > 1 ? ` · ${item.inStock} of ${qty} left` : ''}`,
      tone: 'bg-green-900/40 text-green-400',
      title: 'In Square with stock on the floor.',
    };
  }

  return {
    key: 'sold',
    label: `Sold${of(item.soldCount)}`,
    tone: 'bg-blue-900/40 text-blue-300',
    title: 'In Square with nothing left.',
  };
}

export default function SwapItemsPanel({
  orgId, swapId, canManage, queryKeyPrefix, panelApi, selfService,
  showSearch = false, initialNeedsPrice = false, sellers, emptyMessage = 'No items found.', labelsPerItem = 1,
  tickets, actions = [], toolbarNote, addBlockedBecause,
}: SwapItemsPanelProps) {
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const [printFilter, setPrintFilter] = useState<'' | 'not_printed' | 'printed'>('');
  // The dashboard's "needs a price" link opens on that filter (Plan 32).
  const [stateFilter, setStateFilter] = useState<'' | StatusFilter>(initialNeedsPrice ? 'needs_price' : '');
  /** Only tickets still waiting for a price, to work through before sales start (Plan 32). */
  const [showForm, setShowForm] = useState(false);
  const [editItem, setEditItem] = useState<ItemResponse | null>(null);
  const [printingItem, setPrintingItem] = useState(false);
  const [showUnsupportedModal, setShowUnsupportedModal] = useState(false);
  const [pendingPhoto, setPendingPhoto] = useState<{ file: File; preview: string } | null>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);

  const { printItem } = usePrinter();
  const [form, setForm] = useState<ItemFormData>(emptyForm);

  const [sellerFilter, setSellerFilter] = useState('');

  // The box updates as it's typed in; the search waits for a pause, so a word
  // is one request rather than one per letter.
  const [searchTerm, setSearchTerm] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setSearchTerm(query.trim()), 250);
    return () => clearTimeout(timer);
  }, [query]);

  const queryKey = [queryKeyPrefix, orgId, swapId, searchTerm, sellerFilter];

  const { data, isLoading, isFetching } = useQuery({
    queryKey,
    // The last results stay up while the next load, so the table and its
    // search box stay on screen rather than giving way to "Loading…" each time.
    // Not across swaps: another swap's items aren't a stand-in for these.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[2] === swapId ? keepPreviousData(previous) : undefined,
    // Every page, not the first. The filters above the table are applied to
    // what came back, so a list cut off at the server's default of fifty was a
    // list that silently did not have the items a filter was looking for.
    queryFn: async () => {
      const PAGE = 200;
      const scope = {
        ...(searchTerm ? { query: searchTerm } : {}),
        ...(sellerFilter ? { sellerId: sellerFilter } : {}),
      };
      const first = await panelApi.fetchItems(swapId!, { ...scope, skip: 0, take: PAGE });
      const items = [...first.items];
      while (items.length < first.total) {
        const next = await panelApi.fetchItems(swapId!, { ...scope, skip: items.length, take: PAGE });
        if (!next.items.length) break;
        items.push(...next.items);
      }
      return { items, total: first.total };
    },
    enabled: !!swapId,
  });

  /** A delete or a print that was refused. Both used to fail without a word. */
  const [actionError, setActionError] = useState<string | null>(null);
  const describe = (err: unknown, fallback: string) =>
    err instanceof Error && err.message ? err.message : fallback;

  const createMutation = useMutation({
    mutationFn: () => panelApi.createItem(swapId!, {
      // Optional: an item nobody described is named by its number on the
      // server, `Item #<sku>`, and carries no answers.
      ...(form.describer.categoryId
        ? { categoryId: form.describer.categoryId, attributes: toAttributeInputs(form.describer) }
        : {}),
      description: form.description || undefined,
      // Blank only for a ticket, which the server prices later (Plan 32).
      priceCents: formPriceCents(form.priceDollars),
      quantity: 1,
      sellerId: form.sellerId || undefined,
      donateProceeds: form.donateProceeds,
      ...(tickets
        ? tickets.optional && !form.sku.trim() ? { generateSku: true } : { sku: form.sku.trim() }
        : {}),
    }),
    onSuccess: (item) => {
      // The suggestion is derived from the items, so it is stale the moment one
      // is saved — without this the next add would offer the number just used.
      tickets?.onUsed();
      if (pendingPhoto && panelApi.uploadPhoto) {
        uploadPhotoMutation.mutate(
          { itemId: item.id, file: pendingPhoto.file },
          {
            onSuccess: () => { qc.invalidateQueries({ queryKey }); closeForm(); },
            onError: (err: unknown) => {
              qc.invalidateQueries({ queryKey });
              setPhotoError((err as Error)?.message ?? 'Photo upload failed. Item was saved.');
            },
          },
        );
      } else {
        qc.invalidateQueries({ queryKey });
        closeForm();
      }
    },
  });

  const patchMutation = useMutation({
    mutationFn: () => panelApi.patchItem(editItem!.id, {
      ...(form.describer.categoryId
        ? {
            categoryId: form.describer.categoryId,
            attributes: toAttributeInputs(form.describer),
          }
        : {}),
      description: form.description || null,
      // A price can be set or changed, never cleared: blank sends none.
      priceCents: formPriceCents(form.priceDollars) ?? undefined,
      quantity: parseInt(form.quantity, 10),
      sellerId: sellers ? (form.sellerId || null) : undefined,
      donateProceeds: form.donateProceeds,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey }); closeForm(); },
  });

  const deleteMutation = useMutation({
    mutationFn: (itemId: string) => panelApi.deleteItem(itemId),
    onMutate: () => setActionError(null),
    onError: (err) => setActionError(describe(err, 'Could not delete that item')),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });

  const consignAll = useMutation({
    mutationFn: () => panelApi.consignAllForSeller!(swapId!, sellerFilter),
    // The rows are consigned before this answers, but their Square pushes are
    // still running behind it — so what comes back now will show some of them
    // as `Not in Square` until they land. Refetched again shortly after, which
    // is cheaper than making the operator wonder whether to press it twice.
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey });
      setTimeout(() => void qc.invalidateQueries({ queryKey }), 4000);
    },
  });

  const uploadPhotoMutation = useMutation({
    mutationFn: ({ itemId, file }: { itemId: string; file: File }) => panelApi.uploadPhoto!(itemId, file),
    onSuccess: () => qc.invalidateQueries({ queryKey }),
    onError: (err: unknown) => setPhotoError((err as Error)?.message ?? 'Photo upload failed'),
  });

  const deletePhotoMutation = useMutation({
    mutationFn: ({ itemId, photoId }: { itemId: string; photoId: string }) => panelApi.deletePhoto!(itemId, photoId),
    onSettled: () => qc.invalidateQueries({ queryKey }),
  });

  function openEdit(item: ItemResponse) {
    setEditItem(item);
    setForm({
      /**
       * Rebuilt from what the item stored, not from its name.
       *
       * An answer whose question the current tree no longer asks simply does not
       * come back, and saving drops it — the tree is the authority on what can be
       * said. An item with no category at all (one an importer created) opens with
       * the picker empty, and gets a description the first time anyone edits it.
       */
      describer: {
        categoryId: item.category?.id ?? null,
        answers: Object.fromEntries(
          item.attributes.map((a) => [
            a.attributeId,
            a.valueId
              ? { valueId: a.valueId }
              : { numberValue: a.numberValue !== null ? String(a.numberValue) : '' },
          ]),
        ),
      },
      description: item.description ?? '',
      // Empty for a ticket not yet priced, rather than "0.00".
      priceDollars: item.priceCents === null ? '' : (item.priceCents / 100).toFixed(2),
      quantity: String(item.originalQuantity),
      sellerId: item.seller?.id ?? '',
      // Carried so the shape is complete; editing never changes a ticket
      // number, because the ticket is physically on the goods.
      sku: item.sku,
      donateProceeds: item.donateProceeds,
    });
  }

  /**
   * Whether this item may go without a price: a legacy ticket (Plan 32). A new
   * one is a ticket unless the shop left the number blank to print a label.
   * One being edited may stay unpriced, but a price once set can't be cleared.
   */
  const priceOptional = editItem
    ? editItem.legacyTicket && editItem.priceCents === null
    : !!tickets && !(tickets.optional && !form.sku.trim());
  const missingFields = missingItemFields(form, { picksSeller: !!sellers, editing: !!editItem, priceOptional });

  function closeForm() {
    setPendingPhoto(null);
    setPhotoError(null);
    setShowForm(false);
    setEditItem(null);
    setForm(emptyForm);
    // A refusal belongs to the attempt it refused, not to the next form.
    createMutation.reset();
    patchMutation.reset();
  }

  async function handlePrint(item: ItemResponse) {
    if (!isWebBluetoothSupported()) { setShowUnsupportedModal(true); return; }
    setPrintingItem(true);
    setActionError(null);
    try {
      for (let i = 0; i < labelsPerItem; i++) {
        await printItem(item);
      }
      await panelApi.patchItem(item.id, { hasPrintedTag: true });
      qc.invalidateQueries({ queryKey });
    } catch (err: unknown) {
      // `NotFoundError` is the browser's picker being dismissed: nothing to say.
      if ((err as { name?: string })?.name !== 'NotFoundError') {
        console.error('Print failed:', err);
        setActionError(describe(err, 'Could not print the tag. Check the printer and try again.'));
      }
    } finally {
      setPrintingItem(false);
    }
  }

  const isFormOpen = showForm || editItem !== null;
  const items = (data?.items ?? [])
    .filter((i) => printFilter === 'printed' ? i.hasPrintedTag : printFilter === 'not_printed' ? !i.hasPrintedTag : true)
    // Through `itemState`, not through the underlying fields again: a filter
    // that decided for itself what "sold" meant could disagree with the column
    // beside it, and the column is the one that had to be corrected.
    .filter((i) => matchesStatus(i, stateFilter));
  const unpricedCount = (data?.items ?? []).filter((i) => i.priceCents === null).length;
  // Square didn't answer for some of what's in it: those rows can't be called
  // for sale or sold until it does.
  const stockUnknown = (data?.items ?? []).filter((i) => itemState(i).key === 'stock_unknown').length;

  /*
   * Everything the toolbar can do, in one menu (the toolbar itself is for
   * finding things). Add first; then the page's own; then accepting a seller's
   * waiting items, offered only with that seller chosen and something waiting.
   */
  const sellerName = sellers?.find((sl) => sl.id === sellerFilter)?.displayName ?? 'this seller';
  const waitingHere = (data?.items ?? []).filter((i) => !i.consignedAt).length;
  const menu: MenuAction[] = [
    ...(canManage
      ? [{
          key: 'add',
          label: tickets && !tickets.optional ? 'Describe a ticket' : 'Add item',
          disabledReason: addBlockedBecause,
          onSelect: () => {
            setShowForm(true);
            setEditItem(null);
            // Pre-filled with the lowest ticket nobody has described yet.
            setForm({ ...emptyForm, sku: tickets?.suggested != null ? String(tickets.suggested) : '' });
          },
        }]
      : []),
    ...actions,
    ...(sellerFilter && panelApi.consignAllForSeller && waitingHere > 0 && !consignAll.data
      ? [{
          key: 'accept',
          label: consignAll.isPending ? 'Accepting…' : `Accept ${sellerName}’s items`,
          disabledReason: consignAll.isPending ? 'Working on it.' : undefined,
          onSelect: () => {
            // Says the reach before it does anything: all of what? Every one
            // this seller is waiting on, not just the rows on this page.
            if (confirm(
              `Accept everything ${sellerName} is still waiting on?\n\n` +
              'This puts their items in Square and they go on sale. It applies to ' +
              `all of their waiting items, not just the ones on this page.`,
            )) consignAll.mutate();
          },
        }]
      : []),
  ];

  if (!swapId) return null;
  if (isLoading) return <p className="text-gray-400 text-sm">Loading…</p>;

  return (
    <div className="space-y-4">
      {actionError && (
        <p className="text-sm text-red-400 bg-red-900/20 border border-red-900/50 rounded px-3 py-2">
          {actionError}
        </p>
      )}
      {/* Toolbar */}
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex flex-wrap gap-2 items-center">
          {showSearch && (
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, SKU, seller…"
              aria-busy={isFetching}
              className={`bg-surface-50 border border-gray-700 rounded px-3 py-1.5 text-sm text-white w-72 ${isFetching ? 'opacity-70' : ''}`}
            />
          )}
          <select
            value={stateFilter}
            onChange={(e) => setStateFilter(e.target.value as '' | StatusFilter)}
            aria-label="Filter by status"
            className="bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
          >
            <option value="">All statuses</option>
            {ITEM_STATE_FILTERS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}{o.value === 'needs_price' && unpricedCount > 0 ? ` (${unpricedCount})` : ''}
              </option>
            ))}
          </select>
          {sellers && (
            <select
              value={sellerFilter}
              onChange={(e) => setSellerFilter(e.target.value)}
              aria-label="Filter by seller"
              className="bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white max-w-52"
            >
              <option value="">All sellers</option>
              {sellers.map((sl) => (
                <option key={sl.id} value={sl.id}>{sl.displayName}</option>
              ))}
            </select>
          )}
          <select
            value={printFilter}
            onChange={(e) => setPrintFilter(e.target.value as '' | 'not_printed' | 'printed')}
            className="bg-surface-50 border border-gray-700 rounded px-2 py-1.5 text-sm text-white"
          >
            <option value="">All tags</option>
            <option value="not_printed">Not printed</option>
            <option value="printed">Printed</option>
          </select>
          <ActionsMenu actions={menu} />
        </div>
        {toolbarNote}
      </div>

      {consignAll.data && (
        <p className="text-sm text-gray-400">
          {consignAll.data.consigned === 0
            ? 'Nothing was waiting.'
            : `Accepted ${consignAll.data.consigned} item${consignAll.data.consigned === 1 ? '' : 's'}. They appear in Square shortly.`}
        </p>
      )}
      {!!consignAll.error && (
        <p className="text-sm text-red-400">
          {/* `Error`, not `ApiError`: this panel takes its calls as a prop and
              has no business knowing which client made them. ApiError extends
              Error, so the server's sentence still comes through. */}
          {consignAll.error instanceof Error ? consignAll.error.message : 'Could not accept them'}
        </p>
      )}

      {stockUnknown > 0 && (
        <p className="text-xs text-amber-400">
          Square didn’t answer just now, so {stockUnknown} item{stockUnknown === 1 ? '' : 's'} show
          {stockUnknown === 1 ? 's' : ''} “Stock unknown” and won’t appear under For sale or Sold until it does.
        </p>
      )}

      {/* Items table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-gray-400 text-left border-b border-gray-800">
              <th className="pb-2 pr-4">SKU</th>
              <th className="pb-2 pr-4">Name</th>
              <th className="pb-2 pr-4">Price</th>
              {sellers && <th className="pb-2 pr-4">Seller</th>}
              <th className="pb-2 pr-4">Status</th>
              <th className="pb-2 pr-4" title="Tag printed"><FontAwesomeIcon icon={faTagDuo} /></th>
              {canManage && <th className="pb-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr><td colSpan={sellers ? 7 : 6} className="py-6 text-center text-gray-500 text-sm">{emptyMessage}</td></tr>
            )}
            {items.map((item) => (
              <tr key={item.id} className="border-b border-gray-900 hover:bg-surface-50">
                <td className="py-2 pr-4 font-mono text-gray-400 text-xs">{item.sku}</td>
                <td className="py-2 pr-4 text-white">
                  {item.name}
                  {item.donateProceeds && <span className="ml-1.5 text-xs" title="Donating proceeds to ski patrol">❤️</span>}
                </td>
                <td className="py-2 pr-4 text-gray-300">
                  {item.priceCents === null
                    ? <span className="text-amber-400" title="Checked in without a price. Price it before sales start.">No price</span>
                    : `$${(item.priceCents / 100).toFixed(2)}`}
                </td>
                {sellers && <td className="py-2 pr-4 text-gray-400">{item.seller?.displayName ?? '—'}</td>}
                <td className="py-2 pr-4">
                  {(() => {
                    const st = itemState(item);
                    return (
                      <span
                        title={st.title}
                        className={`inline-block px-2 py-0.5 rounded text-xs font-medium whitespace-nowrap ${st.tone}`}
                      >
                        {st.label}
                      </span>
                    );
                  })()}
                </td>
                <td className="py-2 pr-4">
                  {item.hasPrintedTag
                    ? <FontAwesomeIcon icon={faTagDuo} className="text-green-500" title="Printed" />
                    : <FontAwesomeIcon icon={faTagDuo} className="text-amber-400" title="Not printed" />}
                </td>
                {canManage && (
                  <td className="py-2 flex gap-2 items-center">
                    {selfService && item.consignedAt ? (
                      // Accepted items are changed at the counter, like delete below.
                      <span
                        className="text-xs text-gray-600 cursor-not-allowed"
                        title="This item has been accepted for sale. Ask at the counter to change it."
                      >Edit</span>
                    ) : (
                      <button onClick={() => openEdit(item)} className="text-xs text-brand-500 hover:underline">Edit</button>
                    )}
                    {selfService && item.consignedAt ? (
                      // Said rather than hidden. A button that quietly vanishes
                      // once an item is accepted reads as a bug; this reads as
                      // a rule.
                      <span
                        className="text-xs text-gray-600 cursor-not-allowed"
                        title="This item has been accepted for sale. Ask at the counter to withdraw it."
                      >Delete</span>
                    ) : (
                      <button
                        onClick={() => { if (confirm(`Delete "${item.name}"?`)) deleteMutation.mutate(item.id); }}
                        className="text-xs text-red-500 hover:underline"
                      >Delete</button>
                    )}
                    {/* Decided per item, not per seller (Plan 31): a seller on
                        issued tickets may also have items with generated SKUs.
                        An item on a ticket has its tag on the goods already,
                        out of a box, so there is nothing a printer could
                        produce; every other item can be printed. */}
                    {item.legacyTicket ? null : item.hasPrintedTag ? (
                      <button
                        onClick={() => handlePrint(item)}
                        disabled={printingItem}
                        className="text-xs text-gray-400 hover:text-white flex items-center gap-1 disabled:opacity-40"
                        title="Reprint tag"
                      >
                        <FontAwesomeIcon icon={faRotateRightDuo} /> Reprint
                      </button>
                    ) : (
                      <button
                        onClick={() => handlePrint(item)}
                        disabled={printingItem}
                        className="text-xs text-brand-400 hover:text-brand-300 flex items-center gap-1 disabled:opacity-40"
                        title="Print tag"
                      >
                        <FontAwesomeIcon icon={faPrintDuo} /> Label
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add / Edit modal */}
      {isFormOpen && canManage && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          {/*
            A capped column, not a box that grows.

            Describing a bike asks ten questions, which is taller than a laptop
            viewport — and a centred child that outgrows its container has its
            top pushed above the top of the screen, where nothing can scroll to
            reach it. So the height is capped and only the fields scroll.
            `min-h-0` on that middle region is what makes the scrolling work at
            all: a flex child defaults to min-height:auto and refuses to shrink
            below its content, so `overflow-y-auto` never engages without it.

            Keeping the buttons out of the scroll region is the other half —
            Save should not be something you have to go looking for.
          */}
          <form
            className="bg-surface-200 rounded-lg w-full max-w-md flex flex-col max-h-[calc(100vh-2rem)]"
            onSubmit={(e) => {
              e.preventDefault();
              if (missingFields.length > 0) return;
              if (editItem) patchMutation.mutate(); else createMutation.mutate();
            }}
          >
            <h2 className="text-white font-semibold px-6 pt-6 pb-4 shrink-0">{editItem ? 'Edit Item' : 'Add Item'}</h2>

            <div className="flex-1 min-h-0 overflow-y-auto px-6 pb-4 space-y-4">

            {tickets && !editItem && (
              <label className="block">
                <span className="block text-xs text-gray-400 mb-1">Ticket number</span>
                <input
                  autoFocus
                  value={form.sku}
                  onChange={(e) => setForm({ ...form, sku: e.target.value })}
                  // Selected rather than locked: the common case is accepting
                  // the suggestion, but a ticket found later has to be typeable.
                  onFocus={(e) => e.currentTarget.select()}
                  inputMode="numeric"
                  placeholder="e.g. 67169"
                  className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white font-mono"
                />
                <span className="block text-xs text-gray-500 mt-1">
                  {/* Issued tickets already exist (Plan 38): this describes one,
                      once. Staff change it after that. */}
                  {tickets.suggested !== null
                    ? `Your next ticket to describe, from ${describeRanges(tickets.ranges)}. Type another number to describe that one instead. Each ticket can be described once; after that, ask the swap’s staff.`
                    : `All of your tickets (${describeRanges(tickets.ranges)}) are described. Ask the swap’s staff to change one.`}
                  {tickets.optional && ' Leave blank to print a label instead.'}
                </span>
              </label>
            )}

            <ItemDescriber
              orgId={orgId}
              value={form.describer}
              onChange={(describer) => setForm({ ...form, describer })}
              // Wider screen, so every question shows rather than the tail of
              // them collapsing behind "More detail".
              layout="grid"
              renderPreview={(name, { parts }) =>
                name ? <NamePreview name={name} parts={parts} /> : null
              }
            />
            <textarea
              value={form.description}
              onChange={(e) => setForm({ ...form, description: e.target.value })}
              placeholder="Notes (optional)"
              rows={2}
              className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white resize-none"
            />
            {editItem ? (
              <div className="grid grid-cols-2 gap-3">
                <input
                  required={!priceOptional}
                  inputMode="decimal"
                  value={form.priceDollars}
                  onChange={(e) => {
                    setForm({ ...form, priceDollars: priceInput(e.target.value) });
                  }}
                  placeholder={priceOptional ? 'Price ($), or blank for later' : 'Price ($)'}
                  className="bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                />
                <input
                  required
                  type="number"
                  min="1"
                  value={form.quantity}
                  onChange={(e) => setForm({ ...form, quantity: e.target.value })}
                  placeholder="Quantity"
                  className="bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
                />
              </div>
            ) : (
              <input
                required={!priceOptional}
                inputMode="decimal"
                value={form.priceDollars}
                onChange={(e) => {
                  const val = e.target.value.replace(/[^0-9.]/g, '').replace(/(\..*?)\./g, '$1');
                  setForm({ ...form, priceDollars: val });
                }}
                placeholder={priceOptional ? 'Price ($), or leave blank to price it later' : 'Price ($)'}
                className="w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white"
              />
            )}

            {sellers && (
              <SearchableSelect
                value={form.sellerId}
                onChange={(v) => setForm({ ...form, sellerId: v })}
                options={sellers.map((s) => ({ value: s.id, label: s.displayName, sublabel: s.phone ?? '', keywords: s.email ?? '' }))}
                placeholder="Choose a seller"
                clearLabel="Choose a seller"
                emptyMessage="No sellers match."
              />
            )}

            <label className="flex items-center gap-2 text-sm cursor-pointer select-none">
              <input
                type="checkbox"
                checked={form.donateProceeds}
                onChange={(e) => setForm({ ...form, donateProceeds: e.target.checked })}
                className="accent-brand-600"
              />
              <span className="text-gray-300">❤️ Donate proceeds to ski patrol</span>
            </label>

            {/* Photo — pending upload for new items */}
            {!editItem && panelApi.uploadPhoto && (
              <div className="space-y-2 pt-1 border-t border-gray-700">
                <p className="text-xs text-gray-400">Photo (optional)</p>
                {pendingPhoto ? (
                  <div className="flex items-center gap-3">
                    <img src={pendingPhoto.preview} className="w-16 h-16 object-cover rounded" alt="" />
                    <button
                      type="button"
                      onClick={() => setPendingPhoto(null)}
                      className="text-xs text-red-400 hover:text-red-300"
                    >Remove</button>
                  </div>
                ) : (
                  <label className="flex items-center gap-2 cursor-pointer text-sm text-gray-400 hover:text-white">
                    <span className="bg-surface-100 border border-gray-700 rounded px-3 py-1.5 text-xs">Choose image…</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="sr-only"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) {
                          const reader = new FileReader();
                          reader.onload = (ev) => setPendingPhoto({ file: f, preview: ev.target!.result as string });
                          reader.readAsDataURL(f);
                        }
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
              </div>
            )}

            {/* Photos — edit mode: view, add, delete */}
            {editItem && panelApi.uploadPhoto && panelApi.deletePhoto && (
              <div className="space-y-2 pt-1 border-t border-gray-700">
                <p className="text-xs text-gray-400">Photos</p>
                <div className="flex flex-wrap gap-2">
                  {editItem.photos.map((p) => (
                    <div key={p.id} className="relative">
                      <img src={p.url} className="w-16 h-16 object-cover rounded" alt="" />
                      <button
                        type="button"
                        className="absolute -top-1 -right-1 bg-red-600 text-white rounded-full w-4 h-4 text-xs flex items-center justify-center"
                        onClick={() => deletePhotoMutation.mutate({ itemId: editItem.id, photoId: p.id })}
                      >×</button>
                    </div>
                  ))}
                </div>
                <input
                  type="file"
                  accept="image/*"
                  className="text-xs text-gray-400"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadPhotoMutation.mutate({ itemId: editItem.id, file: f });
                    e.target.value = '';
                  }}
                />
              </div>
            )}

            {photoError && (
              <p className="text-xs text-red-400 pt-1">{photoError}</p>
            )}

            {/* The server's refusal, where the person who has to fix it is
                looking. A price of nothing, or a ticket already on another
                item, used to leave the form open and silent. */}
            {(createMutation.error || patchMutation.error) && (
              <p className="text-sm text-red-400 bg-red-900/20 border border-red-900/50 rounded px-3 py-2">
                {describe(createMutation.error ?? patchMutation.error, editItem ? 'Could not save the item' : 'Could not add the item')}
              </p>
            )}

            </div>

            <div className="px-6 py-4 shrink-0 border-t border-gray-700 space-y-2">
              {missingFields.length > 0 && (
                <p className="text-xs text-gray-400">Still needed: {missingFields.join(', ')}.</p>
              )}
            <div className="flex gap-2">
              <button
                type="submit"
                disabled={missingFields.length > 0 || createMutation.isPending || patchMutation.isPending || uploadPhotoMutation.isPending}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded py-1.5 disabled:opacity-40"
              >
                {editItem ? 'Save' : 'Add'}
              </button>
              <button type="button" onClick={closeForm} className="flex-1 bg-surface-100 text-gray-300 text-sm rounded py-1.5">
                Cancel
              </button>
            </div>
            </div>
          </form>
        </div>
      )}

      {/* Printer selector modal */}
      {/* (removed — browser picker handles selection via PrinterContext) */}

      {/* Unsupported browser modal */}
      {showUnsupportedModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-surface-200 rounded-lg p-6 w-full max-w-sm space-y-4">
            <h2 className="text-white font-semibold flex items-center gap-2">
              <FontAwesomeIcon icon={faTriangleExclamationDuo} className="text-amber-400" /> Printing Not Available
            </h2>
            <p className="text-gray-400 text-sm">
              Price tag printing requires <strong className="text-white">Chrome</strong> or{' '}
              <strong className="text-white">Edge</strong>. Firefox and Safari do not support
              WebBluetooth.
            </p>
            <button
              onClick={() => setShowUnsupportedModal(false)}
              className="w-full bg-surface-100 text-gray-300 text-sm rounded py-1.5"
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
