// Typed API client with in-memory access token + silent refresh on 401
// Access token is NEVER written to localStorage.

let accessToken: string | null = null;

export function setAccessToken(token: string) {
  accessToken = token;
}

export function clearAccessToken() {
  accessToken = null;
}

export function getAccessToken(): string | null {
  return accessToken;
}

async function silentRefresh(): Promise<boolean> {
  try {
    const res = await fetch('/api/v1/auth/refresh', {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { success: boolean; data: { accessToken: string } };
    if (body.success) {
      setAccessToken(body.data.accessToken);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

let refreshPromise: Promise<boolean> | null = null;

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(init.headers as Record<string, string>),
  };
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;

  const res = await fetch(`/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers,
  });

  if (res.status === 401) {
    // One concurrent refresh attempt
    if (!refreshPromise) {
      refreshPromise = silentRefresh().finally(() => { refreshPromise = null; });
    }
    const ok = await refreshPromise;
    if (!ok) {
      clearAccessToken();
      throw new ApiError(401, 'Unauthorized');
    }
    // Retry once with the new token
    return request<T>(path, init);
  }

  const body = await res.json().catch(() => ({ success: false, error: 'Invalid response' }));

  if (!res.ok || !body.success) {
    throw new ApiError(res.status, body.error ?? 'Request failed', body.code);
  }

  return body.data as T;
}

export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

export const api = {
  auth: {
    requestMagicLink: (email: string) =>
      request<{ queued: boolean }>('/auth/magic-link', {
        method: 'POST',
        body: JSON.stringify({ email }),
      }),
    verifyMagicLink: (token: string) =>
      request<{ accessToken: string }>('/auth/magic-link/verify', {
        method: 'POST',
        body: JSON.stringify({ token }),
      }),
    refresh: () =>
      request<{ accessToken: string }>('/auth/refresh', { method: 'POST' }),
    logout: () =>
      request<void>('/auth/logout', { method: 'POST' }),
  },

  me: {
    get: () => request<import('./api.types').MeResponse>('/me'),
    patch: (name: string) =>
      request<import('./api.types').MeResponse>('/me', {
        method: 'PATCH',
        body: JSON.stringify({ name }),
      }),
  },

  orgs: {
    get: (orgId: string) => request<import('./api.types').OrgResponse>(`/orgs/${orgId}`),
    patch: (orgId: string, data: { name?: string; status?: string }) =>
      request<import('./api.types').OrgResponse>(`/orgs/${orgId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
  },

  members: {
    list: (orgId: string) => request<import('./api.types').MemberResponse[]>(`/orgs/${orgId}/members`),
    invite: (orgId: string, data: { email: string; name?: string; permissions: string[] }) =>
      request<import('./api.types').MemberResponse>(`/orgs/${orgId}/members`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (orgId: string, userId: string, data: { status?: string; permissions?: string[] }) =>
      request<import('./api.types').MemberResponse>(`/orgs/${orgId}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    remove: (orgId: string, userId: string) =>
      request<void>(`/orgs/${orgId}/members/${userId}`, { method: 'DELETE' }),
    importCsv: (orgId: string, file: File, sendInvites = false) => {
      const form = new FormData();
      form.append('file', file);
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      return fetch(`/api/v1/orgs/${orgId}/members/import?sendInvites=${sendInvites}`, {
        method: 'POST',
        credentials: 'include',
        headers,
        body: form,
      }).then((r) => r.json() as Promise<{ success: boolean; data: import('./api.types').ImportOutcome[] }>);
    },
    permissions: (orgId: string) =>
      request<{ key: string; description: string }[]>(`/orgs/${orgId}/permissions`),
  },

  modules: {
    list: (orgId: string) => request<import('./api.types').ModuleItem[]>(`/orgs/${orgId}/modules`),
    setEnabled: (orgId: string, key: string, enabled: boolean) =>
      request<import('./api.types').ModuleItem>(`/orgs/${orgId}/modules/${key}`, {
        method: 'PATCH',
        body: JSON.stringify({ enabled }),
      }),
  },

  devices: {
    list: (orgId: string) => request<import('./api.types').DeviceItem[]>(`/orgs/${orgId}/devices`),
    provision: (orgId: string, data: { name: string; permissions: string[] }) =>
      request<import('./api.types').ProvisionedDevice>(`/orgs/${orgId}/devices`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    rotateSecret: (orgId: string, id: string) =>
      request<{ clientSecret: string }>(`/orgs/${orgId}/devices/${id}/rotate-secret`, { method: 'POST' }),
    revoke: (orgId: string, id: string) =>
      request<void>(`/orgs/${orgId}/devices/${id}`, { method: 'DELETE' }),
  },

  admin: {
    listOrgs: () => request<import('./api.types').PlatformOrg[]>('/admin/organizations'),
    createOrg: (data: { name: string; slug: string; ownerEmail: string }) =>
      request<import('./api.types').PlatformOrg>('/admin/organizations', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
  },
};
