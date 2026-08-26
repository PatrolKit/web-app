import type { ReactNode } from 'react';

/**
 * Phone-first chrome for check-in.
 *
 * Not a breakpoint: these screens are only ever used on a phone, held one-handed,
 * at a counter. One column, a single primary action within thumb reach, and
 * nothing fixed to the bottom — the iOS keyboard would sit on top of it.
 */
export function CheckinShell({
  title,
  subtitle,
  logoUrl,
  children,
  footer,
}: {
  title: string;
  subtitle?: string;
  logoUrl?: string | null;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <div className="min-h-screen bg-surface text-white">
      <div className="mx-auto w-full max-w-md px-4 py-6 space-y-6">
        <header className="space-y-2 text-center">
          {logoUrl && <img src={logoUrl} alt="" className="mx-auto h-12 object-contain" />}
          <h1 className="text-xl font-bold">{title}</h1>
          {subtitle && <p className="text-sm text-gray-400">{subtitle}</p>}
        </header>
        {children}
        {footer && <div className="pt-2">{footer}</div>}
      </div>
    </div>
  );
}

/**
 * Inputs are 16px on purpose. iOS Safari zooms any focused input below that, and
 * once it has zoomed the layout stays wrong for the rest of the session.
 */
export const inputClass =
  'w-full bg-surface-100 border border-gray-700 rounded-lg px-3 py-3 text-base text-white ' +
  'placeholder:text-gray-500 focus:border-brand-600 focus:outline-none';

export const primaryButtonClass =
  'w-full py-3.5 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-40 ' +
  'text-white text-base font-medium';

export const secondaryButtonClass =
  'w-full py-3 rounded-lg bg-surface-100 hover:bg-surface-200 disabled:opacity-40 ' +
  'text-gray-200 text-base';

export function ErrorNote({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p className="text-sm text-red-400 bg-red-950/40 border border-red-900 rounded-lg px-3 py-2">
      {children}
    </p>
  );
}

export function formatCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

/**
 * Parses a typed price into cents.
 *
 * Tolerant on purpose — people type "45", "45.", "$45.00". Returns null for
 * anything that is not a price, so the caller can keep the button disabled
 * rather than sending a NaN.
 */
export function parsePriceCents(raw: string): number | null {
  const cleaned = raw.replace(/[^0-9.]/g, '');
  if (!cleaned) return null;
  const value = Number(cleaned);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.round(value * 100);
}
