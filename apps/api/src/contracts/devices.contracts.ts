import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';

// ─── Role enumeration ─────────────────────────────────────────────────────────

/**
 * What kind of device this is, as a stable identifier.
 *
 * `module.thing`, never prose: a role used to be both a machine key and the
 * string the UI printed, which is why renaming one was entangled with client
 * routing. The module is the segment before the dot, so nothing has to match on
 * English. Display labels live with the UI that renders them.
 */
export const DeviceRoleSchema = z.enum([
  /// A tablet staff check sellers in on.
  'ski_swap.staff_check_in',
  /// An ESP-32 bridging wifi to a Phomemo over BLE. It never renders anything
  /// itself — it claims jobs, forwards the bytes, and reports the result.
  'ski_swap.print_bridge',
  /// A tablet patrollers clock in and out on.
  'time_clock.terminal',
]);
export type DeviceRole = z.infer<typeof DeviceRoleSchema>;

/** The module a device belongs to, without matching on prose. */
export function moduleOfRole(role: DeviceRole): string {
  return role.split('.')[0];
}

// ─── Provision request / response ────────────────────────────────────────────

export const ProvisionDeviceSchema = z
  .object({
    /**
     * Optional because a print bridge does not have one: it is a printer's
     * network adapter and is called after the printer it drives, which is not
     * chosen yet at this point. The column stays required, so a bridge gets a
     * constant nothing displays.
     */
    name: z.string().min(1).max(100).optional(),
    role: DeviceRoleSchema,
  })
  .strict();

export const ProvisionDeviceResponseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  clientSecret: z.string(), // present ONLY in provision + rotate responses
  name: z.string(),
  role: DeviceRoleSchema,
  orgId: z.string(),
  createdAt: z.date(),
});

// ─── List response ────────────────────────────────────────────────────────────

export const DeviceListItemSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  role: DeviceRoleSchema,
  orgId: z.string(),
  lastSeenAt: z.date().nullable(),
  /**
   * A bridge's last word on its own BLE link to its printer, and when it said
   * so. Null for every other kind of device. Surfaced here so a bridge can be
   * judged on the page it lives on, without going through a station it may not
   * be bound to yet — a stale `ready` means nothing, so the age travels with
   * the value.
   */
  printerLink: z.enum(['ready', 'down']).nullable(),
  printerLinkAt: z.date().nullable(),
  /**
   * The printer this bridge drives, which is also what a bridge is called: a
   * bridge is one printer's network adapter and has no identity apart from it.
   * Null for a bridge not yet bound, and for every other kind of device.
   */
  printerName: z.string().nullable(),
  /**
   * The station this bridge serves. Null when nothing routes work to it — which
   * also changes how often it calls in, since the firmware backs off to a slow
   * retry while unbound rather than heartbeating.
   */
  stationName: z.string().nullable(),
  createdAt: z.date(),
});

// ─── Device token ─────────────────────────────────────────────────────────────

export const DeviceTokenResponseSchema = z.object({
  accessToken: z.string(),
  tokenType: z.literal('Bearer'),
});

// ─── Device me ───────────────────────────────────────────────────────────────

export const DeviceMeResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  role: DeviceRoleSchema,
  orgId: z.string(),
  orgName: z.string(),
  /**
   * The station this device is bound to, or null.
   *
   * The code is the station's, not the device's: it names the counter, so a
   * failed tablet can be swapped without the SKU namespace moving with it. Null
   * means unbound — a client that mints SKUs itself cannot, and should say so.
   */
  station: z
    .object({ id: z.string(), name: z.string(), code: z.string() })
    .nullable(),
  sellerSiteUrl: z.string(),
  orgLogoUrl: z.string().nullable().optional(),
});

// ─── DTOs ────────────────────────────────────────────────────────────────────

export class ProvisionDeviceDto extends createZodDto(ProvisionDeviceSchema) {}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProvisionDeviceRequest = z.infer<typeof ProvisionDeviceSchema>;
export type ProvisionDeviceResponse = z.infer<typeof ProvisionDeviceResponseSchema>;
export type DeviceListItem = z.infer<typeof DeviceListItemSchema>;
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;
export type DeviceMeResponse = z.infer<typeof DeviceMeResponseSchema>;
