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
        <span className="text-gray-500">(</span>
        <Term cents={o.itemsCents} what="items sold" />
        <Term op="+" cents={o.compsCents} what="comped" />
        <span className="text-gray-500">)</span>
        <span className="text-gray-400">× (1 − {percentText(o.takeBps / 10_000)} patrol’s take)</span>
      </Equation>
      <Equation label="Profit" tone={profitTone} result={money.profitCents}
        suffix={money.profitShare !== null ? `${percentText(money.profitShare)} of incoming` : undefined}>
        <Term cents={i.totalCents} what="incoming" />
        <Term op="−" cents={o.totalCents} what="outgoing" />
      </Equation>
    </div>
  );
}

function Equation({ label, tone, result, suffix, note, children }: {
  label: string; tone: string; result: number; suffix?: string; note?: string; children: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      <span className="w-20 shrink-0 text-gray-400">{label}</span>
      <span className="flex flex-wrap items-baseline gap-x-1.5 min-w-0 flex-1">{children}</span>
      <span className="text-gray-500">=</span>
      <span className={`font-semibold tabular-nums ${tone}`}>{usd(result)}</span>
      {suffix && <span className="text-xs text-gray-400">({suffix})</span>}
      {note && <p className="basis-full pl-20 text-xs text-gray-500">{note}</p>}
    </div>
  );
}

function Term({ op, cents, what }: { op?: '+' | '−'; cents: number; what: string }) {
  return (
    <span className="whitespace-nowrap">
      {op && <span className="text-gray-500 mr-1.5">{op}</span>}
      <span className="text-white tabular-nums">{usd(cents)}</span> <span className="text-gray-500 text-xs">{what}</span>
    </span>
  );
}
