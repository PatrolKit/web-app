import {
  PermissionKeySchema,
  ALL_PERMISSION_KEYS,
  PatchMeSchema,
  PatchOrgSchema,
  CreateResortSchema,
  PatchResortSchema,
} from './org.contracts';

describe('Org contracts', () => {
  describe('PermissionKeySchema', () => {
    // Listed out in full on purpose: the catalog governs who can do what, so adding or
    // removing a key should require touching this test rather than sliding through.
    const EXPECTED_KEYS = [
      'org:read', 'org:manage', 'modules:manage',
      'users:read', 'users:invite', 'users:import', 'users:manage',
      'permissions:assign',
      'ski_swap:report', 'ski_swap:manage', 'ski_swap:admin',
      'time_tracking:report', 'time_tracking:manage', 'time_tracking:admin',
      'signage:report', 'signage:manage', 'signage:admin',
    ];

    it('accepts every key in the catalog', () => {
      EXPECTED_KEYS.forEach((k) => expect(PermissionKeySchema.safeParse(k).success).toBe(true));
    });

    it('contains exactly the expected keys and no others', () => {
      expect([...ALL_PERMISSION_KEYS].sort()).toEqual([...EXPECTED_KEYS].sort());
    });

    it('rejects an unknown key', () => {
      expect(PermissionKeySchema.safeParse('admin:all').success).toBe(false);
    });
  });

  describe('PatchMeSchema', () => {
    it('accepts either name part on its own', () => {
      expect(PatchMeSchema.safeParse({ firstName: 'Alice' }).success).toBe(true);
      expect(PatchMeSchema.safeParse({ lastName: 'Reyes' }).success).toBe(true);
    });
    it('rejects an empty name part', () => {
      expect(PatchMeSchema.safeParse({ firstName: '' }).success).toBe(false);
    });
    it('rejects an empty object', () => {
      expect(PatchMeSchema.safeParse({}).success).toBe(false);
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
  describe('CreateResortSchema', () => {
    it('accepts a name on its own — the address is optional', () => {
      expect(CreateResortSchema.safeParse({ name: 'North Lodge' }).success).toBe(true);
    });
    it('accepts a full address', () => {
      const r = CreateResortSchema.safeParse({
        name: 'North Lodge', street: '1 Summit Rd', city: 'Lake Placid', state: 'NY', zip: '12946',
      });
      expect(r.success).toBe(true);
    });
    it('accepts ZIP+4', () => {
      expect(CreateResortSchema.safeParse({ name: 'X', zip: '12946-1234' }).success).toBe(true);
    });
    it('rejects a state that is not two letters', () => {
      expect(CreateResortSchema.safeParse({ name: 'X', state: 'New York' }).success).toBe(false);
    });
    it('rejects a malformed ZIP', () => {
      expect(CreateResortSchema.safeParse({ name: 'X', zip: '1294' }).success).toBe(false);
    });
    it('rejects an empty name', () => {
      expect(CreateResortSchema.safeParse({ name: '' }).success).toBe(false);
    });
    it('rejects unknown fields', () => {
      expect(CreateResortSchema.safeParse({ name: 'X', active: true }).success).toBe(false);
    });
  });

  describe('PatchResortSchema', () => {
    it('accepts a single field', () => {
      expect(PatchResortSchema.safeParse({ city: 'Stowe' }).success).toBe(true);
    });
    it('accepts clearing an address field with null', () => {
      expect(PatchResortSchema.safeParse({ street: null }).success).toBe(true);
    });
    it('accepts an explicit time zone override', () => {
      expect(PatchResortSchema.safeParse({ timeZone: 'America/Denver' }).success).toBe(true);
    });
    it('rejects an empty object', () => {
      expect(PatchResortSchema.safeParse({}).success).toBe(false);
    });
  });
});
