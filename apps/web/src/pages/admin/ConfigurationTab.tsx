import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';

/**
 * Platform-wide settings (Plan 29). One for now: texting.
 *
 * Laid out as a list of switches so the next setting is a row, not a page.
 */
export default function ConfigurationTab() {
  const qc = useQueryClient();
  const { data: settings, isLoading } = useQuery({
    queryKey: ['admin/settings'],
    queryFn: () => api.admin.settings(),
  });
  const mutation = useMutation({
    mutationFn: (smsEnabled: boolean) => api.admin.updateSettings({ smsEnabled }),
    onSuccess: (next) => {
      qc.setQueryData(['admin/settings'], next);
      // This browser's own screens follow at once.
      qc.invalidateQueries({ queryKey: ['public/features'] });
    },
  });

  if (isLoading) return <p className="text-gray-400">Loading…</p>;
  const on = settings?.smsEnabled ?? false;
  const readiness = settings?.smsReadiness;

  return (
    <div className="space-y-3 max-w-2xl">
      <h2 className="text-white font-semibold">Configuration</h2>
      <div className="bg-surface-50 border border-gray-700 rounded-lg p-4 space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <p className="text-sm text-white">Text messages (SMS)</p>
            <p className="text-xs text-gray-500">
              Sign-in codes, phone verification, texted receipts and payout reminders by text.
              While off, they're hidden everywhere, and phone numbers are kept but can't be
              verified.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={on}
            aria-label="Text messages (SMS)"
            onClick={() => mutation.mutate(!on)}
            disabled={mutation.isPending || settings === undefined}
            className={`shrink-0 mt-0.5 w-11 h-6 rounded-full transition-colors disabled:opacity-40 ${on ? 'bg-brand-600' : 'bg-surface-200'}`}
          >
            <span
              className={`block w-5 h-5 bg-white rounded-full transition-transform ${on ? 'translate-x-5' : 'translate-x-0.5'}`}
            />
          </button>
        </div>
        {/* Said only while on: off, nothing is meant to leave, so nothing is wrong. */}
        {on && readiness && !readiness.originationNumber && (
          <p className="text-xs text-amber-400">No origination number is set, so texts are logged, not sent.</p>
        )}
        {on && readiness && !readiness.outboundNotifications && (
          <p className="text-xs text-amber-400">Outbound notifications are off, so nothing is sent.</p>
        )}
        {settings?.updatedBy && (
          <p className="text-xs text-gray-600">
            Last changed by {settings.updatedBy}, {new Date(settings.updatedAt).toLocaleString()}
          </p>
        )}
        {mutation.isError && (
          <p className="text-xs text-red-400">
            {mutation.error instanceof ApiError ? mutation.error.message : 'Could not save that.'}
          </p>
        )}
      </div>
    </div>
  );
}
