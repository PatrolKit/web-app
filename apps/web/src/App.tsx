import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './contexts/AuthContext';
import AppShell from './components/AppShell';
import LoginPage from './pages/auth/LoginPage';
import VerifyPage from './pages/auth/VerifyPage';
import MembersPage from './pages/members/MembersPage';
import ModulesPage from './pages/modules/ModulesPage';
import DevicesPage from './pages/devices/DevicesPage';
import AdminPage from './pages/admin/AdminPage';
import SkiSwapLayout from './pages/ski-swap/SkiSwapLayout';
import SkiSwapDashboard from './pages/ski-swap/SkiSwapDashboard';
import SwapsPage from './pages/ski-swap/SwapsPage';
import ItemsPage from './pages/ski-swap/ItemsPage';
import SellersPage from './pages/ski-swap/SellersPage';
import SquareConfigPage from './pages/ski-swap/SquareConfigPage';
import BusinessSellerPage from './pages/ski-swap/BusinessSellerPage';
import SellerProfilePage from './pages/ski-swap/SellerProfilePage';
import SellerStatusPage from './pages/public/SellerStatusPage';

function DefaultDashboardRedirect() {
  const { user, activeOrgId } = useAuth();
  const membership = user?.memberships.find((m) => m.orgId === activeOrgId);
  const perms = new Set(membership?.permissions ?? []);
  if (perms.has('users:read')) return <Navigate to="members" replace />;
  if (perms.has('ski_swap:report')) return <Navigate to="ski-swap" replace />;
  if (perms.has('business_seller')) return <Navigate to="ski-swap/my-items" replace />;
  if (perms.has('org:read')) return <Navigate to="modules" replace />;
  return <Navigate to="members" replace />;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route index element={<Navigate to="auth/login" replace />} />
        <Route path="auth/login" element={<LoginPage />} />
        <Route path="auth/verify" element={<VerifyPage />} />
        {/* Public seller-status page (no auth required) */}
        <Route path=":orgSlug/ski-swap/status" element={<SellerStatusPage />} />
        <Route path="dashboard" element={<AppShell />}>
          <Route index element={<DefaultDashboardRedirect />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="modules" element={<ModulesPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="admin" element={<AdminPage />} />
          <Route path="ski-swap" element={<SkiSwapLayout />}>
            <Route index element={<SkiSwapDashboard />} />
            <Route path="swaps" element={<SwapsPage />} />
            <Route path="items" element={<ItemsPage />} />
            <Route path="sellers" element={<SellersPage />} />
            <Route path="config" element={<SquareConfigPage />} />
            <Route path="my-items" element={<BusinessSellerPage />} />
            <Route path="seller-profile" element={<SellerProfilePage />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="auth/login" replace />} />
      </Routes>
    </AuthProvider>
  );
}
