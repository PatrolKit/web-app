import type { ReactNode } from 'react';
import { usd } from '../../../lib/money';
import type { PayoutsSummary } from '../../../lib/api.types';
import { percentText } from './payoutView';

type Money = NonNullable<PayoutsSummary['money']>;
type Progress = NonNullable<PayoutsSummary['progress']>;

/**
 * The swap's money at the top of Payouts: what came in, what goes out to
 * sellers, and what the patrol keeps. The arithmetic is the server's
 * (money-summary.ts); this only lays it out as three equations. Underneath,
 * how many of the sellers owed have been paid.
 */
export default function MoneyCard({ money, progress }: { money: Money; progress: PayoutsSummary['progress'] }) {
  const { incoming: i, outgoing: o } = money;
  const profitTone = money.profitCents >= 0 ? 'text-green-400' : 'text-red-400';
  return (
    <div className="border border-gray-700 bg-surface-50 rounded-lg px-4 py-3 text-sm space-y-3">
      {/* One grid for all three, so each "= result" lines up under the others. */}
      <div className="grid grid-cols-[4.5rem_minmax(0,max-content)_auto_auto] justify-start gap-x-3 gap-y-3 items-start">
        <Equation label="Incoming" tone="text-green-400" result={i.totalCents}>
          <Term cents={i.salesCents} what="Square sales" />
          {i.returnsCents > 0 && <Term op="−" cents={i.returnsCents} what="returns" />}
          <Term op="+" cents={i.feesChargedCents} what="shop and convenience fees" />
          <Term op="−" cents={i.squareFeesCents} what="Square’s fees" detail={<SquareFeesDetail incoming={i} />} />
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
      {progress && progress.sellers > 0 && <PaidBar progress={progress} />}
    </div>
  );
}

/** Of the sellers owed, how many are paid (green), in a run on their way (pale green), and the rest. */
function PaidBar({ progress: p }: { progress: Progress }) {
  const pct = (n: number) => `${(n / p.sellers) * 100}%`;
  const rest = p.sellers - p.paid - p.inRun;
  return (
    <div className="border-t border-gray-800 pt-3 space-y-1.5">
      <p className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="text-gray-400">Paid out</span>
        <span className="text-gray-300">
          <span className="text-white font-medium">{p.paid} of {p.sellers}</span> {p.sellers === 1 ? 'seller' : 'sellers'} paid
          <span className="text-gray-500"> · {usd(p.paidCents)} of {usd(p.owedCents)}</span>
        </span>
      </p>
      <div role="progressbar" aria-label="Sellers paid" aria-valuemin={0} aria-valuemax={p.sellers} aria-valuenow={p.paid}
        aria-valuetext={`${p.paid} of ${p.sellers} sellers paid, ${p.inRun} in a run`}
        className="h-2 rounded-full bg-gray-700 overflow-hidden flex">
        <div className="bg-green-500" style={{ width: pct(p.paid) }} />
        <div className="bg-green-500/35" style={{ width: pct(p.inRun) }} />
      </div>
      <p className="flex flex-wrap gap-x-4 text-xs text-gray-400">
        <Key dot="bg-green-500">{p.paid} paid</Key>
        {p.inRun > 0 && <Key dot="bg-green-500/35">{p.inRun} in a run</Key>}
        {rest > 0 && <Key dot="bg-gray-700">{rest} not in a run yet</Key>}
      </p>
    </div>
  );
}

function Key({ dot, children }: { dot: string; children: ReactNode }) {
  return <span className="inline-flex items-center gap-1.5"><span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />{children}</span>;
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
function Stacked({ top, label, underline }: { top: ReactNode; label?: string; underline?: boolean }) {
  return (
    <span className="inline-flex flex-col items-center leading-tight">
      <span className="text-white tabular-nums whitespace-nowrap">{top}</span>
      {label && (
        <span className={`text-[11px] text-gray-500 whitespace-nowrap ${underline ? 'underline decoration-dotted underline-offset-2 cursor-help' : ''}`}>{label}</span>
      )}
    </span>
  );
}

/**
 * A figure, with the operator before it and any bracket, kept together when the
 * equation wraps. With `detail`, its label is underlined and the detail opens
 * on hover, or on focus from the keyboard.
 */
function Term({ op, cents, what, open, close, detail }: {
  op?: '+' | '−'; cents: number; what: string; open?: boolean; close?: boolean; detail?: ReactNode;
}) {
  const figure = <Stacked top={usd(cents)} label={what} underline={!!detail} />;
  return (
    <Together>
      {op && <Op>{op}</Op>}
      {open && <Op>(</Op>}
      {detail ? (
        <span className="group relative outline-none" tabIndex={0}>
          {figure}
          <span role="tooltip" className="hidden group-hover:block group-focus:block absolute z-20 left-1/2 -translate-x-1/2 top-full mt-1.5 w-80 rounded-md border border-gray-600 bg-surface-100 shadow-lg p-3 text-xs text-gray-300">
            {detail}
          </span>
        </span>
      ) : figure}
      {close && <Op>)</Op>}
    </Together>
  );
}

const KIND_LABEL: Record<string, string> = {
  in_person: 'Tapped, chip or swiped',
  keyed: 'Keyed in',
  on_file: 'Card on file',
  other: 'Other (wallets, cash, external)',
};

/** "2.65%": a fee's rate, to the hundredth, as Square quotes them. */
const rateText = (feeCents: number, amountCents: number) => (amountCents > 0 ? `${((feeCents / amountCents) * 100).toFixed(2)}%` : '—');

/** Square's fees by how the card was taken, what refunds returned, and the total. */
function SquareFeesDetail({ incoming }: { incoming: Money['incoming'] }) {
  const d = incoming.squareFeesDetail;
  if (!d) return <p>Square didn’t give a breakdown for these sales, only the total.</p>;
  const charged = d.kinds.reduce((n, k) => n + k.amountCents, 0);
  return (
    <div className="space-y-2">
      <p className="text-gray-400">Square’s processing fees on the swap’s sales, by how the card was taken.</p>
      <table className="w-full">
        <tbody>
          {d.kinds.map((k) => (
            <tr key={k.kind} className="align-top">
              <td className="py-0.5 pr-2">
                <span className="text-gray-200">{KIND_LABEL[k.kind] ?? k.kind}</span>
                <span className="block text-gray-500">{k.payments.toLocaleString('en-US')} payment{k.payments === 1 ? '' : 's'}, {usd(k.amountCents)}</span>
              </td>
              <td className="py-0.5 text-right whitespace-nowrap">
                <span className="text-white tabular-nums">{usd(k.feeCents)}</span>
                <span className="block text-gray-500">{rateText(k.feeCents, k.amountCents)}</span>
              </td>
            </tr>
          ))}
          {d.returnedCents !== 0 && (
            <tr>
              <td className="py-0.5 pr-2 text-gray-200">Returned on refunds</td>
              <td className="py-0.5 text-right text-white tabular-nums">−{usd(d.returnedCents)}</td>
            </tr>
          )}
          <tr className="border-t border-gray-700">
            <td className="pt-1.5 pr-2 text-gray-200">Total</td>
            <td className="pt-1.5 text-right whitespace-nowrap">
              <span className="text-white font-semibold tabular-nums">{usd(incoming.squareFeesCents)}</span>
              <span className="block text-gray-500">{rateText(incoming.squareFeesCents, charged)} of {usd(charged)}</span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function Together({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-start gap-x-2">{children}</span>;
}

/** An operator or bracket, on the figures' line. */
function Op({ children }: { children: ReactNode }) {
  return <span className="text-gray-500 leading-tight">{children}</span>;
}
