export function PoweredByFooter() {
  return (
    <div className="mt-10 flex items-center justify-center gap-1.5 text-gray-600 text-xs select-none">
      <span>Powered by</span>
      <img src="/logo.png" alt="PatrolKit" className="w-3.5 h-3.5 rounded-sm" />
      <span><span className="text-brand-700">Patrol</span>Kit</span>
    </div>
  );
}
