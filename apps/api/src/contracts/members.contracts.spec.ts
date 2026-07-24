import { InviteMemberSchema, UpdateMemberSchema, CreateOrgSchema } from './members.contracts';

describe('Members contracts', () => {
  describe('InviteMemberSchema', () => {
    it('accepts valid invite', () => {
      expect(
        InviteMemberSchema.safeParse({ email: 'a@b.com', permissions: [] }).success,
      ).toBe(true);
    });
    it('rejects invalid email', () => {
      expect(InviteMemberSchema.safeParse({ email: 'bad' }).success).toBe(false);
    });
    it('rejects unknown permission key', () => {
      expect(
        InviteMemberSchema.safeParse({ email: 'a@b.com', permissions: ['bad:key'] }).success,
      ).toBe(false);
    });
    it('normalises email', () => {
      const r = InviteMemberSchema.parse({ email: '  A@B.COM  ' });
      expect(r.email).toBe('a@b.com');
    });
  });

  describe('UpdateMemberSchema', () => {
    it('accepts status only', () => {
      expect(UpdateMemberSchema.safeParse({ status: 'active' }).success).toBe(true);
    });
    it('accepts permissions only', () => {
      expect(UpdateMemberSchema.safeParse({ permissions: ['org:read'] }).success).toBe(true);
    });
    it('rejects empty object', () => {
      expect(UpdateMemberSchema.safeParse({}).success).toBe(false);
    });
  });

  describe('CreateOrgSchema', () => {
    it('accepts valid org', () => {
      expect(
        CreateOrgSchema.safeParse({
          name: 'Acme', slug: 'acme', ownerEmail: 'ceo@acme.com',
        }).success,
      ).toBe(true);
    });
    it('rejects slug with uppercase', () => {
      expect(
        CreateOrgSchema.safeParse({ name: 'A', slug: 'A', ownerEmail: 'a@b.com' }).success,
      ).toBe(false);
    });
  });
});
