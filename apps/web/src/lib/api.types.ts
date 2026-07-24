// Shared types used by the web API client
// These mirror the API contract shapes (source of truth is apps/api/src/contracts/)

export interface MembershipSummary {
  orgId: string;
  orgName: string;
  orgSlug: string;
  status: string;
  permissions: string[];
}

export interface MeResponse {
  id: string;
  email: string;
  name: string;
  isSuperAdmin: boolean;
  memberships: MembershipSummary[];
}

export interface OrgResponse {
  id: string;
  name: string;
  slug: string;
  status: string;
  modules: ModuleItem[];
}

export interface MemberResponse {
  userId: string;
  email: string;
  name: string;
  status: string;
  joinedAt: string;
  permissions: string[];
}

export interface ImportOutcome {
  row: number;
  email: string;
  outcome: 'created' | 'already_member' | 'invited' | 'error';
  error?: string;
}

export interface ModuleItem {
  key: string;
  name: string;
  description: string;
  isCore: boolean;
  enabled: boolean;
  enabledAt: string | null;
}

export interface DeviceItem {
  id: string;
  clientId: string;
  name: string;
  orgId: string;
  status: string;
  permissions: string[];
  lastSeenAt: string | null;
  createdAt: string;
}

export interface ProvisionedDevice extends DeviceItem {
  clientSecret: string;
}

export interface PlatformOrg {
  id: string;
  name: string;
  slug: string;
  status: string;
  createdAt: string;
}
