import { ProvisionDeviceSchema, DeviceListItemSchema, DeviceMeResponseSchema, DeviceRoleSchema } from './devices.contracts';

describe('Devices contracts', () => {
  it('accepts a valid provision request', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', role: 'Ski Swap - Check-In' }).success,
    ).toBe(true);
  });

  it('accepts a provision request with a valid role', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', role: 'Ski Swap - Check-In' }).success,
    ).toBe(true);
  });

  it('rejects a provision request without a role', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', permissions: [] }).success,
    ).toBe(false);
  });

  it('rejects a provision request with null role', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', role: null, permissions: [] }).success,
    ).toBe(false);
  });

  it('rejects a free-form role string', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', role: 'arbitrary text', permissions: [] }).success,
    ).toBe(false);
  });

  it('rejects unknown permission', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', role: 'Ski Swap - Check-In', permissions: ['bad:key'] }).success,
    ).toBe(false);
  });

  it('accepts a name and role alone — the role is what authorises the device', () => {
    const r = ProvisionDeviceSchema.parse({ name: 'X', role: 'Ski Swap - Bulk Seller' });
    expect(r).toEqual({ name: 'X', role: 'Ski Swap - Bulk Seller' });
  });

  it('clientSecret absent from list item schema', () => {
    const fields = Object.keys(DeviceListItemSchema.shape);
    expect(fields).not.toContain('clientSecret');
  });

  it('list item schema includes role but not status', () => {
    const fields = Object.keys(DeviceListItemSchema.shape);
    expect(fields).toContain('role');
    expect(fields).not.toContain('status');
  });

  it('DeviceRoleSchema accepts valid role values', () => {
    expect(DeviceRoleSchema.safeParse('Ski Swap - Check-In').success).toBe(true);
    expect(DeviceRoleSchema.safeParse('Ski Swap - Bulk Seller').success).toBe(true);
  });

  it('DeviceRoleSchema rejects unknown values', () => {
    expect(DeviceRoleSchema.safeParse('SkiSwap Check-in').success).toBe(false);
    expect(DeviceRoleSchema.safeParse('').success).toBe(false);
  });

  it('DeviceMeResponseSchema includes orgName and role but not status', () => {
    const fields = Object.keys(DeviceMeResponseSchema.shape);
    expect(fields).toContain('orgName');
    expect(fields).toContain('role');
    expect(fields).not.toContain('status');
  });
});
