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
    provision: (orgId: string, data: { name: string; role?: string | null; permissions: string[] }) =>
      request<import('./api.types').ProvisionedDevice>(`/orgs/${orgId}/devices`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateRole: (orgId: string, id: string, role: string | null) =>
      request<import('./api.types').DeviceItem>(`/orgs/${orgId}/devices/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
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

  skiSwap: {
    // Square config
    getConfig: (orgId: string) =>
      request<import('./api.types').SquareConfigResponse>(`/orgs/${orgId}/ski-swap/config`),
    upsertConfig: (orgId: string, data: { accessToken: string; environment: 'sandbox' | 'production' }) =>
      request<import('./api.types').SquareConfigResponse>(`/orgs/${orgId}/ski-swap/config`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    deleteConfig: (orgId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/config`, { method: 'DELETE' }),
    testConnection: (orgId: string) =>
      request<{ success: boolean; message: string }>(`/orgs/${orgId}/ski-swap/config/test`, { method: 'POST' }),
    getStatus: (orgId: string) =>
      request<{ squareConfigured: boolean }>(`/orgs/${orgId}/ski-swap/config/status`),
    resetOrgData: (orgId: string) =>
      request<{ deletedItems: number; deletedSellers: number }>(`/orgs/${orgId}/ski-swap/config/reset-data`, { method: 'DELETE' }),
    listLocations: (orgId: string) =>
      request<{ locations: { id: string; name: string }[] }>(`/orgs/${orgId}/ski-swap/config/locations`),

    // Swaps
    listSwaps: (orgId: string, active?: boolean) =>
      request<import('./api.types').SwapResponse[]>(`/orgs/${orgId}/ski-swap/swaps${active !== undefined ? `?active=${active}` : ''}`),
    createSwap: (orgId: string, title: string, locationId: string) =>
      request<import('./api.types').SwapResponse>(`/orgs/${orgId}/ski-swap/swaps`, {
        method: 'POST', body: JSON.stringify({ title, locationId }),
      }),
    patchSwap: (orgId: string, swapId: string, data: { title?: string; active?: boolean; locationId?: string }) =>
      request<import('./api.types').SwapResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteSwap: (orgId: string, swapId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/swaps/${swapId}`, { method: 'DELETE' }),

    // Stats
    getStats: (orgId: string, swapId: string) =>
      request<import('./api.types').SwapStats>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/stats`),

    // Items
    listItems: (orgId: string, swapId: string, opts?: { query?: string; sellerId?: string; skip?: number; take?: number }) => {
      const params = new URLSearchParams();
      if (opts?.query) params.set('query', opts.query);
      if (opts?.sellerId) params.set('sellerId', opts.sellerId);
      if (opts?.skip !== undefined) params.set('skip', String(opts.skip));
      if (opts?.take !== undefined) params.set('take', String(opts.take));
      const qs = params.toString();
      return request<{ items: import('./api.types').ItemResponse[]; total: number }>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/items${qs ? `?${qs}` : ''}`
      );
    },
    createItem: (orgId: string, swapId: string, data: { name: string; description?: string; priceCents: number; quantity: number; sellerId?: string; donateProceeds?: boolean }) =>
      request<import('./api.types').ItemResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchItem: (orgId: string, swapId: string, itemId: string, data: { name?: string; description?: string | null; priceCents?: number; quantity?: number; sellerId?: string | null; donateProceeds?: boolean }) =>
      request<import('./api.types').ItemResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteItem: (orgId: string, swapId: string, itemId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}`, { method: 'DELETE' }),
    uploadPhoto: (orgId: string, swapId: string, itemId: string, file: File) => {
      const form = new FormData();
      form.append('image', file);
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      return fetch(`/api/v1/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}/photos`, {
        method: 'POST', credentials: 'include', headers, body: form,
      }).then((r) => r.json() as Promise<{ success: boolean; data: { id: string; url: string } }>);
    },
    deletePhoto: (orgId: string, swapId: string, itemId: string, photoId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}/photos/${photoId}`, { method: 'DELETE' }),

    // Sellers
    listSellers: (orgId: string, query?: string) =>
      request<import('./api.types').SellerResponse[]>(`/orgs/${orgId}/ski-swap/sellers${query ? `?query=${encodeURIComponent(query)}` : ''}`),
    createSeller: (orgId: string, data: { name: string; phone: string; email?: string; type?: 'individual' | 'business'; street?: string; city?: string; state?: string; zip?: string; payoutMethod?: string; payoutIdentifierType?: string; payoutIdentifier?: string }) =>
      request<import('./api.types').SellerResponse>(`/orgs/${orgId}/ski-swap/sellers`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchSeller: (orgId: string, sellerId: string, data: Partial<{ name: string; phone: string; email: string | null; type: 'individual' | 'business'; street: string | null; city: string | null; state: string | null; zip: string | null; payoutMethod: string | null; payoutIdentifierType: string | null; payoutIdentifier: string | null }>) =>
      request<import('./api.types').SellerResponse>(`/orgs/${orgId}/ski-swap/sellers/${sellerId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteSeller: (orgId: string, sellerId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/sellers/${sellerId}`, { method: 'DELETE' }),
    downloadSellerTemplate: (orgId: string) => `/api/v1/orgs/${orgId}/ski-swap/sellers/import/template`,
    parseSellerCsv: (orgId: string, file: File) => {
      const form = new FormData();
      form.append('file', file);
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      return fetch(`/api/v1/orgs/${orgId}/ski-swap/sellers/import/parse`, {
        method: 'POST', credentials: 'include', headers, body: form,
      }).then((r) => r.json() as Promise<{ success: boolean; data: { headers: string[]; mapping: Record<string, string>; preview: Record<string, string>[]; totalRows: number } }>);
    },
    importSellers: (orgId: string, file: File, mapping: Record<string, string>, duplicateStrategy: 'overwrite' | 'preserve') => {
      const form = new FormData();
      form.append('file', file);
      form.append('mapping', JSON.stringify(mapping));
      form.append('duplicateStrategy', duplicateStrategy);
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      return fetch(`/api/v1/orgs/${orgId}/ski-swap/sellers/import`, {
        method: 'POST', credentials: 'include', headers, body: form,
      }).then((r) => r.json() as Promise<{ success: boolean; data: { row: number; outcome: string; name?: string; phone?: string; error?: string }[] }>);
    },
  },
};
