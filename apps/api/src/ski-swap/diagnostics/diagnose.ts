import { createHash } from 'crypto';
import type { PosCatalogItem } from '../pos/pos.adapter';
import type { DiagnosticField, DiagnosticIssueKind } from '../../contracts/swap-diagnostics.contracts';

/**
 * The swap diagnostics' comparison (Plan 41 D1, D2), kept pure so it can be
 * tested: our items against the swap's Square category, matched by SKU.
 *
 * A run uses it on the whole category; Mark resolved and the staleness check
 * use it on a few SKUs, re-read. Both get the same answer for the same data,
 * which is what lets an issue be recognised again by its fingerprint.
 */

export type IssueKind = DiagnosticIssueKind;
export type DiffersField = DiagnosticField;

/** One of our live items, as compared. */
export interface OurItem {
  id: string;
  sku: string;
  name: string;
  description: string | null;
  priceCents: number | null;
  consigned: boolean;
  squareItemId: string | null;
  squareVariationId: string | null;
  sellerName: string | null;
}

/** One of our deleted items: an "only in Square" SKU may be one of these. */
export interface OurDeletedItem {
  id: string;
  sku: string;
  name: string;
  sellerName: string | null;
}

/** One of our items handed back to its seller (Plan 43): not expected in Square. */
export interface OurReturnedItem {
  id: string;
  sku: string;
  name: string;
  sellerName: string | null;
}

/** Square's side of one item, as stored on an issue. */
export interface SquareSide {
  itemId: string;
  variationId: string;
  name: string;
  notes: string | null;
  priceCents: number | null;
  version: string | null;
  updatedAt: string | null;
}

/** Our side of one item, as stored on an issue. */
export interface OurSide {
  itemId: string;
  name: string;
  notes: string | null;
  priceCents: number | null;
  squareItemId: string | null;
  squareVariationId: string | null;
  sellerName: string | null;
}

export interface FoundIssue {
  sku: string;
  kind: IssueKind;
  field: DiffersField | null;
  /** Ours; for "only in Square", the deleted item of ours with that SKU, if any. */
  ours: (OurSide & { deleted?: boolean }) | null;
  /** Square's item; for "twice", every copy. */
  square: SquareSide | { copies: SquareSide[] } | null;
  fingerprint: string;
}

/** Notes as compared: trimmed, with blank and missing alike. */
export function normNotes(s: string | null | undefined): string | null {
  const t = (s ?? '').trim();
  return t === '' ? null : t;
}

function squareSide(e: PosCatalogItem): SquareSide {
  return {
    itemId: e.itemId,
    variationId: e.variationId,
    name: e.name,
    notes: normNotes(e.description),
    priceCents: e.pricing.type === 'fixed' ? e.pricing.cents : null,
    version: e.version,
    updatedAt: e.updatedAt,
  };
}

function ourSide(o: OurItem): OurSide {
  return {
    itemId: o.id,
    name: o.name,
    notes: normNotes(o.description),
    priceCents: o.priceCents,
    squareItemId: o.squareItemId,
    squareVariationId: o.squareVariationId,
    sellerName: o.sellerName,
  };
}

/** The values an issue is about, hashed. Same values, same fingerprint. */
export function fingerprintOf(sku: string, kind: IssueKind, field: DiffersField | null, values: unknown): string {
  return createHash('sha256').update(JSON.stringify([sku, kind, field, values])).digest('hex');
}

/** An issue's identity within a swap: SKU, kind and field. */
export function issueKey(i: { sku: string; kind: string; field: string | null }): string {
  return `${i.sku}\u0000${i.kind}\u0000${i.field ?? ''}`;
}

export function diagnose(input: {
  ours: OurItem[];
  deleted: OurDeletedItem[];
  /** Returned items (Plan 43): never "only ours"; still in Square is its own issue. */
  returned?: OurReturnedItem[];
  square: PosCatalogItem[];
  /** Limit to these SKUs: a re-read of a few. Absent for a whole run. */
  onlySkus?: Set<string>;
}): FoundIssue[] {
  const want = (sku: string) => !input.onlySkus || input.onlySkus.has(sku);
  const ourBySku = new Map(input.ours.filter((o) => want(o.sku)).map((o) => [o.sku, o]));
  const returnedBySku = new Map((input.returned ?? []).filter((r) => want(r.sku)).map((r) => [r.sku, r]));
  const deletedBySku = new Map<string, OurDeletedItem>();
  for (const d of input.deleted) if (want(d.sku) && !deletedBySku.has(d.sku)) deletedBySku.set(d.sku, d);
  const squareBySku = new Map<string, PosCatalogItem[]>();
  for (const e of input.square) {
    if (!want(e.sku)) continue;
    squareBySku.set(e.sku, [...(squareBySku.get(e.sku) ?? []), e]);
  }

  const issues: FoundIssue[] = [];
  const add = (sku: string, kind: IssueKind, field: DiffersField | null, ours: FoundIssue['ours'], square: FoundIssue['square'], values: unknown) =>
    issues.push({ sku, kind, field, ours, square, fingerprint: fingerprintOf(sku, kind, field, values) });

  for (const [sku, entries] of squareBySku) {
    const our = ourBySku.get(sku);

    if (entries.length > 1) {
      const copies = entries.map(squareSide).sort((a, b) => a.itemId.localeCompare(b.itemId));
      add(sku, 'twice', null, our ? ourSide(our) : null, { copies },
        { copies: copies.map((c) => c.itemId), ours: our?.id ?? null });
      continue;
    }

    const sq = squareSide(entries[0]);
    const back = our ? undefined : returnedBySku.get(sku);
    if (back) {
      add(sku, 'returned', null,
        { itemId: back.id, name: back.name, notes: null, priceCents: null, squareItemId: null, squareVariationId: null, sellerName: back.sellerName },
        sq, { square: [sq.itemId], returned: back.id });
      continue;
    }
    if (!our) {
      const gone = deletedBySku.get(sku);
      add(sku, 'only_square', null,
        gone ? { itemId: gone.id, name: gone.name, notes: null, priceCents: null, squareItemId: null, squareVariationId: null, sellerName: gone.sellerName, deleted: true } : null,
        sq, { square: [sq.itemId, sq.name, sq.notes, sq.priceCents], deleted: gone?.id ?? null });
      continue;
    }

    const o = ourSide(our);
    if (o.squareItemId !== sq.itemId || o.squareVariationId !== sq.variationId) {
      add(sku, 'not_linked', null, o, sq,
        { ours: [o.squareItemId, o.squareVariationId], square: [sq.itemId, sq.variationId] });
    }
    if (o.name !== sq.name) add(sku, 'differs', 'name', o, sq, { ours: o.name, square: sq.name });
    if (o.notes !== sq.notes) add(sku, 'differs', 'notes', o, sq, { ours: o.notes, square: sq.notes });
    if (o.priceCents !== sq.priceCents) add(sku, 'differs', 'price', o, sq, { ours: o.priceCents, square: sq.priceCents });
  }

  for (const [sku, our] of ourBySku) {
    if (squareBySku.has(sku) || !our.consigned) continue;
    const o = ourSide(our);
    add(sku, 'only_ours', null, o, null, { ours: [o.itemId, o.name, o.notes, o.priceCents] });
  }

  return issues;
}
