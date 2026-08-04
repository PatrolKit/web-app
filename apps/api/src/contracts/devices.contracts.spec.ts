import { ProvisionDeviceSchema, DeviceListItemSchema, DeviceMeResponseSchema } from './devices.contracts';

describe('Devices contracts', () => {
  it('accepts a valid provision request', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', permissions: ['devices:read'] }).success,
    ).toBe(true);
  });

  it('accepts a provision request with role', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', role: 'SkiSwap Check-in', permissions: [] }).success,
    ).toBe(true);
  });

  it('accepts a provision request with null role', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', role: null, permissions: [] }).success,
    ).toBe(true);
  });

  it('rejects role longer than 100 chars', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', role: 'x'.repeat(101), permissions: [] }).success,
    ).toBe(false);
  });

  it('rejects unknown permission', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', permissions: ['bad:key'] }).success,
    ).toBe(false);
  });

  it('defaults permissions to empty array', () => {
    const r = ProvisionDeviceSchema.parse({ name: 'X' });
    expect(r.permissions).toEqual([]);
  });

  it('clientSecret absent from list item schema', () => {
    const fields = Object.keys(DeviceListItemSchema.shape);
    expect(fields).not.toContain('clientSecret');
  });

  it('list item schema includes role', () => {
    const fields = Object.keys(DeviceListItemSchema.shape);
    expect(fields).toContain('role');
  });

  it('DeviceMeResponseSchema includes orgName and role', () => {
    const fields = Object.keys(DeviceMeResponseSchema.shape);
    expect(fields).toContain('orgName');
    expect(fields).toContain('role');
  });
});
