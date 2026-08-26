import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './contexts/AuthContext';
import AppShell from './components/AppShell';
import LoginPage from './pages/auth/LoginPage';
import VerifyPage from './pages/auth/VerifyPage';
import MembersPage from './pages/members/MembersPage';
import DevicesPage from './pages/devices/DevicesPage';
import AdminPage from './pages/admin/AdminPage';
import SkiSwapLayout from './pages/ski-swap/SkiSwapLayout';
import TimeTrackingLayout from './pages/time-tracking/TimeTrackingLayout';
import OnShiftPage from './pages/time-tracking/OnShiftPage';
import ShiftsPage from './pages/time-tracking/ShiftsPage';
import HoursReportPage from './pages/time-tracking/HoursReportPage';
import RosterPage from './pages/time-tracking/RosterPage';
import TimeTrackingSettingsPage from './pages/time-tracking/SettingsPage';
import SignageLayout, { SignagePlaceholder } from './pages/signage/SignageLayout';
import SkiSwapDashboard from './pages/ski-swap/SkiSwapDashboard';
import SwapsPage from './pages/ski-swap/SwapsPage';
import ItemsPage from './pages/ski-swap/ItemsPage';
import SellersPage from './pages/ski-swap/SellersPage';
import AdministrationPage from './pages/ski-swap/AdministrationPage';
import BusinessSellerPage from './pages/ski-swap/BusinessSellerPage';
import SellerProfilePage from './pages/ski-swap/SellerProfilePage';
import SellerStatusPage from './pages/public/SellerStatusPage';
import SellerItemsPage from './pages/public/SellerItemsPage';
import OrgSellerLookupPage from './pages/public/OrgSellerLookupPage';
import OrgAdminLayout from './pages/org/OrgAdminLayout';
import OrgGeneralPage from './pages/org/OrgGeneralPage';
import OrgResortsPage from './pages/org/OrgResortsPage';
import OrgModulesPage from './pages/org/OrgModulesPage';
import CheckinPage from './pages/checkin/CheckinPage';

// Evaluated once at module load — never changes for a given page load.
const isSellerSite = window.location.hostname.startsWith('skiswap.');

function DefaultDashboardRedirect() {
  const { user, activeOrgId } = useAuth();
  const membership = user?.memberships.find((m) => m.orgId === activeOrgId);
  const perms = new Set(membership?.permissions ?? []);
  if (perms.has('users:read')) return <Navigate to="members" replace />;
  if (perms.has('ski_swap:report')) return <Navigate to="ski-swap" replace />;
  // Being a seller is a role derived from a live profile row, not a permission.
  // `business_seller` was retired with the identity consolidation, so this test
  // had been quietly failing for every seller.
  if (membership?.roles.includes('seller')) return <Navigate to="ski-swap/my-items" replace />;
  if (perms.has('org:manage')) return <Navigate to="org-admin" replace />;
  return <Navigate to="members" replace />;
}

export default function App() {
  if (isSellerSite) {
    // Check-in is the first authenticated surface on this host, so the branch
    // gains the provider. The public pages below never consult it — they render
    // for anyone with the link, exactly as before.
    return (
      <AuthProvider>
        <Routes>
          <Route path="checkin" element={<CheckinPage />} />
          {/* The router's basename is already /app here, so this answers the
              /app/auth/verify a sign-in link points at. */}
          <Route path="auth/verify" element={<VerifyPage />} />
          <Route path="s/:sellerId" element={<SellerItemsPage />} />
          <Route path=":orgSlug/ski-swap/status" element={<SellerStatusPage />} />
          {/* Last: a bare slug is the org lookup, so it must not shadow the
              static segments above it. */}
          <Route path=":orgSlug" element={<OrgSellerLookupPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    );
  }

  return (
    <AuthProvider>
      <Routes>
        <Route index element={<Navigate to="auth/login" replace />} />
        <Route path="auth/login" element={<LoginPage />} />
        <Route path="auth/verify" element={<VerifyPage />} />
        {/* Check-in also answers on the staff host, for local development where
            there is no skiswap.* subdomain to branch on. */}
        <Route path="checkin" element={<CheckinPage />} />
        {/* Public seller-status page (no auth required) */}
        <Route path=":orgSlug/ski-swap/status" element={<SellerStatusPage />} />
        {/* Seller website public routes */}
        <Route path="s/:sellerId" element={<SellerItemsPage />} />
        <Route path="dashboard" element={<AppShell />}>
          <Route index element={<DefaultDashboardRedirect />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="admin" element={<AdminPage />} />
          {/* Modules used to be its own nav item; keep old links working. */}
          <Route path="modules" element={<Navigate to="/dashboard/org-admin/modules" replace />} />
          <Route path="org-admin" element={<OrgAdminLayout />}>
            <Route index element={<OrgGeneralPage />} />
            <Route path="resorts" element={<OrgResortsPage />} />
            <Route path="modules" element={<OrgModulesPage />} />
          </Route>
          <Route path="ski-swap" element={<SkiSwapLayout />}>
            <Route index element={<SkiSwapDashboard />} />
            <Route path="swaps" element={<SwapsPage />} />
            <Route path="items" element={<ItemsPage />} />
            <Route path="sellers" element={<SellersPage />} />
            <Route path="config" element={<AdministrationPage />} />
            <Route path="my-items" element={<BusinessSellerPage />} />
            <Route path="seller-profile" element={<SellerProfilePage />} />
          </Route>
          <Route path="time-tracking" element={<TimeTrackingLayout />}>
            <Route index element={<OnShiftPage />} />
            <Route path="shifts" element={<ShiftsPage />} />
            <Route path="hours" element={<HoursReportPage />} />
            <Route path="roster" element={<RosterPage />} />
            <Route path="settings" element={<TimeTrackingSettingsPage />} />
          </Route>
          <Route path="signage" element={<SignageLayout />}>
            <Route index element={<SignagePlaceholder />} />
          </Route>
        </Route>
        {/* Org seller lookup — broad catch-all; must be before the * redirect */}
        <Route path=":orgSlug" element={<OrgSellerLookupPage />} />
        <Route path="*" element={<Navigate to="auth/login" replace />} />
      </Routes>
    </AuthProvider>
  );
}
