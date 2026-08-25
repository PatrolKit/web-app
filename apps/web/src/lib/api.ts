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

/** Person fields are global (they live on User); businessName is org-scoped. */
export type SellerWrite = Partial<{
  firstName: string | null;
  lastName: string | null;
  phone: string | null;
  email: string | null;
  businessName: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  payoutMethod: string | null;
  payoutChannel: 'email' | 'phone' | null;
}>;

export const api = {
  auth: {
    /** One login, two channels — pass exactly one of email or phone. */
    login: (input: { email: string } | { phone: string }) =>
      request<{
        queued: true;
        challengeId: string | null;
        channel: 'email' | 'phone' | null;
        /** Present only when OUTBOUND_NOTIFICATIONS is off, so dev can complete the flow. */
        devCode?: string;
      }>('/auth/login', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    /** Confirming verifies the contact and, for login/invite, mints the session. */
    confirmChallenge: (challengeId: string, code: string) =>
      request<{ accessToken: string | null; verified: true }>(
        `/auth/challenges/${challengeId}/confirm`,
        { method: 'POST', body: JSON.stringify({ code }) },
      ),
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
    patch: (orgId: string, data: { name?: string; status?: string; slug?: string }) =>
      request<import('./api.types').OrgResponse>(`/orgs/${orgId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    uploadLogo: (orgId: string, file: File): Promise<import('./api.types').OrgResponse> => {
      const form = new FormData();
      form.append('file', file);
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      return fetch(`/api/v1/orgs/${orgId}/logo`, {
        method: 'POST', credentials: 'include', headers, body: form,
      }).then(async (r) => {
        const body = await r.json().catch(() => ({ success: false, error: 'Invalid response' }));
        if (!r.ok || !body.success) throw new ApiError(r.status, body.error ?? body.message ?? 'Upload failed', body.code);
        return body.data as import('./api.types').OrgResponse;
      });
    },
    deleteLogo: (orgId: string) =>
      request<import('./api.types').OrgResponse>(`/orgs/${orgId}/logo`, { method: 'DELETE' }),

    // Resorts — org-level, consumed by time tracking
    listResorts: (orgId: string) =>
      request<import('./api.types').ResortResponse[]>(`/orgs/${orgId}/resorts`),
    createResort: (orgId: string, data: import('./api.types').ResortInput & { name: string }) =>
      request<import('./api.types').ResortResponse>(`/orgs/${orgId}/resorts`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchResort: (orgId: string, resortId: string, data: import('./api.types').ResortInput) =>
      request<import('./api.types').ResortResponse>(`/orgs/${orgId}/resorts/${resortId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteResort: (orgId: string, resortId: string) =>
      request<void>(`/orgs/${orgId}/resorts/${resortId}`, { method: 'DELETE' }),
  },

  members: {
    list: (orgId: string) => request<import('./api.types').MemberResponse[]>(`/orgs/${orgId}/members`),
    invite: (orgId: string, data: { email: string; firstName?: string; lastName?: string; phone?: string; permissions: string[] }) =>
      request<import('./api.types').MemberResponse>(`/orgs/${orgId}/members`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (orgId: string, userId: string, data: { removed?: boolean; permissions?: string[] }) =>
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
    provision: (orgId: string, data: { name: string; role: import('./api.types').DeviceRole; permissions: string[] }) =>
      request<import('./api.types').ProvisionedDevice>(`/orgs/${orgId}/devices`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateRole: (orgId: string, id: string, role: import('./api.types').DeviceRole) =>
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
    patchItem: (orgId: string, swapId: string, itemId: string, data: { name?: string; description?: string | null; priceCents?: number; quantity?: number; sellerId?: string | null; donateProceeds?: boolean; hasPrintedTag?: boolean }) =>
      request<import('./api.types').ItemResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteItem: (orgId: string, swapId: string, itemId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}`, { method: 'DELETE' }),
    uploadPhoto: async (orgId: string, swapId: string, itemId: string, file: File): Promise<{ id: string; url: string }> => {
      const form = new FormData();
      form.append('image', file);
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      const res = await fetch(`/api/v1/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}/photos`, {
        method: 'POST', credentials: 'include', headers, body: form,
      });
      const body = await res.json().catch(() => ({ success: false, error: 'Invalid response' })) as { success: boolean; data?: { id: string; url: string }; error?: string };
      if (!res.ok || !body.success) throw new ApiError(res.status, body.error ?? 'Photo upload failed');
      return body.data!;
    },
    deletePhoto: (orgId: string, swapId: string, itemId: string, photoId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}/photos/${photoId}`, { method: 'DELETE' }),

    // Sellers
    listSellers: (orgId: string, query?: string) =>
      request<import('./api.types').SellerResponse[]>(`/orgs/${orgId}/ski-swap/sellers${query ? `?query=${encodeURIComponent(query)}` : ''}`),
    createSeller: (orgId: string, data: SellerWrite) =>
      request<import('./api.types').SellerResponse>(`/orgs/${orgId}/ski-swap/sellers`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchSeller: (orgId: string, sellerId: string, data: SellerWrite) =>
      request<import('./api.types').SellerResponse>(`/orgs/${orgId}/ski-swap/sellers/${sellerId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteSeller: (orgId: string, sellerId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/sellers/${sellerId}`, { method: 'DELETE' }),
    initiateVerification: (orgId: string, sellerId: string, channel: 'email' | 'phone') =>
      request<{ challengeId: string; devCode?: string }>(
        `/orgs/${orgId}/ski-swap/sellers/${sellerId}/verify/${channel}/initiate`,
        { method: 'POST' },
      ),
    /** Name-only cross-org lookup; the full record follows staff confirmation. */
    searchPeople: (orgId: string, input: { email?: string; phone?: string }) =>
      request<import('./api.types').PersonSearchResult[]>(`/orgs/${orgId}/ski-swap/sellers/search`, {
        method: 'POST', body: JSON.stringify(input),
      }),
    addSellerFromPerson: (orgId: string, userId: string) =>
      request<import('./api.types').SellerResponse>(`/orgs/${orgId}/ski-swap/sellers/from-person`, {
        method: 'POST', body: JSON.stringify({ userId }),
      }),
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

    // Business sellers (admin)
    inviteBusinessSeller: (orgId: string, data: { businessName: string; email: string }) =>
      request<import('./api.types').BusinessSellerMember>(`/orgs/${orgId}/ski-swap/business-sellers`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    listBusinessSellers: (orgId: string) =>
      request<import('./api.types').BusinessSellerMember[]>(`/orgs/${orgId}/ski-swap/business-sellers`),
    setBusinessSellerRemoved: (orgId: string, userId: string, removed: boolean) =>
      request<import('./api.types').BusinessSellerMember>(`/orgs/${orgId}/ski-swap/business-sellers/${userId}/status`, {
        method: 'PATCH', body: JSON.stringify({ removed }),
      }),
    searchBusinesses: (orgId: string, q: string) =>
      request<{ businessName: string; userId: string }[]>(`/orgs/${orgId}/ski-swap/business-sellers/search?q=${encodeURIComponent(q)}`),
    removeBusinessSeller: (orgId: string, userId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/business-sellers/${userId}`, { method: 'DELETE' }),

    // Seller self-service
    sellerGetProfile: (orgId: string) =>
      request<import('./api.types').SellerResponse>(`/orgs/${orgId}/ski-swap/seller/me`),
    sellerUpdateProfile: (orgId: string, data: SellerWrite) =>
      request<import('./api.types').SellerResponse>(`/orgs/${orgId}/ski-swap/seller/me`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    sellerListSwaps: (orgId: string) =>
      request<{ id: string; title: string }[]>(`/orgs/${orgId}/ski-swap/seller/me/swaps`),
    sellerListItems: (orgId: string, swapId?: string) =>
      request<{ items: import('./api.types').ItemResponse[]; total: number }>(
        `/orgs/${orgId}/ski-swap/seller/me/items${swapId ? `?swapId=${swapId}` : ''}`
      ),
    sellerCreateItem: (orgId: string, data: { swapId: string; name: string; description?: string; priceCents: number; quantity: number; donateProceeds?: boolean }) =>
      request<import('./api.types').ItemResponse>(`/orgs/${orgId}/ski-swap/seller/me/items`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    sellerPatchItem: (orgId: string, itemId: string, data: { name?: string; description?: string | null; priceCents?: number; quantity?: number; donateProceeds?: boolean; hasPrintedTag?: boolean }) =>
      request<import('./api.types').ItemResponse>(`/orgs/${orgId}/ski-swap/seller/me/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    sellerDeleteItem: (orgId: string, itemId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/seller/me/items/${itemId}`, { method: 'DELETE' }),
    sellerUploadPhoto: async (orgId: string, itemId: string, file: File): Promise<{ id: string; url: string }> => {
      const form = new FormData();
      form.append('image', file);
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      const res = await fetch(`/api/v1/orgs/${orgId}/ski-swap/seller/me/items/${itemId}/photos`, {
        method: 'POST', credentials: 'include', headers, body: form,
      });
      const body = await res.json().catch(() => ({ success: false, error: 'Invalid response' })) as { success: boolean; data?: { id: string; url: string }; error?: string };
      if (!res.ok || !body.success) throw new ApiError(res.status, body.error ?? 'Photo upload failed');
      return body.data!;
    },
    sellerDeletePhoto: (orgId: string, itemId: string, photoId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/seller/me/items/${itemId}/photos/${photoId}`, { method: 'DELETE' }),

    // Printers
    listPrinters: (orgId: string) =>
      request<import('./api.types').SwapPrinterRecord[]>(`/orgs/${orgId}/ski-swap/printers`),
    createPrinter: (orgId: string, data: { name: string; bluetoothName: string; paperSize: string }) =>
      request<import('./api.types').SwapPrinterRecord>(`/orgs/${orgId}/ski-swap/printers`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchPrinter: (orgId: string, printerId: string, data: { name?: string; bluetoothName?: string; assignedSellerId?: string | null; paperSize?: string; marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number }) =>
      request<import('./api.types').SwapPrinterRecord>(`/orgs/${orgId}/ski-swap/printers/${printerId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    patchPrinterPaperSize: (orgId: string, printerId: string, paperSize: string) =>
      request<import('./api.types').SwapPrinterRecord>(`/orgs/${orgId}/ski-swap/printers/${printerId}/paper-size`, {
        method: 'PATCH', body: JSON.stringify({ paperSize }),
      }),
    deletePrinter: (orgId: string, printerId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/printers/${printerId}`, { method: 'DELETE' }),
    sellerListPrinters: (orgId: string) =>
      request<import('./api.types').SwapPrinterRecord[]>(`/orgs/${orgId}/ski-swap/seller/me/printers`),

    // Settings
    getSettings: (orgId: string) =>
      request<import('./api.types').SkiSwapSettings>(`/orgs/${orgId}/ski-swap/settings`),
    updateSettings: (orgId: string, data: { labelsPerItem: number }) =>
      request<import('./api.types').SkiSwapSettings>(`/orgs/${orgId}/ski-swap/settings`, {
        method: 'PUT', body: JSON.stringify(data),
      }),
  },

  timeClock: {
    // Settings
    getSettings: (orgId: string) =>
      request<import('./api.types').TimeClockSettingsResponse>(`/orgs/${orgId}/time-clock/settings`),
    updateSettings: (orgId: string, data: { autoCloseLocalTime?: string; autoCloseAfterHours?: number }) =>
      request<import('./api.types').TimeClockSettingsResponse>(`/orgs/${orgId}/time-clock/settings`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),

    // Roster
    listPatrollers: (orgId: string) =>
      request<import('./api.types').PatrollerResponse[]>(`/orgs/${orgId}/time-clock/patrollers`),
    createPatroller: (orgId: string, data: { firstName: string; lastName: string; nspId: string; patrolLevel?: string | null }) =>
      request<import('./api.types').PatrollerResponse>(`/orgs/${orgId}/time-clock/patrollers`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchPatroller: (
      orgId: string,
      patrollerId: string,
      data: { firstName?: string; lastName?: string; nspId?: string; patrolLevel?: string | null; active?: boolean },
    ) =>
      request<import('./api.types').PatrollerResponse & { closedShiftId: string | null }>(
        `/orgs/${orgId}/time-clock/patrollers/${patrollerId}`,
        { method: 'PATCH', body: JSON.stringify(data) },
      ),
    deletePatroller: (orgId: string, patrollerId: string) =>
      request<{ closedShiftId: string | null }>(`/orgs/${orgId}/time-clock/patrollers/${patrollerId}`, {
        method: 'DELETE',
      }),
    importPatrollers: (
      orgId: string,
      rows: { firstName: string; lastName: string; nspId: string; patrolLevel?: string | null }[],
      strategy: 'preserve' | 'overwrite',
    ) =>
      request<{ created: number; updated: number; skipped: number; errors: string[] }>(
        `/orgs/${orgId}/time-clock/patrollers/import`,
        { method: 'POST', body: JSON.stringify({ rows, strategy }) },
      ),

    // Shifts
    listShifts: (
      orgId: string,
      params: { resortId?: string; status?: string; from?: string; to?: string; dutyType?: string; pastSweep?: boolean } = {},
    ) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => {
        if (v !== undefined && v !== '' && v !== false) qs.set(k, String(v));
      });
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('./api.types').ShiftResponse[]>(`/orgs/${orgId}/time-clock/shifts${suffix}`);
    },
    patchShift: (
      orgId: string,
      shiftId: string,
      data: { clockInAt?: string; clockOutAt?: string | null; dutyType?: string; dutyNote?: string | null },
    ) =>
      request<import('./api.types').ShiftResponse>(`/orgs/${orgId}/time-clock/shifts/${shiftId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),

    // Reports
    hours: (orgId: string, params: { from?: string; to?: string; resortId?: string; dutyType?: string } = {}) => {
      const qs = new URLSearchParams();
      Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, String(v)); });
      const suffix = qs.toString() ? `?${qs}` : '';
      return request<import('./api.types').HoursReportRow[]>(`/orgs/${orgId}/time-clock/reports/hours${suffix}`);
    },
  },

  public: {
    getSellerDetail: (sellerId: string) =>
      request<import('./api.types').PublicSellerDetailResponse>(`/public/sellers/${sellerId}`),
    getOrgBranding: (orgSlug: string) =>
      request<import('./api.types').OrgBrandingResponse>(`/public/${encodeURIComponent(orgSlug)}/ski-swap/branding`),
    findSeller: (orgSlug: string, email: string, last4: string) =>
      request<import('./api.types').SellerFindResponse>(
        `/public/${encodeURIComponent(orgSlug)}/ski-swap/seller-find?email=${encodeURIComponent(email)}&last4=${encodeURIComponent(last4)}`,
      ),
  },
};
