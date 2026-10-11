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


/** The Items page's filters and sort, onto a query string (Plan 39). */
function setListView(params: URLSearchParams, view?: import('./api.types').ItemListView) {
  if (view?.status) params.set('status', view.status);
  if (view?.printed !== undefined) params.set('printed', String(view.printed));
  if (view?.sort) {
    params.set('sort', view.sort);
    params.set('dir', view.dir ?? 'asc');
  }
}
let refreshPromise: Promise<boolean> | null = null;

/** A CSV the API builds, fetched with the session token: a plain link can't carry it. */
async function fetchCsv(url: string): Promise<Blob> {
  const headers: Record<string, string> = {};
  if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
  const res = await fetch(url, { credentials: 'include', headers });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error?.message ?? 'Could not download that file');
  }
  return res.blob();
}

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

  // 204 means "done, nothing to say", so there is no body to parse. Reading one
  // anyway made every delete in the app look like a failure: the row really was
  // removed, `res.json()` rejected on the empty body, the catch below turned
  // that into `success: false`, and the throw stopped react-query from ever
  // invalidating its list. Nothing refreshed, and nothing said why.
  if (res.status === 204 || res.status === 205) {
    return undefined as T;
  }

  const body = await res.json().catch(() => ({ success: false, error: 'Invalid response' }));

  if (!res.ok || !body.success) {
    throw new ApiError(res.status, body.error ?? 'Request failed', body.code, body.details);
  }

  return body.data as T;
}

export class ApiError extends Error {
  /** `details` is what some refusals hand back beside the sentence (e.g. Plan 40's taken tickets). */
  constructor(public status: number, message: string, public code?: string, public details?: unknown) {
    super(message);
    this.name = 'ApiError';
  }
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/** A swap's slug and its Status Page switches (Plan 33), on create or patch. */
export type SwapSettingsWrite = {
  slug?: string;
  /** An IANA zone, for the times on receipts. */
  timeZone?: string;
  skuLookupEnabled?: boolean;
  sellerLookupEnabled?: boolean;
  sellerLoginEnabled?: boolean;
  /** The Receipts tab (Plan 36). */
  receiptMode?: import('./api.types').ReceiptMode;
  receiptShowSku?: boolean;
  receiptShowName?: boolean;
  receiptShowPrice?: boolean;
  receiptLink?: import('./api.types').ReceiptLinkChoice;
  receiptPrintEnabled?: boolean;
  receiptPaperSize?: import('./api.types').ReceiptPaperSize;
  receiptFinePrintEnabled?: boolean;
  receiptFinePrint?: string | null;
};

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
  /** PayPal Payouts' recipient type, or the kind of ID that was typed. */
  payoutTarget: 'EMAIL' | 'PHONE' | 'PAYPAL_ID' | 'VENMO_ID' | null;
  /** The typed value, for PAYPAL_ID and VENMO_ID only. */
  payoutHandle: string | null;
}>;

export const api = {
  auth: {
    /**
     * One login, two channels — pass exactly one of email or phone.
     *
     * `context` says what the sign-in was for. It comes back from confirm, so
     * the flow survives a magic link opening in a fresh tab.
     */
    login: (input: ({ email: string } | { phone: string } | { receiptToken: string }) & { context?: import('./api.types').SignInContext }) =>
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
      request<{
        accessToken: string | null;
        verified: true;
        context?: import('./api.types').SignInContext | null;
      }>(
        `/auth/challenges/${challengeId}/confirm`,
        { method: 'POST', body: JSON.stringify({ code }) },
      ),
    refresh: () =>
      request<{ accessToken: string }>('/auth/refresh', { method: 'POST' }),
    logout: () =>
      request<void>('/auth/logout', { method: 'POST' }),
  },

  /**
   * Self-service check-in. The first two calls are unauthenticated: the seller
   * arrives with nothing but a QR code.
   */
  receipts: {
    /** Staff, for any seller at this swap. */
    send: (orgId: string, sellerId: string, swapId: string) =>
      request<import('./api.types').SendReceiptResponse>(
        `/orgs/${orgId}/ski-swap/sellers/${sellerId}/receipts/send`,
        { method: 'POST', body: JSON.stringify({ swapId }) },
      ),
    /** Staff, without sending: the record iOS and the sellers list both need. */
    create: (orgId: string, sellerId: string, swapId: string, stationId?: string) =>
      request<import('./api.types').PublicReceiptResponse>(
        `/orgs/${orgId}/ski-swap/sellers/${sellerId}/receipts`,
        { method: 'POST', body: JSON.stringify({ swapId, ...(stationId ? { stationId } : {}) }) },
      ),
    list: (orgId: string, sellerId: string, swapId: string) =>
      request<import('./api.types').SellerReceiptRow[]>(
        `/orgs/${orgId}/ski-swap/sellers/${sellerId}/receipts?swapId=${encodeURIComponent(swapId)}`,
      ),
    revoke: (orgId: string, receiptId: string) =>
      request<{ revoked: true }>(`/orgs/${orgId}/ski-swap/receipts/${receiptId}/revoke`, {
        method: 'POST',
      }),
    /** The seller asking for their own copy. Throttled server-side. */
    sendMine: (orgId: string, swapId: string) =>
      request<import('./api.types').SendReceiptResponse>(
        `/orgs/${orgId}/ski-swap/seller/me/receipts/send`,
        { method: 'POST', body: JSON.stringify({ swapId }) },
      ),
  },

  checkin: {
    context: (swapId: string, stationId: string) =>
      request<import('./api.types').CheckinContext>(
        `/public/checkin/${swapId}?station=${encodeURIComponent(stationId)}`,
      ),
    register: (
      swapId: string,
      stationId: string,
      body: { email?: string; phone?: string },
    ) =>
      request<{
        queued: true;
        challengeId: string;
        channel: 'email' | 'phone';
        devCode?: string;
      }>(`/public/checkin/${swapId}/register?station=${encodeURIComponent(stationId)}`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    join: (orgId: string, swapId: string, stationId: string) =>
      request<import('./api.types').CheckinJoined>(
        `/orgs/${orgId}/ski-swap/checkin/join`,
        { method: 'POST', body: JSON.stringify({ swapId, stationId }) },
      ),
    summary: (orgId: string, swapId: string) =>
      request<import('./api.types').CheckinSummary>(
        `/orgs/${orgId}/ski-swap/checkin/summary?swapId=${encodeURIComponent(swapId)}`,
      ),
    finish: (orgId: string, swapId: string, stationId: string) =>
      request<{
        itemCount: number;
        receiptPages: number;
        squareFailures: number;
        /** How many of them are waiting for a staff member to accept them. */
        awaitingConsignment: number;
        /** Where the receipt was emailed, or null if it was not sent. */
        emailedTo: string | null;
        /** `none` when the swap gives no receipts (Plan 36). */
        receipt: 'given' | 'none';
        /** Whether a receipt is printing at this station. */
        receiptPrinted: boolean;
        /** Why it isn't, when the swap's settings said no: printing off, or other paper. */
        receiptPrintRefusal: 'RECEIPT_PRINT_OFF' | 'RECEIPT_PAPER' | null;
        /** Where the seller follows their items, per the swap's receipt link; null for none. */
        receiptLink: import('./api.types').ReceiptLayout['link'];
      }>(
        `/orgs/${orgId}/ski-swap/checkin/finish`,
        { method: 'POST', body: JSON.stringify({ swapId, stationId }) },
      ),
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
    /** Emails a member where and how to sign in. Doesn't expire. */
    sendInvite: (orgId: string, userId: string) =>
      request<{ sentTo: string; status: string; inviteSentAt: string | null }>(`/orgs/${orgId}/members/${userId}/invite`, { method: 'POST' }),
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
    // No permissions: a device is authorised by its role alone since the
    // identity consolidation, and the schema is strict — sending the retired
    // field failed every provision request.
    provision: (
      orgId: string,
      data: {
        name?: string;
        role: import('./api.types').DeviceRole;
        /** Time-clock terminals only: where the tablet stands. */
        resortId?: string;
      },
    ) =>
      request<import('./api.types').ProvisionedDevice>(`/orgs/${orgId}/devices`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    /** Places a time-clock terminal, or takes it out of service with null. */
    bindResort: (orgId: string, id: string, resortId: string | null) =>
      request<import('./api.types').DeviceItem>(`/orgs/${orgId}/devices/${id}/resort`, {
        method: 'PATCH',
        body: JSON.stringify({ resortId }),
      }),
    rotateSecret: (orgId: string, id: string) =>
      request<{ clientSecret: string; rotatedAt: string }>(`/orgs/${orgId}/devices/${id}/rotate-secret`, { method: 'POST' }),
    revoke: (orgId: string, id: string) =>
      request<void>(`/orgs/${orgId}/devices/${id}`, { method: 'DELETE' }),
  },

  admin: {
    listOrgs: () => request<import('./api.types').PlatformOrg[]>('/admin/organizations'),
    createOrg: (data: { name: string; slug: string; ownerEmail: string }) =>
      request<import('./api.types').PlatformOrg & { owner: { email: string; created: boolean; invite: 'sent' | 'not_sent' } }>('/admin/organizations', {
        method: 'POST',
        body: JSON.stringify(data),
      }),

    listUsers: (params: {
      q?: string;
      orgId?: string;
      membership?: 'any' | 'none';
      page?: number;
      limit?: number;
    }) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== '') qs.set(k, String(v));
      }
      return request<import('./api.types').PlatformUserPage>(`/admin/users?${qs}`);
    },
    addMembership: (userId: string, orgId: string) =>
      request<void>(`/admin/users/${userId}/memberships`, {
        method: 'POST',
        body: JSON.stringify({ orgId }),
      }),
    removeMembership: (userId: string, membershipId: string) =>
      request<void>(`/admin/users/${userId}/memberships/${membershipId}`, { method: 'DELETE' }),
    deleteUser: (userId: string) =>
      request<void>(`/admin/users/${userId}`, { method: 'DELETE' }),

    /** Platform Admin → Configuration (Plan 29). */
    settings: () => request<import('./api.types').PlatformSettings>('/admin/settings'),
    updateSettings: (data: { smsEnabled: boolean }) =>
      request<import('./api.types').PlatformSettings>('/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    /** How close traffic has come to each limit (Plan 26 §11). */
    healthLimits: (range: import('./api.types').HealthRange) =>
      request<import('./api.types').LimitsHealth>(`/admin/health/limits?range=${range}`),
    healthLimitSeries: (limitId: string, range: import('./api.types').HealthRange) =>
      request<import('./api.types').LimitSeries>(
        `/admin/health/limits/${encodeURIComponent(limitId)}/series?range=${range}`,
      ),

    /** Print bridge telemetry (webprinter_esp32 Plan 4). */
    telemetryBridges: () =>
      request<import('./api.types').TelemetryBridge[]>('/admin/telemetry/bridges'),
    telemetryFleet: (range: import('./api.types').TelemetryRange) =>
      request<import('./api.types').TelemetryFleet>(`/admin/telemetry/bridges/summary?range=${range}`),
    telemetryBridge: (deviceId: string, range: import('./api.types').TelemetryRange) =>
      request<import('./api.types').TelemetryBridgeHistory>(
        `/admin/telemetry/bridges/${encodeURIComponent(deviceId)}?range=${range}`,
      ),
    setTelemetryInterval: (deviceId: string, intervalS: number | null) =>
      request<{ intervalS: number }>(`/admin/telemetry/bridges/${encodeURIComponent(deviceId)}/interval`, {
        method: 'PATCH', body: JSON.stringify({ intervalS }),
      }),
  },

  /**
   * The shared item-description tree, and the promotion inbox (Plan 19 §6.4).
   *
   * Super-admin only: what every org sees is not one org's to change. An org
   * curates its own overlay through `skiSwap.taxonomy*` and asks for a global
   * change rather than making one.
   */
  taxonomyAdmin: {
    tree: () => request<import('./api.types').TaxonomyAdminNode[]>('/admin/taxonomy'),
    suggestions: () =>
      request<import('./api.types').TaxonomySuggestion[]>('/admin/taxonomy/suggestions'),
    create: (data: {
      kind: 'CATEGORY' | 'ATTRIBUTE' | 'VALUE'; parentId?: string; label: string;
      iconKey?: string | null; displayOrder?: number;
      input?: 'SELECT' | 'NUMBER'; nameSlot?: number | null; unit?: string | null;
      minValue?: number | null; maxValue?: number | null; step?: number | null;
      allowFreeEntry?: boolean;
    }) =>
      request<import('./api.types').TaxonomyAdminNode>('/admin/taxonomy/nodes', {
        method: 'POST', body: JSON.stringify(data),
      }),
    patch: (
      nodeId: string,
      data: {
        label?: string; iconKey?: string | null; displayOrder?: number;
        nameSlot?: number | null; unit?: string | null; minValue?: number | null;
        maxValue?: number | null; step?: number | null; allowFreeEntry?: boolean;
        retired?: boolean;
        /** A value's details are another value's; null clears it (Plan 44 D14). */
        sameDetailsAsId?: string | null;
      },
    ) =>
      request<import('./api.types').TaxonomyAdminNode>(`/admin/taxonomy/nodes/${nodeId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    /** One group's order, in one request rather than one per row. */
    reorder: (order: string[]) =>
      request<{ moved: number }>('/admin/taxonomy/reorder', {
        method: 'POST', body: JSON.stringify({ order }),
      }),
    promote: (nodeId: string) =>
      request<{ promoted: number; mergedInto: string | null }>(
        `/admin/taxonomy/nodes/${nodeId}/promote`, { method: 'POST' },
      ),
    uploadIcon: async (nodeId: string, file: File) => {
      const form = new FormData();
      form.append('file', file);
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      const res = await fetch(`/api/v1/admin/taxonomy/nodes/${nodeId}/icon`, {
        method: 'POST', credentials: 'include', headers, body: form,
      });
      if (!res.ok) throw new Error((await res.text()) || 'Could not upload that icon');
      return (await res.json()) as { iconUrl: string };
    },
    deleteIcon: (nodeId: string) =>
      request<void>(`/admin/taxonomy/nodes/${nodeId}/icon`, { method: 'DELETE' }),
  },

  /** The indemnified-bindings registry's maintenance (Plan 44). Super-admin only. */
  indemnificationAdmin: {
    programs: () => request<import('./api.types').IndemnificationProgram[]>('/admin/bindings/indemnification/programs'),
    patchProgram: (key: string, data: { name?: string; notes?: string }) =>
      request<import('./api.types').IndemnificationProgram>(`/admin/bindings/indemnification/programs/${key}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    imports: () => request<import('./api.types').IndemnificationImportRecord[]>('/admin/bindings/indemnification/imports'),
    orgs: () => request<import('./api.types').NssraDeclaration[]>('/admin/bindings/indemnification/orgs'),
    /** Multipart, like the icon upload: the JSON content-type would break it. */
    import: async (file: File, season: string, dryRun: boolean) => {
      const form = new FormData();
      form.append('file', file);
      form.append('season', season);
      form.append('dryRun', dryRun ? 'true' : 'false');
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      const res = await fetch('/api/v1/admin/bindings/indemnification/import', {
        method: 'POST', credentials: 'include', headers, body: form,
      });
      const body = (await res.json().catch(() => null)) as
        | { success: true; data: import('./api.types').IndemnificationImportPlan }
        | { success: false; error: string; code?: string; details?: unknown }
        | null;
      if (!res.ok || !body || !body.success) {
        const err = body && !body.success ? body : null;
        throw new ApiError(res.status, err?.error ?? 'Could not import that file', err?.code, err?.details);
      }
      return body.data;
    },
  },

  /**
   * What every PatrolKit device installs, and where it comes from.
   *
   * Super-admin only and not scoped to an org — this is the platform's fleet,
   * not a customer's.
   */
  deviceImages: {
    /** The one promoted image, or null when nothing has been promoted. */
    current: () => request<import('./api.types').DeviceImageItem | null>('/device-images/current'),
    /** Presigned and short-lived, so it is fetched at click time, never cached. */
    downloadUrl: (name: string, version: string) =>
      request<import('./api.types').DeviceImageDownload>(
        `/device-images/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`,
      ),
  },

  deviceImagesAdmin: {
    list: () => request<import('./api.types').AdminDeviceImageItem[]>('/admin/device-images'),
    promote: (name: string, version: string) =>
      request<import('./api.types').AdminDeviceImageItem[]>('/admin/device-images/promote', {
        method: 'POST',
        body: JSON.stringify({ name, version }),
      }),
    downloadUrl: (name: string, version: string) =>
      request<import('./api.types').DeviceImageDownload>(
        `/admin/device-images/${encodeURIComponent(name)}/${encodeURIComponent(version)}/download`,
      ),
  },

  bootstrap: {
    listRepositories: () =>
      request<import('./api.types').BootstrapRepositoryItem[]>('/admin/bootstrap/repositories'),
    createRepository: (data: import('./api.types').BootstrapRepositoryInput) =>
      request<import('./api.types').BootstrapRepositoryItem>('/admin/bootstrap/repositories', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateRepository: (id: string, data: import('./api.types').BootstrapRepositoryInput) =>
      request<import('./api.types').BootstrapRepositoryItem>(`/admin/bootstrap/repositories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    deleteRepository: (id: string) =>
      request<void>(`/admin/bootstrap/repositories/${id}`, { method: 'DELETE' }),

    listProfiles: () =>
      request<import('./api.types').BootstrapProfileItem[]>('/admin/bootstrap/profiles'),
    upsertProfile: (role: string, data: import('./api.types').BootstrapProfileInput) =>
      request<import('./api.types').BootstrapProfileItem>(`/admin/bootstrap/profiles/${role}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    preview: (role: string) =>
      request<import('./api.types').ManifestPreview>(`/admin/bootstrap/profiles/${role}/preview`),
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
    createSwap: (orgId: string, data: SwapSettingsWrite & { title: string; locationId: string }) =>
      request<import('./api.types').SwapResponse>(`/orgs/${orgId}/ski-swap/swaps`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchSwap: (
      orgId: string,
      swapId: string,
      data: SwapSettingsWrite & {
        title?: string; active?: boolean; locationId?: string;
        allowLegacyCheckin?: boolean; allowPrintCheckin?: boolean; allowLegacyWeb?: boolean; allowPrintWeb?: boolean;
        printLegacyHelperLabels?: boolean; labelsPerItem?: number;
      },
    ) =>
      request<import('./api.types').SwapResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteSwap: (orgId: string, swapId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/swaps/${swapId}`, { method: 'DELETE' }),

    // Stats
    getStats: (orgId: string, swapId: string) =>
      request<import('./api.types').SwapStats>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/stats`),
    /** Item check-ins by day and hour, with who checked them in, for the heat map. */
    getCheckinsHeatmap: (orgId: string, swapId: string) =>
      request<import('./api.types').CheckinsHeatmap>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/stats/checkins`),
    /** Items per category, busiest first, without "Other", and how many have no category. */
    getCategoryCounts: (orgId: string, swapId: string) =>
      request<{ categories: { categoryId: string; label: string; count: number }[]; uncategorised: number }>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/stats/categories`,
      ),
    /** The dashboard pie. Reads Square's sales, which the server reuses for two minutes. */
    /** Sales by hour (Plan 46): from the same Square read as the breakdown. */
    getSalesHeatmap: (orgId: string, swapId: string) =>
      request<import('./api.types').SalesHeatmap>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/stats/sales-heatmap`),
    /** Units sold per category (Plan 46). */
    getSoldByCategory: (orgId: string, swapId: string) =>
      request<import('./api.types').SoldByCategory>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/stats/sold-by-category`),
    /** Each seller's items, listed and sold dollars, for the seller histogram. */
    getSellerTotals: (orgId: string, swapId: string) =>
      request<import('./api.types').SellerTotals>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/stats/seller-totals`),
    /** Each Square checkout's items and dollars, for the buyer histogram. */
    getCheckoutTotals: (orgId: string, swapId: string) =>
      request<import('./api.types').CheckoutTotals>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/stats/checkout-totals`),
    getItemBreakdown: (orgId: string, swapId: string) =>
      request<import('./api.types').ItemBreakdown>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/stats/breakdown`),

    // Items
    listItems: (
      orgId: string,
      swapId: string,
      opts?: {
        query?: string; sellerId?: string; skip?: number; take?: number;
        /** `false` for what is still waiting to be accepted, `true` for what is on the floor. */
        consigned?: boolean;
      } & import('./api.types').ItemListView,
    ) => {
      const params = new URLSearchParams();
      if (opts?.query) params.set('query', opts.query);
      if (opts?.sellerId) params.set('sellerId', opts.sellerId);
      if (opts?.skip !== undefined) params.set('skip', String(opts.skip));
      if (opts?.take !== undefined) params.set('take', String(opts.take));
      if (opts?.consigned !== undefined) params.set('consigned', String(opts.consigned));
      setListView(params, opts);
      const qs = params.toString();
      return request<{ items: import('./api.types').ItemResponse[]; total: number; sortedBy?: import('./api.types').ItemListSort }>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/items${qs ? `?${qs}` : ''}`
      );
    },
    /**
     * Accepts every item one seller is still waiting on.
     *
     * Scoped by seller on the server rather than by item ids from the screen:
     * the list is a page of fifty, and a shop's inventory is not.
     */
    consignAllForSeller: (orgId: string, swapId: string, sellerId: string) =>
      request<{ consigned: number }>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/items/consign`,
        { method: 'POST', body: JSON.stringify({ sellerId }) },
      ),

    /** A seller's items in the swap at listed prices, for the Receipt popup (Plan 39 D7). */
    sellerItemsSummary: (orgId: string, swapId: string, sellerId: string) =>
      request<import('./api.types').SellerItemsSummary>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/items/summary?sellerId=${encodeURIComponent(sellerId)}`,
      ),

    /** Who staff may upload a file for: everyone holding tickets in this swap. */
    listTicketSellers: (orgId: string, swapId: string) =>
      request<import('./api.types').TicketSeller[]>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/items/ticket-sellers`,
      ),
    /**
     * A shop's inventory, uploaded by staff on their behalf.
     *
     * Returns the per-row verdict rather than throwing, the same as the shop's
     * own upload — a rejected file is a list of things to fix, not an error.
     */
    importItemsForSeller: async (orgId: string, swapId: string, sellerId: string, file: File, opts: { generateSkus?: boolean; acceptUnknown?: boolean } = {}) => {
      const form = new FormData();
      form.append('file', file);
      form.append('sellerId', sellerId);
      if (opts.generateSkus) form.append('generateSkus', 'true');
      if (opts.acceptUnknown) form.append('acceptUnknown', 'true');
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      const res = await fetch(`/api/v1/orgs/${orgId}/ski-swap/swaps/${swapId}/items/import`, {
        method: 'POST', credentials: 'include', headers, body: form,
      });
      return (await res.json()) as {
        success: boolean;
        data?: import('./api.types').TicketImportResult;
        error?: string;
      };
    },
    /**
     * A download beside staff's upload (Plan 42): the template, the example,
     * or the categories and details. Fetched rather than linked: the session
     * token travels in a header, which a plain link can't carry.
     */
    itemImportFile: (orgId: string, swapId: string, file: import('./api.types').ImportGuideFile) =>
      fetchCsv(`/api/v1/orgs/${orgId}/ski-swap/swaps/${swapId}/items/import/${file}`),
    /** One item by the number on its tag, exactly — what a scanner needs. */
    /** Returns the item with this SKU to its seller (Plan 43); `sellerId` locks it to one. */
    returnItemBySku: (orgId: string, swapId: string, sku: string, sellerId?: string) =>
      request<import('./api.types').ReturnResult>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/return-by-sku`, {
        method: 'POST', body: JSON.stringify({ sku, ...(sellerId ? { sellerId } : {}) }),
      }),
    /** Undoes a return: back on sale (Plan 43 D4). */
    undoItemReturn: (orgId: string, swapId: string, itemId: string) =>
      request<import('./api.types').ItemResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}/return`, { method: 'DELETE' }),
    /** A seller's items still out, for a locked return session (Plan 43 D5). */
    unreturnedItems: (orgId: string, swapId: string, sellerId: string) =>
      request<import('./api.types').UnreturnedItems>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/unreturned?sellerId=${encodeURIComponent(sellerId)}`),
    /** Batch set category (Plan 45): up to 25 scanned tags get one category, if they have none. */
    categorizeItems: (orgId: string, swapId: string, body: { categoryId: string; attributes: import('./api.types').CategorizeAnswer[]; rename: boolean; skus: string[] }) =>
      request<import('./api.types').CategorizeItemsResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/categorize`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    /** Undoes one row of a batch set category (Plan 45 D9). */
    uncategorizeItem: (orgId: string, swapId: string, itemId: string, body: { categoryId: string; attributes: import('./api.types').CategorizeAnswer[]; rename?: { from: string; to: string } }) =>
      request<import('./api.types').UncategorizeItemResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}/uncategorize`, {
        method: 'POST', body: JSON.stringify(body),
      }),
    findItemBySku: (orgId: string, swapId: string, sku: string) =>
      request<import('./api.types').ItemResponse>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/items/by-sku/${encodeURIComponent(sku)}`,
      ),
    /** Accepts an item onto the floor, which is also what puts it in Square. */
    consignItem: (orgId: string, swapId: string, itemId: string) =>
      request<import('./api.types').ItemResponse>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}/consign`,
        { method: 'POST' },
      ),
    createItem: (orgId: string, swapId: string, data: { categoryId?: string; attributes?: import('./api.types').ItemAttributeInput[]; description?: string; priceCents: number | null; quantity: number; sellerId?: string; donateProceeds?: boolean; sku?: string }) =>
      request<import('./api.types').ItemResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchItem: (
      orgId: string, swapId: string, itemId: string,
      data: {
        categoryId?: string; attributes?: import('./api.types').ItemAttributeInput[];
        /** Replaces the derived name outright. */
        name?: string;
        description?: string | null; priceCents?: number; quantity?: number; sellerId?: string | null;
        donateProceeds?: boolean; hasPrintedTag?: boolean;
        /** Refused with `TICKET_PRICED` if the item has a price by now (Plan 37). */
        ifUnpriced?: true;
      },
      idempotencyKey?: string,
    ) =>
      request<import('./api.types').ItemResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(data),
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      }),
    /** The swap's tickets with no price yet, in number order (Plan 37). */
    unpricedTickets: (orgId: string, swapId: string) =>
      request<import('./api.types').UnpricedTicket[]>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/unpriced-tickets`),
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
    listSellers: (orgId: string, query?: string, incompleteOnly?: boolean) => {
      const qs = new URLSearchParams();
      if (query) qs.set('query', query);
      // Server-side, so the rule for "can this person be reached and paid" is
      // stated once and the list cannot disagree with the dashboard count.
      if (incompleteOnly) qs.set('incomplete', 'true');
      const suffix = qs.toString() ? `?${qs}` : '';
      /*
       * Unwrapped here rather than at every screen.
       *
       * The response carries `syncedAt` beside the list now, for clients that
       * hold a mirror and need a cursor the server's clock chose. The web holds
       * no mirror — it refetches — so the three screens that read this go on
       * seeing an array.
       */
      return request<{ sellers: import('./api.types').SellerResponse[]; syncedAt: string }>(
        `/orgs/${orgId}/ski-swap/sellers${suffix}`,
      ).then((r) => r.sellers);
    },
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

    // Issued tickets (Plan 38): a block becomes its tickets, on sale at once.
    ticketSummary: (orgId: string, sellerId: string, swapId: string) =>
      request<import('./api.types').IssuedTicketSummary>(
        `/orgs/${orgId}/ski-swap/sellers/${sellerId}/tickets?swapId=${swapId}`,
      ),
    issueTickets: (orgId: string, sellerId: string, data: { swapId: string; startNumber: number; endNumber: number }) =>
      request<{ created: number; startNumber: number; endNumber: number }>(
        `/orgs/${orgId}/ski-swap/sellers/${sellerId}/tickets/issue`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    removeTickets: (orgId: string, sellerId: string, data: { swapId: string; startNumber: number; endNumber: number }) =>
      request<import('./api.types').RemoveTicketsResult>(
        `/orgs/${orgId}/ski-swap/sellers/${sellerId}/tickets/remove`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    /** How many of the swap's accepted tickets aren't in Square, and whether that's being worked on. */
    /** Whether one scanned ticket is free in the swap (Plan 40): our rows only. */
    ticketCheck: (orgId: string, swapId: string, sku: string) =>
      request<{ free: true } | { free: false; holder: string | null }>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/items/ticket-check?sku=${encodeURIComponent(sku)}`,
      ),
    /** Batch add (Plan 40): the scanned tickets become the seller's items. Safe to retry with the same key. */
    batchAddTickets: (orgId: string, swapId: string, sellerId: string, tickets: string[], idempotencyKey: string) =>
      request<{ created: number }>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/batch-tickets`, {
        method: 'POST',
        body: JSON.stringify({ sellerId, tickets }),
        headers: { 'idempotency-key': idempotencyKey },
      }),
    ticketPushStatus: (orgId: string, swapId: string) =>
      request<{ notInSquare: number; pushing: boolean; squareReady: boolean }>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/items/ticket-push`,
      ),
    /** Puts the swap's accepted tickets that aren't in Square there, in the background. */
    pushTickets: (orgId: string, swapId: string) =>
      request<{ started: boolean }>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/items/ticket-push`, { method: 'POST' }),

    // Swap diagnostics (Plan 41)
    /** Starts the checks, or answers the run already going. */
    // ─── Sales check (Plan 48): reading changes nothing; every POST is a person's choice ───
    salesCheck: (orgId: string, swapId: string) =>
      request<import('./api.types').SalesCheckResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/sales-check`),
    salesCheckCount: (orgId: string, swapId: string) =>
      request<import('./api.types').SalesCheckCount>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/sales-check/count`),
    /** A fee refunded some way Square doesn't show: marked handled (Plan 48 fee check). */
    /** Notes on Reports issues (Plan 48), by issue key. */
    issueNotes: (orgId: string, swapId: string, page: import('./api.types').IssueNotePage) =>
      request<import('./api.types').IssueNotesResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/issue-notes/${page}`),
    /** Saves a note, or clears it for an empty text: answers the note, or null. */
    saveIssueNote: (orgId: string, swapId: string, page: import('./api.types').IssueNotePage, body: { issueKey: string; text: string }) =>
      request<import('./api.types').IssueNote | null>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/issue-notes/${page}`, { method: 'PUT', body: JSON.stringify(body) }),
    feeHandled: (orgId: string, swapId: string, body: { orderId: string }) =>
      request<import('./api.types').SalesCheckOutcome>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/sales-check/fee-handled`, {
        method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    creditSale: (orgId: string, swapId: string, body: { orderId: string; lineUid: string; itemId: string; markSold: boolean; priceCents?: number; replacePrice?: boolean }) =>
      request<import('./api.types').SalesCheckOutcome>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/sales-check/credit`, {
        method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    creditSuggestedSales: (orgId: string, swapId: string, body: { lines: { orderId: string; lineUid: string; itemId: string }[]; markSold: boolean }) =>
      request<{ outcomes: import('./api.types').SalesCheckOutcome[] }>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/sales-check/credit-suggested`, {
        method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    notSwapSale: (orgId: string, swapId: string, body: { orderId: string; lineUid: string; note?: string }) =>
      request<import('./api.types').SalesCheckOutcome>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/sales-check/not-swap`, {
        method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    undoSaleDecision: (orgId: string, swapId: string, decisionId: string) =>
      request<{ markedSold: boolean; itemId: string | null }>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/sales-check/undo/${decisionId}`, { method: 'POST' }),
    restockItem: (orgId: string, swapId: string, itemId: string) =>
      request<{ stock: number }>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/sales-check/restock/${itemId}`, { method: 'POST' }),
    ignoreSquareCategory: (orgId: string, swapId: string, body: { categoryId: string; ignore: boolean }) =>
      request<{ ignored: string[] }>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/sales-check/ignore-category`, { method: 'POST', body: JSON.stringify(body) }),
    issueAndCreditSale: (orgId: string, swapId: string, body: { orderId: string; lineUid: string; sellerId: string; ticket: string }) =>
      request<import('./api.types').SalesCheckOutcome>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/sales-check/issue-and-credit`, {
        method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    // ─── Exchanges (Plan 49): the list is report; everything else is admin ───
    exchanges: (orgId: string, swapId: string) =>
      request<import('./api.types').ExchangesResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/exchanges`),
    exchangeLookup: (orgId: string, swapId: string, q: { receipt?: string; ticket?: string }) => {
      const params = new URLSearchParams();
      if (q.receipt) params.set('receipt', q.receipt);
      if (q.ticket) params.set('ticket', q.ticket);
      return request<import('./api.types').ExchangeLookupResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/exchanges/lookup?${params.toString()}`);
    },
    recordExchange: (orgId: string, swapId: string, body: { orderId: string; lineUid: string; returnedItemId: string; replacementItemId: string; priceCents?: number; note?: string }) =>
      request<import('./api.types').RecordExchangeResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/exchanges`, {
        method: 'POST', body: JSON.stringify(body), headers: { 'idempotency-key': crypto.randomUUID() },
      }),
    editExchangeNote: (orgId: string, swapId: string, id: string, note: string) =>
      request<import('./api.types').SwapExchangeResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/exchanges/${id}`, { method: 'PATCH', body: JSON.stringify({ note }) }),
    cancelExchange: (orgId: string, swapId: string, id: string, reason: string) =>
      request<import('./api.types').SwapExchangeResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/exchanges/${id}/cancel`, { method: 'POST', body: JSON.stringify({ reason }) }),
    retryExchangeStock: (orgId: string, swapId: string, id: string) =>
      request<import('./api.types').SwapExchangeResponse>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/exchanges/${id}/retry-stock`, { method: 'POST' }),
    startDiagnostics: (orgId: string, swapId: string) =>
      request<{ runId: string }>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/diagnostics`, { method: 'POST' }),
    /** The latest run with its issues; null before the first. */
    latestDiagnostics: (orgId: string, swapId: string) =>
      request<import('./api.types').DiagnosticRunResponse | null>(`/orgs/${orgId}/ski-swap/swaps/${swapId}/diagnostics/latest`),
    applyDiagnosticChoice: (
      orgId: string, swapId: string, issueId: string,
      body: { choice: import('./api.types').DiagnosticChoice; sellerId?: string; restoreItemId?: string; keepSquareItemId?: string; prefix?: string; priceCents?: number },
    ) =>
      request<import('./api.types').DiagnosticIssueResponse>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/diagnostics/issues/${issueId}`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    applyDiagnosticChoiceToAll: (
      orgId: string, swapId: string, runId: string,
      body: { kind: import('./api.types').DiagnosticIssueKind; field?: import('./api.types').DiagnosticField; choice: import('./api.types').DiagnosticChoice; sellerId?: string; prefix?: string },
    ) =>
      request<import('./api.types').DiagnosticApplyAllResponse>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/diagnostics/runs/${runId}/apply-all`,
        { method: 'POST', body: JSON.stringify(body) },
      ),
    /** A whole inventory at once. Nothing is written unless every row passes. */
    importTicketItems: (orgId: string, swapId: string, file: File, opts: { generateSkus?: boolean; acceptUnknown?: boolean } = {}) => {
      const form = new FormData();
      form.append('file', file);
      form.append('swapId', swapId);
      if (opts.generateSkus) form.append('generateSkus', 'true');
      if (opts.acceptUnknown) form.append('acceptUnknown', 'true');
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      return fetch(`/api/v1/orgs/${orgId}/ski-swap/seller/me/items/import`, {
        method: 'POST', credentials: 'include', headers, body: form,
      }).then((r) => r.json() as Promise<{
        success: boolean;
        error?: string;
        data?: import('./api.types').TicketImportResult;
      }>);
    },
    /** A download beside the shop's own upload (Plan 42). */
    ticketImportFile: (orgId: string, file: import('./api.types').ImportGuideFile) =>
      fetchCsv(`/api/v1/orgs/${orgId}/ski-swap/seller/me/items/import/${file}`),
    /** What the seller's own item form opens with. */
    ticketState: (orgId: string, swapId: string) =>
      request<import('./api.types').TicketFormState>(
        `/orgs/${orgId}/ski-swap/seller/me/ticket-state?swapId=${swapId}`,
      ),
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
    /** The seller import's header row, fetched with the session token: a plain link can't carry it. */
    sellerTemplate: (orgId: string) => fetchCsv(`/api/v1/orgs/${orgId}/ski-swap/sellers/import/template`),
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
    inviteBusinessSeller: (
      orgId: string,
      // The email is optional and sending is explicit: a shop whose inventory
      // staff upload may never sign in.
      data: { businessName: string; email?: string; sendInvite?: boolean },
    ) =>
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

    // ─── Item description tree (Plan 19) ─────────────────────────────────────

    /** The resolved tree the item form is generated from. */
    taxonomy: (orgId: string) =>
      request<import('./api.types').ResolvedTaxonomy>(`/orgs/${orgId}/ski-swap/taxonomy`),
    /** The whole tree, every deferred branch expanded, for matching typed text (Plan 37). */
    taxonomyFull: (orgId: string) =>
      request<import('./api.types').ResolvedTaxonomy>(`/orgs/${orgId}/ski-swap/taxonomy?depth=full`),
    /** A deferred branch — a manufacturer's model list — fetched when opened. */
    taxonomyChildren: (orgId: string, nodeId: string) =>
      request<import('./api.types').TaxonomyChildrenResponse>(
        `/orgs/${orgId}/ski-swap/taxonomy/nodes/${nodeId}/children`,
      ),
    /** The approval queue and this org's own values. */
    taxonomyAdmin: (orgId: string) =>
      request<import('./api.types').OrgTaxonomyAdmin>(`/orgs/${orgId}/ski-swap/taxonomy/admin`),
    patchTaxonomyNode: (
      orgId: string,
      nodeId: string,
      data: {
        label?: string; iconKey?: string | null; displayOrder?: number;
        nameSlot?: number | null; unit?: string | null; minValue?: number | null;
        maxValue?: number | null; step?: number | null; allowFreeEntry?: boolean;
        approve?: true; retired?: boolean;
      },
    ) =>
      request<import('./api.types').TaxonomyAdminNode>(
        `/orgs/${orgId}/ski-swap/taxonomy/nodes/${nodeId}`,
        { method: 'PATCH', body: JSON.stringify(data) },
      ),
    createTaxonomyNode: (
      orgId: string,
      data: {
        kind: 'CATEGORY' | 'ATTRIBUTE' | 'VALUE'; parentId?: string; label: string;
        iconKey?: string | null; displayOrder?: number;
        input?: 'SELECT' | 'NUMBER'; nameSlot?: number | null; unit?: string | null;
        minValue?: number | null; maxValue?: number | null; step?: number | null;
        allowFreeEntry?: boolean;
      },
    ) =>
      request<import('./api.types').TaxonomyAdminNode>(`/orgs/${orgId}/ski-swap/taxonomy/nodes`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    /** "Use that instead" — folds one value into another. */
    mergeTaxonomyNode: (orgId: string, nodeId: string, targetId: string) =>
      request<{ itemsRepointed: number }>(
        `/orgs/${orgId}/ski-swap/taxonomy/nodes/${nodeId}/merge`,
        { method: 'POST', body: JSON.stringify({ targetId }) },
      ),
    /** "Suggest for everyone" — the org asks; a platform admin decides. */
    suggestTaxonomyNode: (orgId: string, nodeId: string) =>
      request<import('./api.types').TaxonomyAdminNode>(
        `/orgs/${orgId}/ski-swap/taxonomy/nodes/${nodeId}/suggest`,
        { method: 'POST' },
      ),
    discardTaxonomyNode: (orgId: string, nodeId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/taxonomy/nodes/${nodeId}`, { method: 'DELETE' }),
    /**
     * Uploads a node's icon. Multipart, so it bypasses `request` for the same
     * reason the logo and CSV uploads do: the JSON content-type would break it.
     */
    uploadTaxonomyIcon: async (orgId: string, nodeId: string, file: File) => {
      const form = new FormData();
      form.append('file', file);
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      const res = await fetch(
        `/api/v1/orgs/${orgId}/ski-swap/taxonomy/nodes/${nodeId}/icon`,
        { method: 'POST', credentials: 'include', headers, body: form },
      );
      if (!res.ok) throw new Error((await res.text()) || 'Could not upload that icon');
      return (await res.json()) as { iconUrl: string };
    },
    deleteTaxonomyIcon: (orgId: string, nodeId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/taxonomy/nodes/${nodeId}/icon`, { method: 'DELETE' }),

    // Seller self-service
    sellerGetProfile: (orgId: string) =>
      request<import('./api.types').SellerResponse>(`/orgs/${orgId}/ski-swap/seller/me`),
    sellerUpdateProfile: (orgId: string, data: SellerWrite) =>
      request<import('./api.types').SellerResponse>(`/orgs/${orgId}/ski-swap/seller/me`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    sellerListSwaps: (orgId: string) =>
      request<{ id: string; title: string; labelsPerItem: number }[]>(`/orgs/${orgId}/ski-swap/seller/me/swaps`),
    sellerListItems: (orgId: string, swapId?: string, opts?: { skip?: number; take?: number } & import('./api.types').ItemListView) => {
      const params = new URLSearchParams();
      if (swapId) params.set('swapId', swapId);
      if (opts?.skip !== undefined) params.set('skip', String(opts.skip));
      if (opts?.take !== undefined) params.set('take', String(opts.take));
      setListView(params, opts);
      const qs = params.toString();
      return request<{ items: import('./api.types').ItemResponse[]; total: number; sortedBy?: import('./api.types').ItemListSort }>(
        `/orgs/${orgId}/ski-swap/seller/me/items${qs ? `?${qs}` : ''}`
      );
    },
    /**
     * `stationId` marks the item as entered at a check-in station: it decides
     * where the tag prints and which counter mints the SKU. `idempotencyKey`
     * makes a retry after a dropped response safe — venue wifi being what it is,
     * without it a retry mints a second SKU and prints a second tag.
     */
    sellerCreateItem: (
      orgId: string,
      data: { swapId: string; categoryId?: string; attributes?: import('./api.types').ItemAttributeInput[]; description?: string; priceCents: number | null; quantity: number; donateProceeds?: boolean; stationId?: string; sku?: string; generateSku?: boolean },
      idempotencyKey?: string,
    ) =>
      request<import('./api.types').ItemResponse>(`/orgs/${orgId}/ski-swap/seller/me/items`, {
        method: 'POST',
        body: JSON.stringify(data),
        ...(idempotencyKey ? { headers: { 'Idempotency-Key': idempotencyKey } } : {}),
      }),
    sellerPatchItem: (orgId: string, itemId: string, data: { categoryId?: string; attributes?: import('./api.types').ItemAttributeInput[]; description?: string | null; priceCents?: number; quantity?: number; donateProceeds?: boolean; hasPrintedTag?: boolean }) =>
      request<import('./api.types').ItemResponse>(`/orgs/${orgId}/ski-swap/seller/me/items/${itemId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    sellerDeleteItem: (orgId: string, itemId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/seller/me/items/${itemId}`, { method: 'DELETE' }),
    /** Re-queues an item's tag, for one that jammed or came out unreadable. */
    sellerReprintItem: (orgId: string, itemId: string, stationId: string) =>
      request<{ queued: true }>(`/orgs/${orgId}/ski-swap/seller/me/items/${itemId}/reprint`, {
        method: 'POST', body: JSON.stringify({ stationId }),
      }),
    /** `stationId` while checking in: an individual seller's items are otherwise read-only. */
    sellerUploadPhoto: async (orgId: string, itemId: string, file: File, stationId?: string): Promise<{ id: string; url: string }> => {
      const form = new FormData();
      form.append('image', file);
      if (stationId) form.append('stationId', stationId);
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
    createPrinter: (orgId: string, data: { name: string; bluetoothName: string; model: string; paperSize: string }) =>
      request<import('./api.types').SwapPrinterRecord>(`/orgs/${orgId}/ski-swap/printers`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    /**
     * The signed-in seller editing their own record. Same endpoint the staff
     * pages use, scoped to the caller — which is what lets the check-in steps
     * write an address and a payout without an endpoint of their own.
     */
    updateSellerSelf: (
      orgId: string,
      data: {
        street?: string; city?: string; state?: string; zip?: string;
        payoutMethod?: 'CHECK' | 'PAYPAL' | 'VENMO' | null;
        payoutTarget?: 'EMAIL' | 'PHONE' | 'PAYPAL_ID' | 'VENMO_ID' | null;
        payoutHandle?: string | null;
      },
    ) =>
      request<import('./api.types').SellerResponse>(`/orgs/${orgId}/ski-swap/seller/me`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),

    stationQrPdf: async (orgId: string, stationId: string): Promise<Blob> => {
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      const res = await fetch(
        `/api/v1/orgs/${orgId}/ski-swap/stations/${stationId}/qr.pdf`,
        { credentials: 'include', headers },
      );
      if (!res.ok) {
        // The body is the API's JSON envelope on failure, not a PDF.
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Could not build the printable sheet');
      }
      return res.blob();
    },
    patchPrinter: (orgId: string, printerId: string, data: { name?: string; bluetoothName?: string; assignedSellerId?: string | null; bridgeDeviceId?: string | null; model?: string; paperSize?: string; marginTop?: number; marginBottom?: number; marginLeft?: number; marginRight?: number }) =>
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

    /**
     * Renders a label on the server against this printer's paper size and
     * margins. `escpos` pages go straight over Bluetooth; `png` pages are for
     * preview mode. The browser no longer lays labels out itself.
     */
    renderLabel: (
      orgId: string,
      printerId: string,
      body: {
        kind: 'item' | 'receipt_header' | 'receipt_items' | 'qr' | 'printer_label' | 'calibration';
        format?: 'escpos' | 'png';
        itemId?: string;
        sellerId?: string;
        swapId?: string;
      },
    ) =>
      request<import('./api.types').RenderLabelResponse>(
        `/orgs/${orgId}/ski-swap/printers/${printerId}/labels`,
        { method: 'POST', body: JSON.stringify(body) },
      ),

    // Check-in stations (staff)
    listStations: (orgId: string) =>
      request<import('./api.types').CheckinStationRecord[]>(`/orgs/${orgId}/ski-swap/stations`),
    createStation: (orgId: string, name: string) =>
      request<import('./api.types').CheckinStationRecord>(`/orgs/${orgId}/ski-swap/stations`, {
        method: 'POST', body: JSON.stringify({ name }),
      }),
    patchStation: (
      orgId: string,
      stationId: string,
      data: {
        name?: string;
        attendantDeviceId?: string | null;
        bridgeDeviceId?: string | null;
      },
    ) =>
      request<import('./api.types').CheckinStationRecord>(`/orgs/${orgId}/ski-swap/stations/${stationId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteStation: (orgId: string, stationId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/stations/${stationId}`, { method: 'DELETE' }),
    stationQueue: (orgId: string, stationId: string) =>
      request<import('./api.types').StationQueueStatus>(`/orgs/${orgId}/ski-swap/stations/${stationId}/queue`),
    testStation: (orgId: string, stationId: string) =>
      request<{ queued: true }>(`/orgs/${orgId}/ski-swap/stations/${stationId}/test`, { method: 'POST' }),
    clearStationQueue: (orgId: string, stationId: string) =>
      request<{ cleared: number }>(`/orgs/${orgId}/ski-swap/stations/${stationId}/queue`, { method: 'DELETE' }),

    // Scanners — the same shape as printers, minus everything about paper.
    listScanners: (orgId: string) =>
      request<import('./api.types').SwapScanner[]>(`/orgs/${orgId}/ski-swap/scanners`),
    createScanner: (orgId: string, data: { name: string; bluetoothName: string }) =>
      request<import('./api.types').SwapScanner>(`/orgs/${orgId}/ski-swap/scanners`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchScanner: (
      orgId: string,
      scannerId: string,
      data: { name?: string; bluetoothName?: string; bridgeDeviceId?: string | null },
    ) =>
      request<import('./api.types').SwapScanner>(`/orgs/${orgId}/ski-swap/scanners/${scannerId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteScanner: (orgId: string, scannerId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/scanners/${scannerId}`, { method: 'DELETE' }),

    // Settings
    getSettings: (orgId: string) =>
      request<import('./api.types').SkiSwapSettings>(`/orgs/${orgId}/ski-swap/settings`),
    updateSettings: (
      orgId: string,
      // A patch: sending one setting must not clear the other.
      data: {
        requireConsignmentScan?: boolean;
        /** A percentage, as typed: "20", "20.5", "20.5%". Never basis points. */
        commissionPercent?: string;
        barcodesPerTicket?: 1 | 2;
        showUsBootSizes?: boolean;
        /** The NSSRA membership declaration (Plan 44 D5). */
        nssraMember?: boolean;
      },
    ) =>
      request<import('./api.types').SkiSwapSettings>(`/orgs/${orgId}/ski-swap/settings`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),

    // ─── Binding indemnification lookup (Plan 44) ────────────────────────────

    indemnification: {
      manufacturers: (orgId: string) =>
        request<import('./api.types').ManufacturersResponse>(`/orgs/${orgId}/ski-swap/bindings/indemnification/manufacturers`),
      models: (orgId: string, manufacturerId: string) =>
        request<import('./api.types').BindingLookup[]>(`/orgs/${orgId}/ski-swap/bindings/indemnification/manufacturers/${manufacturerId}/models`),
      search: (orgId: string, q: string) =>
        request<import('./api.types').BindingLookup[]>(`/orgs/${orgId}/ski-swap/bindings/indemnification/search?q=${encodeURIComponent(q)}`),
      model: (orgId: string, nodeId: string) =>
        request<import('./api.types').BindingLookupDetail>(`/orgs/${orgId}/ski-swap/bindings/indemnification/models/${nodeId}`),
    },

    // Device PIN — its own route, because settings is readable at `:report`
    // level and this is not.
    getDevicePin: (orgId: string) =>
      request<import('./api.types').DevicePinResponse>(`/orgs/${orgId}/ski-swap/settings/device-pin`),
    setDevicePin: (orgId: string, devicePin: string | null) =>
      request<import('./api.types').DevicePinResponse>(`/orgs/${orgId}/ski-swap/settings/device-pin`, {
        method: 'PUT', body: JSON.stringify({ devicePin }),
      }),

    // ─── PayPal credentials (Plan 25 §6) ────────────────────────────

    getPayPalConfig: (orgId: string) =>
      request<import('./api.types').PayPalConfigResponse>(`/orgs/${orgId}/ski-swap/paypal-config`),
    getPayPalStatus: (orgId: string) =>
      request<{ configured: boolean; environment: string | null; webhookRegistered: boolean }>(
        `/orgs/${orgId}/ski-swap/paypal-config/status`,
      ),
    upsertPayPalConfig: (
      orgId: string,
      data: { clientId: string; clientSecret: string; environment: 'sandbox' | 'live'; webhookId?: string | null },
    ) =>
      request<import('./api.types').PayPalConfigResponse>(`/orgs/${orgId}/ski-swap/paypal-config`, {
        method: 'PUT', body: JSON.stringify(data),
      }),
    deletePayPalConfig: (orgId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/paypal-config`, { method: 'DELETE' }),
    testPayPalConnection: (orgId: string) =>
      request<{ success: boolean; message: string }>(
        `/orgs/${orgId}/ski-swap/paypal-config/test`, { method: 'POST' },
      ),

    // ─── Payout runs (Plan 25 §5–§10) ───────────────────────────

    listPayoutRuns: (orgId: string, swapId?: string) =>
      request<import('./api.types').PayoutRunSummary[]>(
        `/orgs/${orgId}/ski-swap/payout-runs${swapId ? `?swapId=${swapId}` : ''}`,
      ),
    createPayoutRun: (orgId: string, swapId: string, data: { salesFrom?: string; salesTo?: string } = {}) =>
      request<import('./api.types').PayoutRun>(
        `/orgs/${orgId}/ski-swap/swaps/${swapId}/payout-runs`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
    getPayoutRun: (orgId: string, runId: string) =>
      request<import('./api.types').PayoutRun>(`/orgs/${orgId}/ski-swap/payout-runs/${runId}`),
    getPayoutDiscounts: (orgId: string, runId: string) =>
      request<{
        runId: string;
        discounts: import('./api.types').PayoutDiscount[];
        totalGapCents: number;
        totalGapFormatted: string;
      }>(`/orgs/${orgId}/ski-swap/payout-runs/${runId}/discounts`),
    approvePayoutLines: (orgId: string, runId: string, lineIds: string[], approved = true) =>
      request<{ requested: number; changed: number }>(
        `/orgs/${orgId}/ski-swap/payout-runs/${runId}/approve`,
        { method: 'POST', body: JSON.stringify({ lineIds, approved }) },
      ),
    /**
     * `expectedLineCount` is what the screen showed. The server refuses if it
     * disagrees — somebody approved a line between looking and clicking, and
     * the whole point of the confirmation is that the operator knows what they
     * are authorising.
     */
    sendPayoutRun: (orgId: string, runId: string, expectedLineCount: number) =>
      request<import('./api.types').PayoutRun>(
        `/orgs/${orgId}/ski-swap/payout-runs/${runId}/send`,
        { method: 'POST', body: JSON.stringify({ expectedLineCount }) },
      ),
    closePayoutRun: (orgId: string, runId: string) =>
      request<import('./api.types').PayoutRun>(
        `/orgs/${orgId}/ski-swap/payout-runs/${runId}/close`, { method: 'POST' },
      ),
    reconcilePayouts: (orgId: string) =>
      request<{ batches: number; reconciled: number }>(
        `/orgs/${orgId}/ski-swap/payout-runs/reconcile`, { method: 'POST' },
      ),
    nudgePayouts: (orgId: string) =>
      request<{ considered: number; sent: number; suppressed: number; failed: number; skipped: number }>(
        `/orgs/${orgId}/ski-swap/payout-runs/nudge`, { method: 'POST' },
      ),
    cancelUnclaimedPayout: (orgId: string, runId: string, lineId: string) =>
      request<{ id: string; status: string }>(
        `/orgs/${orgId}/ski-swap/payout-runs/${runId}/lines/${lineId}/cancel`, { method: 'POST' },
      ),
    listCheckPayees: (orgId: string, runId: string) =>
      request<import('./api.types').CheckPayee[]>(
        `/orgs/${orgId}/ski-swap/payout-runs/${runId}/checks`,
      ),
    /**
     * The check register as a file.
     *
     * Fetched rather than linked, like the QR sheet: the session token travels
     * in a header, and a plain navigation cannot carry one — a download link
     * would simply be refused.
     */
    checksCsv: async (orgId: string, runId: string): Promise<Blob> => {
      const headers: Record<string, string> = {};
      if (accessToken) headers['Authorization'] = `Bearer ${accessToken}`;
      const res = await fetch(
        `/api/v1/orgs/${orgId}/ski-swap/payout-runs/${runId}/checks.csv`,
        { credentials: 'include', headers },
      );
      if (!res.ok) {
        // On failure the body is the API's JSON envelope, not a CSV.
        const body = await res.json().catch(() => null);
        throw new Error(body?.error?.message ?? 'Could not build the check register');
      }
      return res.blob();
    },
    recordCheckSent: (
      orgId: string,
      runId: string,
      lineId: string,
      data: { checkNumber?: string | null; sentAt?: string | null },
    ) =>
      request<{ id: string; checkNumber: string | null; checkSentAt: string | null; status: string }>(
        `/orgs/${orgId}/ski-swap/payout-runs/${runId}/lines/${lineId}/check`,
        { method: 'POST', body: JSON.stringify(data) },
      ),
  },

  timeClock: {
    // Check-in stations (staff)
    listStations: (orgId: string) =>
      request<import('./api.types').CheckinStationRecord[]>(`/orgs/${orgId}/ski-swap/stations`),
    createStation: (orgId: string, name: string) =>
      request<import('./api.types').CheckinStationRecord>(`/orgs/${orgId}/ski-swap/stations`, {
        method: 'POST', body: JSON.stringify({ name }),
      }),
    patchStation: (
      orgId: string,
      stationId: string,
      data: {
        name?: string;
        attendantDeviceId?: string | null;
        bridgeDeviceId?: string | null;
      },
    ) =>
      request<import('./api.types').CheckinStationRecord>(`/orgs/${orgId}/ski-swap/stations/${stationId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteStation: (orgId: string, stationId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/stations/${stationId}`, { method: 'DELETE' }),
    stationQueue: (orgId: string, stationId: string) =>
      request<import('./api.types').StationQueueStatus>(`/orgs/${orgId}/ski-swap/stations/${stationId}/queue`),
    testStation: (orgId: string, stationId: string) =>
      request<{ queued: true }>(`/orgs/${orgId}/ski-swap/stations/${stationId}/test`, { method: 'POST' }),
    clearStationQueue: (orgId: string, stationId: string) =>
      request<{ cleared: number }>(`/orgs/${orgId}/ski-swap/stations/${stationId}/queue`, { method: 'DELETE' }),

    // Scanners — the same shape as printers, minus everything about paper.
    listScanners: (orgId: string) =>
      request<import('./api.types').SwapScanner[]>(`/orgs/${orgId}/ski-swap/scanners`),
    createScanner: (orgId: string, data: { name: string; bluetoothName: string }) =>
      request<import('./api.types').SwapScanner>(`/orgs/${orgId}/ski-swap/scanners`, {
        method: 'POST', body: JSON.stringify(data),
      }),
    patchScanner: (
      orgId: string,
      scannerId: string,
      data: { name?: string; bluetoothName?: string; bridgeDeviceId?: string | null },
    ) =>
      request<import('./api.types').SwapScanner>(`/orgs/${orgId}/ski-swap/scanners/${scannerId}`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),
    deleteScanner: (orgId: string, scannerId: string) =>
      request<void>(`/orgs/${orgId}/ski-swap/scanners/${scannerId}`, { method: 'DELETE' }),

    // Settings
    getSettings: (orgId: string) =>
      request<import('./api.types').TimeClockSettingsResponse>(`/orgs/${orgId}/time-clock/settings`),
    updateSettings: (orgId: string, data: { autoCloseLocalTime?: string; autoCloseAfterHours?: number }) =>
      request<import('./api.types').TimeClockSettingsResponse>(`/orgs/${orgId}/time-clock/settings`, {
        method: 'PATCH', body: JSON.stringify(data),
      }),

    // Device PIN — its own route, because settings is readable at `:report`
    // level and this is not.
    getDevicePin: (orgId: string) =>
      request<import('./api.types').DevicePinResponse>(`/orgs/${orgId}/time-clock/settings/device-pin`),
    setDevicePin: (orgId: string, devicePin: string | null) =>
      request<import('./api.types').DevicePinResponse>(`/orgs/${orgId}/time-clock/settings/device-pin`, {
        method: 'PUT', body: JSON.stringify({ devicePin }),
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
    /** What the signed-out pages may offer — just whether texting is on (Plan 29). */
    features: () => request<{ sms: boolean }>('/public/features'),
    /** A frozen receipt, by the token from an email or a text. */
    /** The masked email a receipt's sign-in link sends to (Plan 36); 404 when it offers none. */
    receiptSignIn: (token: string) =>
      request<{ emailHint: string }>(`/public/receipts/${encodeURIComponent(token)}/sign-in`),
    getReceipt: (token: string) =>
      request<import('./api.types').PublicReceiptResponse>(
        `/public/receipts/${encodeURIComponent(token)}`,
      ),
    getSellerDetail: (sellerId: string) =>
      request<import('./api.types').PublicSellerDetailResponse>(`/public/sellers/${sellerId}`),
    getOrgBranding: (orgSlug: string) =>
      request<import('./api.types').OrgBrandingResponse>(`/public/${encodeURIComponent(orgSlug)}/ski-swap/branding`),
    /** The SKU lookup page (Plan 33); 404 unless the swap has it on. */
    getSwapStatusPage: (orgSlug: string, swapSlug: string) =>
      request<import('./api.types').PublicSwapStatusPage>(
        `/public/${encodeURIComponent(orgSlug)}/swaps/${encodeURIComponent(swapSlug)}`,
      ),
    getSkuStatus: (orgSlug: string, swapSlug: string, sku: string) =>
      request<import('./api.types').PublicSkuStatus>(
        `/public/${encodeURIComponent(orgSlug)}/swaps/${encodeURIComponent(swapSlug)}/sku/${encodeURIComponent(sku)}`,
      ),
    findSeller: (orgSlug: string, email: string, last4: string) =>
      request<import('./api.types').SellerFindResponse>(
        `/public/${encodeURIComponent(orgSlug)}/ski-swap/seller-find?email=${encodeURIComponent(email)}&last4=${encodeURIComponent(last4)}`,
      ),
  },
};
