/**
 * The header a seller-facing page wears.
 *
 * Lifted out of `CheckinShell`, which is where the arrangement was worked out:
 * the org's mark, then what this screen is for as the loudest thing on it, then
 * the context that tells you which swap and which person. Check-in, the receipt
 * and item tracking are the same flow to a seller — they arrive at one from a
 * link on another — so they should not look like three different products.
 *
 * Only the header, not the whole shell: `CheckinShell` is a single column at
 * `max-w-md`, which is right for a form on a phone and too narrow for the
 * tracking table.
 */
export function PublicPageHeader({
  title,
  subtitle,
  logoUrl,
}: {
  title: string;
  /** A string, or lines to set one under another — org first, specifics after. */
  subtitle?: string | string[];
  logoUrl?: string | null;
}) {
  return (
    <header className="space-y-2 text-center">
      {logoUrl && <img src={logoUrl} alt="" className="mx-auto h-12 object-contain" />}
      {/* What this screen is for, and the loudest thing on it. Anything
          explaining it goes in the body underneath. */}
      <h1 className="text-2xl font-bold text-white">{title}</h1>
      {subtitle && (
        // Tighter than the header's own rhythm: these are one thought split
        // across two lines, not two separate things.
        <div className="space-y-0.5">
          {(Array.isArray(subtitle) ? subtitle : [subtitle]).map((line, i) => (
            <p key={line} className={i === 0 ? 'text-sm text-gray-400' : 'text-xs text-gray-500'}>
              {line}
            </p>
          ))}
        </div>
      )}
    </header>
  );
}
