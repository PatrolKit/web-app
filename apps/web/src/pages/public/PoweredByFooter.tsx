export function PoweredByFooter() {
  return (
    <div className="mt-10 flex items-center justify-center gap-1.5 text-gray-600 text-xs select-none">
      <span>Powered by</span>
      {/* 128px, not the 1254px original: this is drawn at fourteen. */}
      <img src="/logo-mark.png" alt="PatrolKit" className="w-3.5 h-3.5 rounded-sm" />
      <span><span className="text-brand-700">Patrol</span>Kit</span>
    </div>
  );
}
