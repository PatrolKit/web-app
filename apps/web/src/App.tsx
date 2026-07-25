import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from './contexts/AuthContext';
import AppShell from './components/AppShell';
import LoginPage from './pages/auth/LoginPage';
import VerifyPage from './pages/auth/VerifyPage';
import MembersPage from './pages/members/MembersPage';
import ModulesPage from './pages/modules/ModulesPage';
import DevicesPage from './pages/devices/DevicesPage';
import AdminPage from './pages/admin/AdminPage';

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route index element={<Navigate to="auth/login" replace />} />
        <Route path="auth/login" element={<LoginPage />} />
        <Route path="auth/verify" element={<VerifyPage />} />
        <Route path="dashboard" element={<AppShell />}>
          <Route index element={<Navigate to="members" replace />} />
          <Route path="members" element={<MembersPage />} />
          <Route path="modules" element={<ModulesPage />} />
          <Route path="devices" element={<DevicesPage />} />
          <Route path="admin" element={<AdminPage />} />
        </Route>
        <Route path="*" element={<Navigate to="auth/login" replace />} />
      </Routes>
    </AuthProvider>
  );
}
