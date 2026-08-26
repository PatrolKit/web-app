import * as fs from 'fs';
import * as path from 'path';
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

/**
 * The web app keeps its own copy of the role list, because it needs a label and
 * a hint per role that the server has no use for. That copy is what the
 * provisioning dropdown renders — so a role added here and forgotten there is a
 * role nobody can provision, which is exactly what happened to the network
 * printer adapter.
 */
describe('DeviceRole parity with the web app', () => {
  const webTypes = fs.readFileSync(
    path.join(__dirname, '..', '..', '..', 'web', 'src', 'lib', 'api.types.ts'),
    'utf8',
  );

  it('offers every server role in the web UI', () => {
    const block = webTypes.match(/export const DEVICE_ROLES = \[([\s\S]*?)\] as const;/);
    expect(block).not.toBeNull();

    const offered = [...block![1].matchAll(/value: '([^']+)'/g)].map((m) => m[1]);
    expect(offered.sort()).toEqual([...DeviceRoleSchema.options].sort());
  });
});
