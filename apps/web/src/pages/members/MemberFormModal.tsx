import { useState } from 'react';
import type { MemberResponse } from '../../lib/api.types';

export interface MemberDraft {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  nspId: string;
  patrolLevel: string;
  inactive: boolean;
  clearClockPin: boolean;
}

const blank: MemberDraft = {
  firstName: '', lastName: '', email: '', phone: '', nspId: '', patrolLevel: '', inactive: false, clearClockPin: false,
};

function draftOf(m: MemberResponse): MemberDraft {
  return {
    firstName: m.firstName ?? '',
    lastName: m.lastName ?? '',
    email: m.email ?? '',
    phone: m.phone ?? '',
    nspId: m.nspId ?? '',
    patrolLevel: m.patrolLevel ?? '',
    inactive: m.inactive,
    clearClockPin: false,
  };
}

/**
 * Adding or editing a member: everything about a person, in one place (Plan 57
 * D3). Contact is optional, but a member needs an email, a phone or an NSP ID to
 * be told apart by, and a name when there's no email (D4).
 */
export function MemberFormModal({
  member,
  busy,
  error,
  onSave,
  onClose,
}: {
  /** Null to add someone. */
  member: MemberResponse | null;
  busy: boolean;
  error: string | null;
  onSave: (draft: MemberDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<MemberDraft>(member ? draftOf(member) : blank);
  const set = (k: keyof MemberDraft) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setDraft({ ...draft, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const identified = !!(draft.email.trim() || draft.phone.trim() || draft.nspId.trim());
  const named = !!(draft.firstName.trim() && draft.lastName.trim());
  const ready = identified && (named || !!draft.email.trim());
  const why = !identified
    ? 'Give an email, a phone number or an NSP ID.'
    : !ready ? 'Without an email, a first and last name are needed.' : null;
  // Taking an on-entry member off the clock clocks them out; say so first.
  const clocksOut = !!member?.clockedIn && draft.inactive && !member.inactive;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <form
        role="dialog"
        aria-labelledby="member-form-title"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => { e.preventDefault(); if (ready) onSave(draft); }}
        className="bg-surface-50 border border-gray-700 rounded-lg w-full max-w-lg p-6 space-y-4"
      >
        <h2 id="member-form-title" className="text-white font-semibold">
          {member ? `Edit ${member.displayName}` : 'Add a member'}
        </h2>
        {error && <p className="text-red-400 text-sm" role="alert">{error}</p>}

        <div className="grid grid-cols-2 gap-3">
          <Field label="First name"><input className={inputClass} value={draft.firstName} onChange={set('firstName')} autoFocus /></Field>
          <Field label="Last name"><input className={inputClass} value={draft.lastName} onChange={set('lastName')} /></Field>
          <Field label="Email"><input type="email" className={inputClass} value={draft.email} onChange={set('email')} /></Field>
          <Field label="Phone"><input type="tel" className={inputClass} value={draft.phone} onChange={set('phone')} /></Field>
          <Field label="NSP ID"><input className={inputClass} value={draft.nspId} onChange={set('nspId')} /></Field>
          <Field label="Patrol level"><input className={inputClass} value={draft.patrolLevel} onChange={set('patrolLevel')} placeholder="e.g. Senior" /></Field>
        </div>

        <p className="text-gray-500 text-xs">
          Every member can clock in on the patrol's iPads: with their NSP ID, or, without one, a 6-digit PIN they
          choose after signing in.
        </p>

        {member && (
          <div className="space-y-2">
            <label className="flex items-start gap-2 text-sm text-gray-300">
              <input type="checkbox" checked={draft.inactive} onChange={set('inactive')} className="mt-0.5 accent-brand-600" />
              <span>
                Inactive
                <span className="block text-gray-500 text-xs">Still a member, but off the iPads' clock-in list.</span>
              </span>
            </label>
            {member.clockPinSet && !draft.nspId.trim() && (
              <label className="flex items-start gap-2 text-sm text-gray-300">
                <input type="checkbox" checked={draft.clearClockPin} onChange={set('clearClockPin')} className="mt-0.5 accent-brand-600" />
                <span>
                  Clear their clock-in PIN
                  <span className="block text-gray-500 text-xs">For a forgotten PIN: they choose a new one on My account.</span>
                </span>
              </label>
            )}
            {clocksOut && (
              <p className="text-amber-400 text-sm">
                {member.displayName} is clocked in at {member.clockedIn!.resortName}. Saving clocks them out.
              </p>
            )}
          </div>
        )}

        {why && <p className="text-gray-500 text-xs">{why}</p>}
        <div className="flex gap-3 justify-end">
          <button type="button" onClick={onClose} className="text-gray-400 hover:text-white text-sm px-3 py-1.5">Cancel</button>
          <button
            type="submit"
            disabled={!ready || busy}
            className="bg-brand-600 hover:bg-brand-700 disabled:opacity-40 text-white px-4 py-1.5 rounded text-sm"
          >
            {busy ? 'Saving…' : member ? 'Save' : 'Add member'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs text-gray-400">{label}</span>
      {children}
    </label>
  );
}

const inputClass = 'w-full bg-surface-100 border border-gray-700 rounded px-2 py-1.5 text-sm text-white';
