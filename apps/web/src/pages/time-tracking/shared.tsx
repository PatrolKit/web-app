const DUTY_STYLES: Record<string, string> = {
  patrol: 'bg-red-500/15 text-red-400',
  training: 'bg-blue-500/15 text-blue-400',
  instruction: 'bg-green-500/15 text-green-400',
  other: 'bg-gray-500/15 text-gray-400',
};

export function DutyBadge({ dutyType }: { dutyType: string }) {
  const style = DUTY_STYLES[dutyType] ?? DUTY_STYLES.other;
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium capitalize ${style}`}>
      {dutyType}
    </span>
  );
}

export function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export function elapsedLabel(fromIso: string, toIso?: string | null): string {
  const start = new Date(fromIso).getTime();
  const end = toIso ? new Date(toIso).getTime() : Date.now();
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** `datetime-local` wants no timezone suffix; the API wants ISO with one. */
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string {
  return new Date(value).toISOString();
}
