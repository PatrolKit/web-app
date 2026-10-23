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
    <div className="border border-gray-700 bg-surface-50 rounded-lg px-4 py-3 space-y-2.5 text-sm">
      <Equation label="Incoming" tone="text-green-400" result={i.totalCents}>
        <Term cents={i.salesCents} what="Square sales" />
        {i.returnsCents > 0 && <Term op="−" cents={i.returnsCents} what="returns" />}
        <Term op="+" cents={i.feesChargedCents} what="shop and convenience fees" />
        <Term op="−" cents={i.squareFeesCents} what="Square’s fees" />
      </Equation>
      <Equation label="Outgoing" tone="text-red-400" result={o.totalCents}
        note={o.donatedCents > 0 ? `Not counting ${usd(o.donatedCents)} sold by sellers who donated it to the patrol.` : undefined}>
        <Op>(</Op>
        <Term cents={o.itemsCents} what="items sold" />
        <Term op="+" cents={o.compsCents} what="comped" />
        <Op>)</Op>
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
    </div>
  );
}

function Equation({ label, tone, result, resultLabel, note, children }: {
  label: string; tone: string; result: number; resultLabel?: string; note?: string; children: ReactNode;
}) {
  return (
    <div className="flex items-start gap-x-3">
      <span className="w-20 shrink-0 text-gray-400 leading-tight">{label}</span>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-start gap-x-2 gap-y-1.5">
          {children}
          <Together>
            <Op>=</Op>
            <Stacked top={<span className={`font-semibold ${tone}`}>{usd(result)}</span>} label={resultLabel} />
          </Together>
        </div>
        {note && <p className="text-xs text-gray-500">{note}</p>}
      </div>
    </div>
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

/** A figure and the operator before it, kept on one line when the equation wraps. */
function Term({ op, cents, what }: { op?: '+' | '−'; cents: number; what: string }) {
  return (
    <Together>
      {op && <Op>{op}</Op>}
      <Stacked top={usd(cents)} label={what} />
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
