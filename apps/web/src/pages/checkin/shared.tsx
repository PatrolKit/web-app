import type { ReactNode } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import { PoweredByFooter } from '../public/PoweredByFooter';
import type { CheckinContext } from '../../lib/api.types';

/**
 * Where you are, in one line, identical on every screen of the flow.
 *
 * It used to be assembled per step, and drifted: the first screen said the org
 * and the station, later ones the swap and the station, and two steps said
 * nothing at all. A seller reading the same line on every screen can stop
 * reading it; one that changes shape has to be re-read each time.
 */
export function contextLine(context: CheckinContext): string {
  return [context.orgName, context.swapTitle, context.stationName].join(' · ');
}

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
          {/* The instruction, and the loudest thing on the screen. Every step
              puts what to do next here; anything explaining the step goes in
              the body under it. */}
          <h1 className="text-2xl font-bold">{title}</h1>
          {subtitle && <p className="text-sm text-gray-400">{subtitle}</p>}
        </header>
        {children}
        {footer && <div className="pt-2">{footer}</div>}
        <SignedInAs />
        <PoweredByFooter />
      </div>
    </div>
  );
}

/**
 * Who this phone is currently signed in as, and a way out.
 *
 * Not really about changing your mind: a check-in matches on a phone number,
 * and a household that shares one gets whoever claimed it first. Without this
 * the second person to try is signed in as the first, consigning under their
 * name, with nothing on screen admitting it or offering a way back.
 *
 * Absent before sign-in, where there is nobody to be wrong about.
 */
function SignedInAs() {
  const { user, logout } = useAuth();
  if (!user) return null;

  return (
    <p className="mt-8 text-center text-xs text-gray-500">
      Signed in as <span className="text-gray-400">{user.displayName}</span>
      {' · '}
      <button
        onClick={() => { void logout(); }}
        className="text-brand-500 hover:underline"
      >
        Not you?
      </button>
    </p>
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
