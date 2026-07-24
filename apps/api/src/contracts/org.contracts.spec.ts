import {
  PermissionKeySchema,
  ALL_PERMISSION_KEYS,
  PatchMeSchema,
  PatchOrgSchema,
} from './org.contracts';

describe('Org contracts', () => {
  describe('PermissionKeySchema', () => {
    it('accepts all 11 §6 keys', () => {
      const keys = [
        'org:read', 'org:manage', 'modules:manage',
        'users:read', 'users:invite', 'users:import', 'users:manage',
        'permissions:assign', 'devices:read', 'devices:provision', 'devices:revoke',
      ];
      keys.forEach((k) => expect(PermissionKeySchema.safeParse(k).success).toBe(true));
      expect(ALL_PERMISSION_KEYS).toHaveLength(11);
    });

    it('rejects an unknown key', () => {
      expect(PermissionKeySchema.safeParse('admin:all').success).toBe(false);
    });
  });

  describe('PatchMeSchema', () => {
    it('accepts a valid name', () => {
      expect(PatchMeSchema.safeParse({ name: 'Alice' }).success).toBe(true);
    });
    it('rejects an empty name', () => {
      expect(PatchMeSchema.safeParse({ name: '' }).success).toBe(false);
    });
    it('rejects unknown fields', () => {
      expect(PatchMeSchema.safeParse({ name: 'Alice', email: 'x@x.com' }).success).toBe(false);
    });
  });

  describe('PatchOrgSchema', () => {
    it('accepts name only', () => {
      expect(PatchOrgSchema.safeParse({ name: 'New Name' }).success).toBe(true);
    });
    it('accepts status only', () => {
      expect(PatchOrgSchema.safeParse({ status: 'suspended' }).success).toBe(true);
    });
    it('rejects an invalid status', () => {
      expect(PatchOrgSchema.safeParse({ status: 'deleted' }).success).toBe(false);
    });
    it('rejects an empty object', () => {
      expect(PatchOrgSchema.safeParse({}).success).toBe(false);
    });
    it('rejects unknown fields', () => {
      expect(PatchOrgSchema.safeParse({ name: 'x', extra: true }).success).toBe(false);
    });
  });
});
