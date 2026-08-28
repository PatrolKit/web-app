import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api, setAccessToken, clearAccessToken } from '../lib/api';
import type { MeResponse } from '../lib/api.types';

interface AuthContextValue {
  user: MeResponse | null;
  activeOrgId: string | null;
  setActiveOrgId: (id: string) => void;
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<MeResponse | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  // Start true so we don't flash the login page before the silent refresh completes
  const [isLoading, setIsLoading] = useState(true);

  // On mount: attempt a silent token refresh to restore session across page reloads.
  // The refresh token lives in an httpOnly cookie so it survives reloads even though
  // the in-memory access token does not.
  useEffect(() => {
    async function restoreSession() {
      try {
        const { accessToken } = await api.auth.refresh();
        setAccessToken(accessToken);
        const me = await api.me.get();
        setUser(me);
        if (me.memberships.length > 0) {
          setActiveOrgId(me.memberships[0].orgId);
        }
      } catch {
        // No valid refresh token — leave user as null, routing will redirect to login
      } finally {
        setIsLoading(false);
      }
    }
    void restoreSession();
  }, []);

  const login = useCallback(async (token: string) => {
    setAccessToken(token);
    setIsLoading(true);
    try {
      const me = await api.me.get();
      setUser(me);
      if (me.memberships.length > 0) {
        setActiveOrgId(me.memberships[0].orgId);
      }
    } finally {
      setIsLoading(false);
    }
  }, []);

  /**
   * Re-reads who we are signed in as.
   *
   * A seller checking in for the first time signs in on a phone number alone
   * and gives their name a screen later, which leaves the session holding a
   * person with no name. Anything showing that identity back to them is wrong
   * until this runs.
   */
  const refreshUser = useCallback(async () => {
    const me = await api.me.get().catch(() => null);
    if (me) setUser(me);
  }, []);

  const logout = useCallback(async () => {
    await api.auth.logout().catch(() => {});
    clearAccessToken();
    setUser(null);
    setActiveOrgId(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, activeOrgId, setActiveOrgId, login, logout, refreshUser, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
