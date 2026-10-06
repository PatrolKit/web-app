import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faCircleCheck as faCircleCheckDuo, faCircleXmark as faCircleXmarkDuo,
  faKeyboard as faKeyboardDuo, faTriangleExclamation as faTriangleExclamationDuo,
} from '@fortawesome/pro-duotone-svg-icons';
import { api, ApiError } from '../../lib/api';
import { priceInputCents } from '../../lib/money';
import type { ResolvedTaxonomy, UnpricedTicket } from '../../lib/api.types';
import {
  acceptSuggestion, describeParsed, detailsSuggestions, fastEditKey, nextSku, parseDetails,
  type DetailsSuggestion, type Field, type ParsedDetails,
} from './fastEditLogic';

/** The two switches, kept per browser: how one person likes to work through a stack. */
type Switch = 'autoIncrement' | 'skipDetails';

function useSwitch(name: Switch): [boolean, (on: boolean) => void] {
  const key = `fastEdit.${name}`;
  const [on, setOn] = useState(() => {
    try { return localStorage.getItem(key) === '1'; } catch { return false; }
  });
  const set = (next: boolean) => {
    setOn(next);
    try { localStorage.setItem(key, next ? '1' : '0'); } catch { /* still on for this visit */ }
  };
  return [on, set];
}

interface Saved {
  sku: string;
  name: string;
  priceCents: number;
  sellerName: string | null;
  /** Saved, but Square didn't take it: re-pushed from Items. */
  offSquare: boolean;
}

interface Message {
  tone: 'ok' | 'warn' | 'error';
  text: string;
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

/** "Rossignol Skis · $120.00 · Alpine Sports": a ticket as it now stands. */
const standing = (t: { name: string; priceCents: number | null; sellerName: string | null }) =>
  [t.name, t.priceCents !== null ? money(t.priceCents) : null, t.sellerName].filter(Boolean).join(' · ');

/** The length most of these SKUs have: a ticket number typed that long is finished. */
function usualLength(skus: string[]): number {
  const counts = new Map<number, number>();
  for (const k of skus) counts.set(k.length, (counts.get(k.length) ?? 0) + 1);
  let best = 0;
  let most = 0;
  for (const [len, n] of counts) if (n > most) { best = len; most = n; }
  return best || 5;
}

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
  const dialogRef = useRef<HTMLDivElement>(null);

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
  /** The SKU field holds the next ticket in sequence, filled in after a save: typing replaces it. */
  const [autoSku, setAutoSku] = useState(false);
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
  /** How the last save went: "Saved" until the next stub is typed, or why it failed until one succeeds. */
  const [lastSave, setLastSave] = useState<{ ok: true } | { ok: false; text: string } | null>(null);
  const [autoIncrement, setAutoIncrement] = useSwitch('autoIncrement');
  const [skipDetails, setSkipDetails] = useSwitch('skipDetails');
  /** Where the cursor goes once a ticket loads. */
  const afterSku: Field = skipDetails ? 'price' : 'details';
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
  const [pendingSelectSku, setPendingSelectSku] = useState(false);
  useLayoutEffect(() => {
    if (pendingFocus) {
      ({ sku: skuRef, details: detailsRef, price: priceRef })[pendingFocus].current?.focus();
      setPendingFocus(null);
    }
    if (pendingSelectSku) {
      skuRef.current?.select();
      setPendingSelectSku(false);
    }
    if (pendingCursor !== null) {
      detailsRef.current?.setSelectionRange(pendingCursor, pendingCursor);
      setPendingCursor(null);
    }
  }, [pendingFocus, pendingCursor, pendingSelectSku]);

  // Opened from the actions menu, the menu hands focus back to its button as
  // it closes, after the focus above: take it back once that's done.
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      if (!document.activeElement || !dialogRef.current?.contains(document.activeElement)) skuRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, []);

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
    if (!typed || autoSku || (ticket && ticket.sku === typed)) return [];
    return tickets.filter((t) => t.sku.startsWith(typed)).slice(0, 8);
  }, [skuText, autoSku, ticket, tickets]);

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
  // The filled-in next ticket isn't something typed: Escape still exits.
  const empty = (!skuText || autoSku) && !details && !priceText && !ticket;

  /**
   * A ticket number typed in full that isn't waiting for a price: entered
   * already, here or elsewhere. Said as soon as it's typed, not on Enter. It
   * never appears in the suggestions, which are only tickets still to price.
   */
  const typedSku = skuText.trim();
  const fullLength = usualLength([...tickets.map((t) => t.sku), ...saved.map((x) => x.sku)]);
  const savedHere = saved.find((x) => x.sku === typedSku) ?? null;
  const lookUpEntered = !autoSku && !exact && !savedHere && /^\d+$/.test(typedSku) && typedSku.length >= fullLength;
  const { data: lookedUp } = useQuery({
    queryKey: ['ski-swap/item-by-sku', orgId, swapId, typedSku],
    queryFn: () => api.skiSwap.findItemBySku(orgId, swapId, typedSku),
    enabled: lookUpEntered,
    retry: false,
    staleTime: 10_000,
  });
  const alreadyEntered = savedHere
    ? { sku: savedHere.sku, text: standing(savedHere) }
    : lookUpEntered && lookedUp && lookedUp.sku === typedSku && lookedUp.legacyTicket && lookedUp.priceCents !== null
      ? { sku: lookedUp.sku, text: standing({ name: lookedUp.name, priceCents: lookedUp.priceCents, sellerName: lookedUp.seller?.displayName ?? null }) }
      : null;

  function load(t: UnpricedTicket, then: Field = afterSku) {
    setTicket(t);
    setSkuText(t.sku);
    setAutoSku(false);
    const shownName = t.placeholderName ? '' : t.name;
    setDetails(shownName);
    setPrefill(shownName);
    setCursor(shownName.length);
    setImpliedCategoryId(null);
    setMessage(null);
    focus(then);
    // Nothing to suggest for a description nobody has started typing.
    setClosed(true);
  }

  function clearTicket(msg: Message | null = null) {
    setTicket(null);
    setSkuText('');
    setAutoSku(false);
    setDetails('');
    setPrefill('');
    setCursor(0);
    setImpliedCategoryId(null);
    setPriceText('');
    setMessage(msg);
    focus('sku');
  }

  /** Says why a typed SKU can't be loaded (D1), from the item it names, if any. */
  async function refuseSku(typed = skuText.trim()) {
    if (!typed) {
      setMessage({ tone: 'error', text: 'Type a ticket number.' });
      return;
    }
    try {
      const item = await api.skiSwap.findItemBySku(orgId, swapId, typed);
      if (!item.legacyTicket) setMessage({ tone: 'error', text: `${typed} isn’t a legacy ticket.` });
      else if (item.priceCents !== null) {
        setMessage({
          tone: 'error',
          text: `${typed} is already entered: ${standing({ name: item.name, priceCents: item.priceCents, sellerName: item.seller?.displayName ?? null })}.`,
        });
      } else {
        // Unpriced, but not in the list fetched on open: checked in since.
        load({ id: item.id, sku: item.sku, name: item.name, placeholderName: item.name === `Item #${item.sku}`,
          categoryId: item.category?.id ?? null, sellerName: item.seller?.displayName ?? null });
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
    // Only the price, and the description if it changed (D7). The name goes
    // only when there's more to it than the answers: otherwise the server
    // composes it, as it does for iOS and the single-item form.
    const description = parsed
      ? parsed.categoryId
        ? { categoryId: parsed.categoryId, attributes: parsed.attributes, ...(parsed.extra.length ? { name: parsed.name } : {}) }
        : { name: parsed.name }
      : {};
    const sent = ticket;
    const cents = priceCents!;
    const remaining = tickets.filter((t) => t.id !== sent.id);
    setTickets(remaining);
    setInFlight((n) => n + 1);
    clearTicket();
    if (autoIncrement) {
      // The next number, loaded and ready for its details or price. One that
      // can't be loaded stops the run at SKU, saying why: skipping ahead
      // quietly would put the next price on the wrong stub.
      const following = nextSku(sent.sku);
      const ready = following ? remaining.find((t) => t.sku === following) : undefined;
      if (ready) load(ready);
      else if (following) {
        setSkuText(following);
        setPendingSelectSku(true);
        void refuseSku(following);
      }
    } else {
      // The next stub in the stack is most likely the next number: fill it in,
      // selected, so Enter takes it and typing replaces it.
      const next = remaining
        .filter((t) => Number(t.sku) > Number(sent.sku))
        .sort((a, b) => Number(a.sku) - Number(b.sku))[0];
      if (next) {
        setSkuText(next.sku);
        setAutoSku(true);
        setPendingSelectSku(true);
      }
    }
    api.skiSwap.patchItem(orgId, swapId, sent.id, { priceCents: cents, ifUnpriced: true, ...description }, idempotencyKey())
      .then((item) => {
        const sellerName = item.seller?.displayName ?? sent.sellerName;
        const offSquare = item.consignedAt !== null && !item.squareSynced;
        setSaved((s) => [{ sku: item.sku, name: item.name, priceCents: item.priceCents ?? cents, sellerName, offSquare }, ...s]);
        setLastSave({ ok: true });
      })
      .catch((err: unknown) => {
        // Priced elsewhere meanwhile: no longer one to fast edit. Anything
        // else goes back, to be entered again.
        const priced = err instanceof ApiError && err.code === 'TICKET_PRICED';
        if (!priced) setTickets((ts) => [...ts, sent].sort((a, b) => Number(a.sku) - Number(b.sku)));
        const reason = err instanceof ApiError ? err.message : 'the request failed';
        setLastSave({
          ok: false,
          text: `${sent.sku} wasn’t saved: ${reason}${/[.!?]$/.test(reason) ? '' : '.'}` + (priced ? '' : ' Enter it again.'),
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
      skipDetails,
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
      case 'loadExact': return load(exact!, action.then);
      case 'loadHighlighted': return load(skuSuggestions[effectiveHighlight], action.then);
      case 'refuseSku': return void refuseSku();
      case 'accept': {
        accept(detailSuggestions[effectiveHighlight]);
        if (action.then === 'price') focus('price');
        return;
      }
      case 'focus': return focus(action.field);
      case 'save': return save();
      case 'needPrice': return setMessage({ tone: 'error', text: 'Type a price in whole dollars, $1 or more.' });
      case 'closeSuggestions': return setClosed(true);
      case 'clearTicket': return clearTicket();
      case 'exit': return exit();
      case 'none': return;
    }
  }

  /** "Saved" is about the stub before: gone once the next one is typed. A failure stays. */
  const typing = () => setLastSave((s) => (s?.ok ? null : s));

  function onSkuChange(value: string) {
    typing();
    const typed = value.replace(/\s/g, '');
    setSkuText(typed);
    setAutoSku(false);
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

  const hints = field === 'sku'
    ? (autoSku ? [`Enter or Tab for ${skuText}, the next ticket`, 'or type another number']
      : alreadyEntered ? ['Already entered: type another number']
      : !skuText ? ['Start typing the SKU'] : shown > 0 ? ['Arrows + Enter to pick a match, or Tab when done typing'] : ['Tab when done typing'])
    : field === 'details'
      ? [...(shown > 0 ? ['Arrows + Enter to accept a suggestion'] : details.trim() ? [] : ['Start typing details (optional)']), 'Tab when done typing']
      : (priceText ? ['Enter to save this ticket'] : ['Start typing the price']);

  // Said with an icon and as few words as will do (the hint bar says what's next).
  const stubStatus: Status | null =
    message && !(alreadyEntered && message.text.startsWith(`${alreadyEntered.sku} is already entered`))
      ? { tone: message.tone, text: message.tone === 'error' ? `Error: ${message.text}` : message.text }
      : alreadyEntered && !ticket
        ? { tone: 'warn', text: `${alreadyEntered.sku} is already entered: ${alreadyEntered.text}.` }
        : null;
  // A failure stays until a save succeeds: its ticket is back to be entered again.
  const saveStatus: Status | null =
    lastSave && !lastSave.ok ? { tone: 'error', text: `Error: ${lastSave.text}` }
    : inFlight > 0 ? { tone: 'pending', text: 'Saving…' }
    : lastSave?.ok ? { tone: 'ok', text: 'Saved' }
    : null;

  const left = tickets.length;
  const inputClass = 'w-full bg-surface-100 border border-gray-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-brand-600';

  return (
    <div className="fixed inset-0 bg-black/60 flex items-start justify-center p-4 pt-[10vh] z-50 overflow-y-auto">
      <div
        ref={dialogRef}
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
            <ul className="text-gray-400 text-sm mt-1 space-y-0.5 list-disc pl-5">
              <li>Price a stack of legacy ticket stubs, one stub at a time.</li>
              <li>Only tickets without a price can be loaded.</li>
              <li>A ticket on sale rings up at its new price as soon as it’s saved.</li>
              <li>Escape clears the current ticket.</li>
            </ul>
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

        <div className="flex flex-wrap gap-2">
          <SwitchCard
            label="Auto-increment SKU"
            note={`Enter saves and loads the next ticket, cursor in ${skipDetails ? 'Price' : 'Details'}`}
            on={autoIncrement}
            onChange={(on) => { setAutoIncrement(on); setPendingFocus(field); }}
          />
          <SwitchCard
            label="Skip description"
            note="Tab goes from SKU straight to Price"
            on={skipDetails}
            onChange={(on) => { setSkipDetails(on); setPendingFocus(field === 'details' && on ? 'sku' : field); }}
          />
        </div>

        <div className="grid grid-cols-[13rem_1fr_10rem] gap-2 items-start">
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
              className={`${inputClass} font-mono ${autoSku ? 'text-gray-400' : ''}`}
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
                typing();
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
              // Skipped, it's still there for a click, just out of the way of Tab.
              tabIndex={skipDetails ? -1 : undefined}
              autoComplete="off"
              aria-label="Details"
              placeholder="e.g. Rossignol red skis 170"
              className={`${inputClass} disabled:opacity-50 ${skipDetails && field !== 'details' ? 'opacity-50' : ''}`}
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
            {/* Whole dollars: a stub's price is written that way, and a
                stray "." or letter is a slip, not a price. The sign stays
                put whatever is typed. */}
            <span className={`absolute left-3 bottom-2 text-sm pointer-events-none ${ticket ? 'text-gray-300' : 'text-gray-600'}`}>$</span>
            <input
              ref={priceRef}
              value={priceText}
              onChange={(e) => { typing(); setPriceText(e.target.value.replace(/\D/g, '')); setMessage(null); }}
              onKeyDown={(e) => onKeyDown(e, 'price')}
              onFocus={() => setField('price')}
              disabled={!ticket}
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              aria-label="Price in dollars"
              className={`${inputClass} pl-7 text-right disabled:opacity-50`}
            />
          </Field>
        </div>

        {/* One line for the stub being typed, one for how the last save went. */}
        <div className="min-h-[1.25rem] space-y-1" aria-live="polite">
          {stubStatus && <StatusLine {...stubStatus} />}
          {saveStatus && <StatusLine {...saveStatus} />}
        </div>

        <div>
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <span className="text-gray-400 text-xs uppercase">Ticket Preview</span>
            {ticket?.sellerName && <span className="text-gray-300 text-xs truncate">{ticket.sellerName}</span>}
          </div>
          <div className="border border-gray-700 rounded overflow-hidden">
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-700">
                <PreviewRow label="SKU">
                  {ticket ? <span className="font-mono text-white">{ticket.sku}</span> : <Muted>—</Muted>}
                </PreviewRow>
                <PreviewRow label="Details">
                  {parsed && taxonomy
                    ? <><span className="text-white">{parsed.name}</span><span className="text-gray-500"> ({describeParsed(parsed, taxonomy)})</span></>
                    : detailsChanged ? <span className="text-white">{details.trim()}</span>
                    : ticket ? <><span className="text-gray-300">{ticket.name}</span><Muted> (unchanged)</Muted></>
                    : <Muted>—</Muted>}
                </PreviewRow>
                <PreviewRow label="Price">
                  {priceValid ? <span className="text-white">{money(priceCents!)}</span> : <Muted>{ticket ? 'No price yet' : '—'}</Muted>}
                </PreviewRow>
              </tbody>
            </table>
          </div>
        </div>

        <div className="border-t border-gray-700 pt-3">
          <div className="flex items-baseline justify-between gap-3">
            <span className="text-gray-400 text-xs uppercase">Saved</span>
            <span className="text-gray-400 text-xs">{saved.length} priced · {ticketsLoading ? '…' : left} left</span>
          </div>
          {saved.length > 0 && (
            <ul className="mt-2 max-h-40 overflow-y-auto space-y-0.5" aria-label="Saved tickets">
              {saved.map((s, i) => (
                <li
                  key={`${s.sku}-${i}`}
                  // The newest stands out: that's the save just made.
                  className={`flex items-center justify-between gap-3 text-xs rounded px-2 py-1 ${i === 0 ? 'bg-green-900/30 text-green-200' : 'text-gray-300'}`}
                >
                  <span className="flex items-center gap-2 min-w-0">
                    {s.offSquare
                      ? <FontAwesomeIcon icon={faTriangleExclamationDuo} className="text-amber-400 shrink-0" title="Saved, but Square didn’t take it. Re-push it from Items." />
                      : <FontAwesomeIcon icon={faCircleCheckDuo} className="text-green-400 shrink-0" title="Saved" />}
                    <span className="truncate">
                      <span className="font-mono">{s.sku}</span> · {s.name}
                      {s.sellerName && <span className={i === 0 ? 'text-green-300/70' : 'text-gray-500'}> · {s.sellerName}</span>}
                      {s.offSquare && <span className="text-amber-400"> · not in Square</span>}
                    </span>
                  </span>
                  <span className="shrink-0">{money(s.priceCents)}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* What to do next in the focused field, said as you go. */}
        <div
          className="-mx-5 -mb-5 px-5 py-3 bg-surface-100 border-t border-gray-700 rounded-b-lg flex items-center gap-3 text-sm"
          aria-live="polite"
        >
          <FontAwesomeIcon icon={faKeyboardDuo} className="text-brand-500 shrink-0" aria-hidden="true" />
          <span className="text-xs uppercase text-gray-400 shrink-0 w-16">{FIELD_NAMES[field]}</span>
          <span className="text-gray-100">{hints.join(' · ')}</span>
        </div>
      </div>
    </div>
  );
}

const FIELD_NAMES: Record<Field, string> = { sku: 'SKU', details: 'Details', price: 'Price' };

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

interface Status {
  tone: 'ok' | 'warn' | 'error' | 'pending';
  text: string;
}

function StatusLine({ tone, text }: Status) {
  const [icon, color] = {
    ok: [faCircleCheckDuo, 'text-green-400'],
    warn: [faTriangleExclamationDuo, 'text-amber-400'],
    error: [faCircleXmarkDuo, 'text-red-400'],
    pending: [null, 'text-gray-500'],
  }[tone] as [typeof faCircleCheckDuo | null, string];
  return (
    <p role={tone === 'error' ? 'alert' : undefined} className={`flex items-center gap-2 text-sm ${color}`}>
      {icon && <FontAwesomeIcon icon={icon} className="shrink-0" />}
      <span>{text}</span>
    </p>
  );
}

function SwitchCard({ label, note, on, onChange }: { label: string; note: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      // Keeps the cursor in the field: the switch is flipped by mouse, mid-stack.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onChange(!on)}
      className="flex-1 min-w-[16rem] flex items-start gap-3 text-left bg-surface-100 hover:bg-surface-200 border border-gray-700 rounded px-3 py-2"
    >
      <span className={`shrink-0 mt-0.5 w-9 h-5 rounded-full transition-colors ${on ? 'bg-brand-600' : 'bg-surface-200 border border-gray-600'}`}>
        <span className={`block w-4 h-4 mt-px bg-white rounded-full transition-transform ${on ? 'translate-x-[1.1rem]' : 'translate-x-px'}`} />
      </span>
      <span>
        <span className="block text-sm text-white">{label}</span>
        <span className="block text-xs text-gray-400">{note}</span>
      </span>
    </button>
  );
}

function PreviewRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <tr>
      <th scope="row" className="w-24 text-left font-normal text-gray-400 bg-surface-100 px-3 py-1.5">{label}</th>
      <td className="px-3 py-1.5">{children}</td>
    </tr>
  );
}

function Muted({ children }: { children: React.ReactNode }) {
  return <span className="text-gray-500">{children}</span>;
}
