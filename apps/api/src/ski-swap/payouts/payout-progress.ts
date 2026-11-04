/**
 * How far a swap's payouts have got (the bar under the money card): of the
 * sellers owed for it, how many are paid, how many are in a run on their way,
 * and how many aren't in one yet. Pure, and tested.
 *
 * A seller is counted by the line that counts for them: the one in a run now,
 * else none (a payment PayPal didn't make frees them, so they're owed again).
 * Paid is PayPal's SENT or an exported check. A seller paid and since owed
 * nothing (a refund after paying) still counts as paid; one donating, or owed
 * nothing and never paid, isn't counted.
 */
export interface ProgressLine {
  sellerId: string;
  status: string;
  activeKey: string | null;
  /** What was paid or approved, once frozen; null before. */
  netCents: number | null;
}

export interface PayoutProgress {
  sellers: number;
  paid: number;
  inRun: number;
  paidCents: number;
  owedCents: number;
}

export function payoutProgress(owed: { sellerId: string; netCents: number; donated: boolean }[], lines: ProgressLine[]): PayoutProgress {
  const inRun = new Map<string, ProgressLine>();
  for (const l of lines) if (l.activeKey) inRun.set(l.sellerId, l);
  const owing = new Map(owed.filter((o) => !o.donated && o.netCents > 0).map((o) => [o.sellerId, o.netCents]));

  const p: PayoutProgress = { sellers: 0, paid: 0, inRun: 0, paidCents: 0, owedCents: 0 };
  for (const id of new Set([...owing.keys(), ...inRun.keys()])) {
    const line = inRun.get(id);
    const paid = line?.status === 'SENT' || line?.status === 'EXPORTED';
    if (!paid && !owing.has(id)) continue;
    const cents = paid ? line!.netCents ?? owing.get(id) ?? 0 : owing.get(id)!;
    p.sellers++;
    p.owedCents += cents;
    if (paid) { p.paid++; p.paidCents += cents; } else if (line) p.inRun++;
  }
  return p;
}
