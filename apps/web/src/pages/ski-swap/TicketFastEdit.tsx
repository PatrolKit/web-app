import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { priceInput, priceInputCents } from '../../lib/money';
import type { ResolvedTaxonomy, UnpricedTicket } from '../../lib/api.types';
import {
  acceptSuggestion, describeParsed, detailsSuggestions, fastEditKey, parseDetails,
  type DetailsSuggestion, type Field, type ParsedDetails,
} from './fastEditLogic';

interface Saved {
  sku: string;
  name: string;
  priceCents: number;
}

interface Message {
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

function idempotencyKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Legacy ticket fast edit (Plan 37): a stack of stubs priced from the keyboard.
 *
 * SKU, Details and Price on one row. Tab moves along it, Enter in Price saves,
 * and the form clears back to SKU for the next stub. Only tickets with no price
 * can be loaded, and a save never overwrites a price set meanwhile.
 */
export default function TicketFastEdit({ orgId, swapId, onClose }: {
  orgId: string;
  swapId: string;
  onClose: () => void;
}) {
  const skuRef = useRef<HTMLInputElement>(null);
  const detailsRef = useRef<HTMLInputElement>(null);
  const priceRef = useRef<HTMLInputElement>(null);

  const { data: fetched, isLoading: ticketsLoading } = useQuery({
    queryKey: ['ski-swap/unpriced-tickets', orgId, swapId],
    queryFn: () => api.skiSwap.unpricedTickets(orgId, swapId),
    staleTime: 0,
  });
  const { data: taxonomy } = useQuery<ResolvedTaxonomy>({
    queryKey: ['taxonomy', orgId, 'full'],
    queryFn: () => api.skiSwap.taxonomyFull(orgId),
    staleTime: 5 * 60_000,
  });

  /** Fetched once on open, then kept here: a saved ticket leaves at once. */
  const [tickets, setTickets] = useState<UnpricedTicket[]>([]);
  useEffect(() => { if (fetched) setTickets(fetched); }, [fetched]);

  const [field, setField] = useState<Field>('sku');
  const [skuText, setSkuText] = useState('');
  const [ticket, setTicket] = useState<UnpricedTicket | null>(null);
  const [details, setDetails] = useState('');
  const [prefill, setPrefill] = useState('');
  const [cursor, setCursor] = useState(0);
  const [impliedCategoryId, setImpliedCategoryId] = useState<string | null>(null);
  const [priceText, setPriceText] = useState('');
  const [highlighted, setHighlighted] = useState(-1);
  const [arrowed, setArrowed] = useState(false);
  const [closed, setClosed] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  /** Saves still on their way, and how the last one went (apart from `message`, which is the stub being typed). */
  const [inFlight, setInFlight] = useState(0);
  const [lastSave, setLastSave] = useState<Message | null>(null);
  /** Exit waits for saves still on their way, so the Items list refreshes with them. */
  const [exiting, setExiting] = useState(false);
  useEffect(() => { if (exiting && inFlight === 0) onClose(); }, [exiting, inFlight, onClose]);
  const exit = () => setExiting(true);
  const [saved, setSaved] = useState<Saved[]>([]);

  /*
   * Focus and the cursor move once React has rendered, not a frame later:
   * Details and Price are disabled until a ticket loads, so focusing them has
   * to wait for that render, and a typist's next key mustn't beat it there.
   */
  const [pendingFocus, setPendingFocus] = useState<Field | null>('sku');
  const [pendingCursor, setPendingCursor] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (pendingFocus) {
      ({ sku: skuRef, details: detailsRef, price: priceRef })[pendingFocus].current?.focus();
      setPendingFocus(null);
    }
    if (pendingCursor !== null) {
      detailsRef.current?.setSelectionRange(pendingCursor, pendingCursor);
      setPendingCursor(null);
    }
  }, [pendingFocus, pendingCursor]);

  function focus(f: Field) {
    setField(f);
    setHighlighted(-1);
    setArrowed(false);
    setClosed(false);
    setPendingFocus(f);
  }

  // ─── Suggestions ────────────────────────────────────────────────────────────

  const skuSuggestions = useMemo(() => {
    const typed = skuText.trim();
    if (!typed || (ticket && ticket.sku === typed)) return [];
    return tickets.filter((t) => t.sku.startsWith(typed)).slice(0, 8);
  }, [skuText, ticket, tickets]);

  const detailSuggestions: DetailsSuggestion[] = useMemo(
    () => (taxonomy ? detailsSuggestions(details, cursor, taxonomy, impliedCategoryId) : []),
    [details, cursor, taxonomy, impliedCategoryId],
  );

  const shown = closed ? 0 : field === 'sku' ? skuSuggestions.length : field === 'details' ? detailSuggestions.length : 0;
  // Details offers its first suggestion for Enter; SKU waits for the arrows.
  const effectiveHighlight = highlighted >= 0 ? highlighted : field === 'details' && shown > 0 ? 0 : -1;

  // ─── What will be saved ─────────────────────────────────────────────────────

  const detailsChanged = details.trim() !== '' && details.trim() !== prefill.trim();
  const parsed: ParsedDetails | null = detailsChanged && taxonomy ? parseDetails(details, taxonomy, impliedCategoryId) : null;
  const priceCents = priceInputCents(priceText);
  const priceValid = priceCents !== null && priceCents > 0;
  const exact = tickets.find((t) => t.sku === skuText.trim()) ?? null;
  const empty = !skuText && !details && !priceText && !ticket;

  function load(t: UnpricedTicket) {
    setTicket(t);
    setSkuText(t.sku);
    const shownName = t.placeholderName ? '' : t.name;
    setDetails(shownName);
    setPrefill(shownName);
    setCursor(shownName.length);
    setImpliedCategoryId(null);
    setMessage(null);
    focus('details');
    // Nothing to suggest for a description nobody has started typing.
    setClosed(true);
  }

  function clearTicket(msg: Message | null = null) {
    setTicket(null);
    setSkuText('');
    setDetails('');
    setPrefill('');
    setCursor(0);
    setImpliedCategoryId(null);
    setPriceText('');
    setMessage(msg);
    focus('sku');
  }

  /** Says why a typed SKU can't be loaded (D1), from the item it names, if any. */
  async function refuseSku() {
    const typed = skuText.trim();
    if (!typed) {
      setMessage({ tone: 'error', text: 'Type a ticket number.' });
      return;
    }
    try {
      const item = await api.skiSwap.findItemBySku(orgId, swapId, typed);
      if (!item.legacyTicket) setMessage({ tone: 'error', text: `${typed} isn’t a legacy ticket.` });
      else if (item.priceCents !== null) setMessage({ tone: 'error', text: `${typed} already has a price (${money(item.priceCents)}).` });
      else {
        // Unpriced, but not in the list fetched on open: checked in since.
        load({ id: item.id, sku: item.sku, name: item.name, placeholderName: item.name === `Item #${item.sku}`,
          categoryId: item.category?.id ?? null, sellerName: null });
      }
    } catch (err) {
      setMessage({
        tone: 'error',
        text: err instanceof ApiError && err.status === 404 ? `${typed} isn’t checked in to this swap.` : 'Could not look that ticket up.',
      });
    }
  }

  function accept(s: DetailsSuggestion) {
    const next = acceptSuggestion(details, cursor, s.label);
    setDetails(next.text);
    setCursor(next.cursor);
    // A value picked before any category brings its category (D3).
    if (s.kind === 'value' && !parseDetails(details, taxonomy!, null)?.categoryId) setImpliedCategoryId(s.categoryId);
    if (s.kind === 'category') setImpliedCategoryId(null);
    setHighlighted(-1);
    setArrowed(false);
    setClosed(true);
    setPendingCursor(next.cursor);
  }

  /**
   * Saves in the background: the form clears the moment Enter is pressed, so
   * the next stub can be typed while this one is on its way. How it went is
   * said on its own line, apart from anything about the stub being typed. A
   * save that fails puts its ticket back in the suggestions to enter again.
   */
  function save() {
    if (!ticket || !priceValid) return;
    if (detailsChanged && !taxonomy) {
      setMessage({ tone: 'warn', text: 'Still loading the item types. Try again in a moment.' });
      return;
    }
    // Only the price, and the description if it changed (D7).
    const description = parsed
      ? parsed.categoryId
        ? { categoryId: parsed.categoryId, attributes: parsed.attributes, name: parsed.name }
        : { name: parsed.name }
      : {};
    const sent = ticket;
    const cents = priceCents!;
    setTickets((ts) => ts.filter((t) => t.id !== sent.id));
    setInFlight((n) => n + 1);
    clearTicket();
    api.skiSwap.patchItem(orgId, swapId, sent.id, { priceCents: cents, ifUnpriced: true, ...description }, idempotencyKey())
      .then((item) => {
        setSaved((s) => [{ sku: item.sku, name: item.name, priceCents: item.priceCents ?? cents }, ...s]);
        const offSquare = item.consignedAt !== null && !item.squareSynced;
        setLastSave({
          tone: offSquare ? 'warn' : 'ok',
          text: `Saved ${item.sku} · ${item.name} · ${money(item.priceCents ?? cents)}`
            + (offSquare ? '. Square didn’t take it; re-push it from Items.' : ''),
        });
      })
      .catch((err: unknown) => {
        // Priced elsewhere meanwhile: no longer one to fast edit. Anything
        // else goes back, to be entered again.
        const priced = err instanceof ApiError && err.code === 'TICKET_PRICED';
        if (!priced) setTickets((ts) => [...ts, sent].sort((a, b) => Number(a.sku) - Number(b.sku)));
        setLastSave({
          tone: 'error',
          text: `${sent.sku} wasn’t saved: ${err instanceof ApiError ? err.message : 'the request failed'}`
            + (priced ? '' : ' Enter it again.'),
        });
      })
      .finally(() => setInFlight((n) => n - 1));
  }

  // ─── Keys (D5) ──────────────────────────────────────────────────────────────

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>, f: Field) {
    const action = fastEditKey({
      field: f,
      key: e.key,
      shift: e.shiftKey,
      suggestionsOpen: shown > 0,
      highlighted: effectiveHighlight,
      arrowed,
      skuExact: !!exact,
      loaded: !!ticket && ticket.sku === skuText.trim(),
      priceValid,
      empty,
    });
    if (action.do === 'default') return;
    e.preventDefault();
    switch (action.do) {
      case 'highlight': {
        const next = effectiveHighlight + action.by;
        setHighlighted(Math.max(0, Math.min(shown - 1, next)));
        setArrowed(true);
        return;
      }
      case 'loadExact': return load(exact!);
      case 'loadHighlighted': return load(skuSuggestions[effectiveHighlight]);
      case 'refuseSku': return void refuseSku();
      case 'accept': {
        accept(detailSuggestions[effectiveHighlight]);
        if (action.then === 'price') focus('price');
        return;
      }
      case 'focus': return focus(action.field);
      case 'save': return save();
      case 'needPrice': return setMessage({ tone: 'error', text: 'Type a price above $0.00.' });
      case 'closeSuggestions': return setClosed(true);
      case 'clearTicket': return clearTicket();
      case 'exit': return exit();
      case 'none': return;
    }
  }

  function onSkuChange(value: string) {
    const typed = value.replace(/\s/g, '');
    setSkuText(typed);
    setHighlighted(-1);
    setArrowed(false);
    setClosed(false);
    setMessage(null);
    // A different number is a different stub: start it over.
    if (ticket && typed !== ticket.sku) {
      setTicket(null);
      setDetails('');
      setPrefill('');
      setImpliedCategoryId(null);
      setPriceText('');
    }
  }

  const left = tickets.length;
  const inputClass = 'w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-600';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center p-4 pt-[10vh] z-50">
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Fast edit tickets"
        // Escape from anywhere that isn't a field (the fields have their own).
        onKeyDown={(e) => { if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) exit(); }}
        className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-3xl p-5 space-y-4"
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h3 className="text-white font-medium">Fast Edit Tickets</h3>
            <p className="text-gray-500 text-xs mt-0.5">
              SKU, Tab, details, Tab, price, Enter. Escape clears the ticket.
            </p>
          </div>
          <button
            type="button"
            onClick={exit}
            disabled={exiting}
            className="shrink-0 bg-surface-100 hover:bg-surface-200 text-gray-200 px-3 py-1.5 rounded text-sm disabled:opacity-60"
          >
            {exiting ? 'Finishing…' : 'Exit'}
          </button>
        </div>

        <div className="grid grid-cols-[9rem_1fr_7rem] gap-2 items-start">
          <Field label="SKU">
            <input
              ref={skuRef}
              value={skuText}
              onChange={(e) => onSkuChange(e.target.value)}
              onKeyDown={(e) => onKeyDown(e, 'sku')}
              onFocus={() => setField('sku')}
              inputMode="numeric"
              autoComplete="off"
              aria-label="SKU"
              placeholder={ticketsLoading ? 'Loading…' : 'Ticket number'}
              className={`${inputClass} font-mono`}
            />
            {field === 'sku' && shown > 0 && (
              <Suggestions
                rows={skuSuggestions.map((t) => ({
                  key: t.id, label: t.sku, sublabel: [t.sellerName, t.placeholderName ? null : t.name].filter(Boolean).join(' · '),
                }))}
                highlighted={arrowed ? effectiveHighlight : -1}
                onPick={(i) => load(skuSuggestions[i])}
              />
            )}
          </Field>

          <Field label="Details">
            <input
              ref={detailsRef}
              value={details}
              onChange={(e) => {
                setDetails(e.target.value);
                setCursor(e.target.selectionStart ?? e.target.value.length);
                setHighlighted(-1);
                setArrowed(false);
                setClosed(false);
                if (!e.target.value.trim()) setImpliedCategoryId(null);
              }}
              onSelect={(e) => setCursor(e.currentTarget.selectionStart ?? 0)}
              onKeyDown={(e) => onKeyDown(e, 'details')}
              onFocus={() => setField('details')}
              disabled={!ticket}
              autoComplete="off"
              aria-label="Details"
              placeholder="e.g. Rossignol red skis 170"
              className={`${inputClass} disabled:opacity-50`}
            />
            {field === 'details' && shown > 0 && (
              <Suggestions
                rows={detailSuggestions.map((s) => ({ key: s.key, label: s.label, sublabel: s.sublabel }))}
                highlighted={effectiveHighlight}
                onPick={(i) => { accept(detailSuggestions[i]); detailsRef.current?.focus(); }}
              />
            )}
          </Field>

          <Field label="Price">
            <input
              ref={priceRef}
              value={priceText}
              onChange={(e) => { setPriceText(priceInput(e.target.value)); setMessage(null); }}
              onKeyDown={(e) => onKeyDown(e, 'price')}
              onFocus={() => setField('price')}
              disabled={!ticket}
              inputMode="decimal"
              autoComplete="off"
              aria-label="Price"
              placeholder="$"
              className={`${inputClass} text-right disabled:opacity-50`}
            />
          </Field>
        </div>

        <div className="min-h-[3.5rem] space-y-1 text-sm">
          {ticket && (
            <p className="text-gray-400">
              <span className="font-mono text-white">{ticket.sku}</span>
              {ticket.sellerName && <> · {ticket.sellerName}</>}
              {' · now '}<span className="text-gray-300">{ticket.name}</span>
            </p>
          )}
          {parsed && taxonomy && (
            <p className="text-gray-400">
              Saves as <span className="text-gray-200">{parsed.name}</span>
              <span className="text-gray-500"> ({describeParsed(parsed, taxonomy)})</span>
            </p>
          )}
          {message && (
            <p className={message.tone === 'ok' ? 'text-green-400' : message.tone === 'warn' ? 'text-amber-400' : 'text-red-400'}>
              {message.text}
            </p>
          )}
          {lastSave && (
            <p className={lastSave.tone === 'ok' ? 'text-green-400' : lastSave.tone === 'warn' ? 'text-amber-400' : 'text-red-400'}>
              {lastSave.text}
            </p>
          )}
          {inFlight > 0 && <p className="text-gray-500">Saving {inFlight}…</p>}
        </div>

        <div className="border-t border-gray-700 pt-3">
          <p className="text-gray-400 text-xs">
            {saved.length} priced · {ticketsLoading ? '…' : left} left
          </p>
          {saved.length > 0 && (
            <ul className="mt-2 max-h-40 overflow-y-auto space-y-0.5">
              {saved.map((s, i) => (
                <li key={`${s.sku}-${i}`} className="flex justify-between gap-3 text-xs text-gray-300">
                  <span className="truncate"><span className="font-mono">{s.sku}</span> · {s.name}</span>
                  <span className="shrink-0">{money(s.priceCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="relative">
      <span className="block text-gray-400 text-xs uppercase mb-1">{label}</span>
      {children}
    </div>
  );
}

function Suggestions({ rows, highlighted, onPick }: {
  rows: { key: string; label: string; sublabel: string }[];
  highlighted: number;
  onPick: (index: number) => void;
}) {
  return (
    <ul role="listbox" className="absolute z-10 left-0 right-0 mt-1 bg-surface-100 border border-gray-700 rounded shadow-lg overflow-hidden">
      {rows.map((r, i) => (
        <li
          key={r.key}
          role="option"
          aria-selected={i === highlighted}
          // Picked on mouse down, before the field loses focus.
          onMouseDown={(e) => { e.preventDefault(); onPick(i); }}
          className={`px-3 py-1.5 cursor-pointer text-sm ${i === highlighted ? 'bg-brand-600 text-white' : 'text-gray-200 hover:bg-surface-200'}`}
        >
          <span>{r.label}</span>
          {r.sublabel && <span className={`ml-2 text-xs ${i === highlighted ? 'text-white/80' : 'text-gray-500'}`}>{r.sublabel}</span>}
        </li>
      ))}
    </ul>
  );
}
