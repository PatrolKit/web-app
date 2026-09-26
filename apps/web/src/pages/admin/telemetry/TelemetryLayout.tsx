import { NavLink, Outlet } from 'react-router-dom';

const navClass = ({ isActive }: { isActive: boolean }) =>
  `text-sm px-3 py-1.5 rounded transition ${isActive ? 'bg-surface-100 text-white' : 'text-gray-400 hover:text-white'}`;

/**
 * Device Telemetry: one sub-tab per kind of device that reports. Print bridges
 * are the only one so far (webprinter_esp32 Plan 4).
 */
export default function TelemetryLayout() {
  return (
    <div className="space-y-4">
      <nav className="flex items-center gap-1 border-b border-gray-800 pb-1">
        <NavLink to="bridges" className={navClass}>Print bridges</NavLink>
      </nav>
      <Outlet />
    </div>
  );
}
