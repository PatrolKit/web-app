import { ProvisionDeviceSchema, DeviceListItemSchema } from './devices.contracts';

describe('Devices contracts', () => {
  it('accepts a valid provision request', () => {
    expect(
      ProvisionDeviceSchema.safeParse({ name: 'Patrol A', permissions: ['devices:read'] }).success,
    ).toBe(true);
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
});
