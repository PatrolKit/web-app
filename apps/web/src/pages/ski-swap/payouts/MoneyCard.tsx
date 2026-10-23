import type { ReactNode } from 'react';
import { usd } from '../../../lib/money';
import type { PayoutsSummary } from '../../../lib/api.types';
import { percentText } from './payoutView';

type Money = NonNullable<PayoutsSummary['money']>;

/**
 * The swap's money at the top of Payouts: what came in, what goes out to
 * sellers, and what the patrol keeps. The arithmetic is the server's
 * (money-summary.ts); this only lays it out as three equations.
 */
export default function MoneyCard({ money }: { money: Money }) {
  const { incoming: i, outgoing: o } = money;
  const profitTone = money.profitCents >= 0 ? 'text-green-400' : 'text-red-400';
  return (
    // One grid for all three, so each "= result" lines up under the others.
    <div className="border border-gray-700 bg-surface-50 rounded-lg px-4 py-3 text-sm grid grid-cols-[4.5rem_minmax(0,max-content)_auto_auto] justify-start gap-x-3 gap-y-3 items-start">
      <Equation label="Incoming" tone="text-green-400" result={i.totalCents}>
        <Term cents={i.salesCents} what="Square sales" />
        {i.returnsCents > 0 && <Term op="−" cents={i.returnsCents} what="returns" />}
        <Term op="+" cents={i.feesChargedCents} what="shop and convenience fees" />
        <Term op="−" cents={i.squareFeesCents} what="Square’s fees" />
      </Equation>
      <Equation label="Outgoing" tone="text-red-400" result={o.totalCents}>
        <Term open cents={o.itemsCents} what="items sold" />
        <Term op="+" cents={o.compsCents} what="comped" close />
        <Together>
          <Op>×</Op>
          <Stacked top={`(1 − ${percentText(o.takeBps / 10_000)})`} label="patrol’s take" />
        </Together>
      </Equation>
      <Equation label="Profit" tone={profitTone} result={money.profitCents}
        resultLabel={money.profitShare !== null ? `${percentText(money.profitShare)} of incoming` : undefined}>
        <Term cents={i.totalCents} what="incoming" />
        <Term op="−" cents={o.totalCents} what="outgoing" />
      </Equation>
      {o.donatedCents > 0 && (
        <p className="col-span-full text-xs text-gray-500">Outgoing doesn’t count {usd(o.donatedCents)} sold by sellers who donated it to the patrol.</p>
      )}
    </div>
  );
}

/** One row of the card's grid: the label, the terms (which wrap), "=", the result. */
function Equation({ label, tone, result, resultLabel, children }: {
  label: string; tone: string; result: number; resultLabel?: string; children: ReactNode;
}) {
  return (
    <>
      <span className="text-gray-400 leading-tight">{label}</span>
      <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">{children}</div>
      <Op>=</Op>
      <Stacked top={<span className={`font-semibold ${tone}`}>{usd(result)}</span>} label={resultLabel} />
    </>
  );
}

/** A figure, with what it is in small type underneath. */
function Stacked({ top, label }: { top: ReactNode; label?: string }) {
  return (
    <span className="inline-flex flex-col items-center leading-tight">
      <span className="text-white tabular-nums whitespace-nowrap">{top}</span>
      {label && <span className="text-[11px] text-gray-500 whitespace-nowrap">{label}</span>}
    </span>
  );
}

/** A figure, with the operator before it and any bracket, kept together when the equation wraps. */
function Term({ op, cents, what, open, close }: { op?: '+' | '−'; cents: number; what: string; open?: boolean; close?: boolean }) {
  return (
    <Together>
      {op && <Op>{op}</Op>}
      {open && <Op>(</Op>}
      <Stacked top={usd(cents)} label={what} />
      {close && <Op>)</Op>}
    </Together>
  );
}

function Together({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-start gap-x-2">{children}</span>;
}

/** An operator or bracket, on the figures' line. */
function Op({ children }: { children: ReactNode }) {
  return <span className="text-gray-500 leading-tight">{children}</span>;
}
