import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './contexts/AuthContext';
import AppShell from './components/AppShell';
import LoginPage from './pages/auth/LoginPage';
import VerifyPage from './pages/auth/VerifyPage';
import MembersPage from './pages/members/MembersPage';
import AdminLayout from './pages/admin/AdminLayout';
import OrganizationsTab from './pages/admin/OrganizationsTab';
import UsersTab from './pages/admin/UsersTab';
import SkiSwapLayout from './pages/ski-swap/SkiSwapLayout';
import TimeTrackingLayout from './pages/time-tracking/TimeTrackingLayout';
import OnShiftPage from './pages/time-tracking/OnShiftPage';
import ShiftsPage from './pages/time-tracking/ShiftsPage';
import HoursReportPage from './pages/time-tracking/HoursReportPage';
import RosterPage from './pages/time-tracking/RosterPage';
import TimeTrackingSettingsPage from './pages/time-tracking/SettingsPage';
import DeviceSoftwareTab from './pages/admin/DeviceSoftwareTab';
import ItemTaxonomyTab from './pages/admin/ItemTaxonomyTab';
import BindingIndemnificationTab from './pages/admin/BindingIndemnificationTab';
import ServerHealthTab from './pages/admin/ServerHealthTab';
import ConfigurationTab from './pages/admin/ConfigurationTab';
import TelemetryLayout from './pages/admin/telemetry/TelemetryLayout';
import PrintBridgeTelemetry from './pages/admin/telemetry/PrintBridgeTelemetry';
import SignageLayout, { SignagePlaceholder } from './pages/signage/SignageLayout';
import SignageDevicesPage from './pages/signage/DevicesPage';
import SkiSwapDashboard from './pages/ski-swap/SkiSwapDashboard';
import CheckinStationsPage from './pages/ski-swap/CheckinStationsPage';
import BindingsPage from './pages/ski-swap/BindingsPage';
import PrintersPage from './pages/ski-swap/PrintersPage';
import TimeClockDevicesPage from './pages/time-tracking/DevicesPage';
import SwapsPage from './pages/ski-swap/SwapsPage';
import ItemsPage from './pages/ski-swap/ItemsPage';
import SellersPage from './pages/ski-swap/SellersPage';
import PayoutsPage from './pages/ski-swap/PayoutsPage';
import PayoutRunPage from './pages/ski-swap/PayoutRunPage';
import AdministrationPage from './pages/ski-swap/AdministrationPage';
import ReportsLayout from './pages/ski-swap/ReportsLayout';
import SalesCheckPage from './pages/ski-swap/SalesCheckPage';
import CatalogCheckPage from './pages/ski-swap/CatalogCheckPage';
import AdministrationLayout from './pages/ski-swap/AdministrationLayout';
import ItemDetailsPage from './pages/ski-swap/ItemDetailsPage';
import BusinessSellerPage from './pages/ski-swap/BusinessSellerPage';
import SellerProfilePage from './pages/ski-swap/SellerProfilePage';
import SellerItemsPage from './pages/public/SellerItemsPage';
import OrgSellerLookupPage from './pages/public/OrgSellerLookupPage';
import SkuStatusPage from './pages/public/SkuStatusPage';
import OrgAdminLayout from './pages/org/OrgAdminLayout';
import OrgGeneralPage from './pages/org/OrgGeneralPage';
import OrgResortsPage from './pages/org/OrgResortsPage';
import OrgModulesPage from './pages/org/OrgModulesPage';
import CheckinPage from './pages/checkin/CheckinPage';
import ReceiptPage from './pages/ReceiptPage';
import { useEffect } from 'react';
import { staffSiteUrl } from './lib/sellerSiteUrl';

// Evaluated once at module load — never changes for a given page load.
const isSellerSite = window.location.hostname.startsWith('skiswap.');

/**
 * A page the seller site doesn't have: logging in, the dashboard, anything
 * else. It's on the staff site at the same address, so go there. The seller
 * site used to send these back to its own root, which rendered nothing, so its
 * home page's Log in went nowhere.
 */
function ToStaffSite() {
  useEffect(() => { window.location.replace(staffSiteUrl(window.location)); }, []);
  return null;
}

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
          {/* A receipt link from an email or a text. Public: the token is
              the credential, and it names one check-in rather than a seller. */}
          <Route path="r/:token" element={<ReceiptPage />} />
          {/* A swap's public SKU lookup (Plan 33). */}
          <Route path=":orgSlug/:swapSlug/status" element={<SkuStatusPage />} />
          {/* Staff pages, before the slug below would read "dashboard" as an org. */}
          <Route path="auth/*" element={<ToStaffSite />} />
          <Route path="dashboard/*" element={<ToStaffSite />} />
          {/* Last: a bare slug is the org lookup, so it must not shadow the
              static segments above it. */}
          <Route path=":orgSlug" element={<OrgSellerLookupPage />} />
          {/* Logging in, the dashboard and the rest live on the staff site. */}
          <Route index element={<ToStaffSite />} />
          <Route path="*" element={<ToStaffSite />} />
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
        {/* Seller website public routes */}
        <Route path="s/:sellerId" element={<SellerItemsPage />} />
        {/* Also on the staff host, for local development where there is no
            seller subdomain to branch on — same reason `checkin` is above. */}
        <Route path="r/:token" element={<ReceiptPage />} />
        <Route path="dashboard" element={<AppShell />}>
          <Route index element={<DefaultDashboardRedirect />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="admin" element={<AdminLayout />}>
            <Route index element={<OrganizationsTab />} />
            <Route path="users" element={<UsersTab />} />
            <Route path="device-software" element={<DeviceSoftwareTab />} />
            <Route path="item-taxonomy" element={<ItemTaxonomyTab />} />
            <Route path="bindings" element={<BindingIndemnificationTab />} />
            <Route path="health" element={<ServerHealthTab />} />
            <Route path="telemetry" element={<TelemetryLayout />}>
              <Route index element={<Navigate to="bridges" replace />} />
              <Route path="bridges" element={<PrintBridgeTelemetry />} />
            </Route>
            <Route path="configuration" element={<ConfigurationTab />} />
          </Route>
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
            <Route path="payouts" element={<PayoutsPage />} />
            <Route path="payouts/:runId" element={<PayoutRunPage />} />
            <Route path="reports" element={<ReportsLayout />}>
              <Route index element={<SalesCheckPage />} />
              <Route path="catalog" element={<CatalogCheckPage />} />
            </Route>
            <Route path="check-in" element={<CheckinStationsPage />} />
            <Route path="bindings" element={<BindingsPage />} />
            <Route path="printers" element={<PrintersPage />} />
            <Route path="config" element={<AdministrationLayout />}>
              <Route index element={<AdministrationPage />} />
              <Route path="item-details" element={<ItemDetailsPage />} />
            </Route>
            <Route path="my-items" element={<BusinessSellerPage />} />
            <Route path="seller-profile" element={<SellerProfilePage />} />
          </Route>
          <Route path="time-tracking" element={<TimeTrackingLayout />}>
            <Route index element={<OnShiftPage />} />
            <Route path="shifts" element={<ShiftsPage />} />
            <Route path="hours" element={<HoursReportPage />} />
            <Route path="roster" element={<RosterPage />} />
            <Route path="devices" element={<TimeClockDevicesPage />} />
            <Route path="settings" element={<TimeTrackingSettingsPage />} />
          </Route>
          <Route path="signage" element={<SignageLayout />}>
            <Route index element={<SignagePlaceholder />} />
            <Route path="devices" element={<SignageDevicesPage />} />
          </Route>
        </Route>
        {/* Local development: the seller site's SKU lookup (Plan 33). */}
        <Route path=":orgSlug/:swapSlug/status" element={<SkuStatusPage />} />
        {/* Org seller lookup — broad catch-all; must be before the * redirect */}
        <Route path=":orgSlug" element={<OrgSellerLookupPage />} />
        <Route path="*" element={<Navigate to="auth/login" replace />} />
      </Routes>
    </AuthProvider>
  );
}
