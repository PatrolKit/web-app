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
  /// A screen in a patrol room, running the PatrolKit device image. It is told
  /// what software to run by `GET /devices/me/bootstrap` rather than by having
  /// an image built for it.
  'signage.display',
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
    /**
     * Where the hardware stands. Offered here so a device is bound before it is
     * ever switched on, rather than being provisioned and then remembered about
     * — the same shape as binding a station's tablet. Rejected for any role
     * that has no resort.
     *
     * Optional in the schema and required by the service for `signage.display`:
     * whether a resort is mandatory depends on the role, and the schema cannot
     * see one field from another without making every role's rule live here.
     */
    resortId: z.string().min(1).optional(),
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
   * The stations this bridge serves, joined — "Station 1, Station 2" (Plan 27).
   * Null when nothing routes work to it — which also changes how often it calls
   * in, since the firmware backs off to a slow retry while unbound rather than
   * heartbeating.
   */
  stationName: z.string().nullable(),
  /** The same stations, one name each. */
  stationNames: z.array(z.string()),
  /**
   * The resort this device is bound to. Null for a kind of device that has no
   * resort, and for one nobody has placed yet. Carried here so the Devices page
   * can show the binding it offers to change.
   */
  resortId: z.string().nullable(),
  resortName: z.string().nullable(),
  /**
   * What a device running the PatrolKit device image last reported on its
   * bootstrap check-in. Null for every other kind of device, and for a display
   * that has been provisioned but has never reached the server.
   *
   * Carried on the list because "provisioned" and "running the right software"
   * are different claims, and this page is the only place either is visible.
   */
  hardwareId: z.string().nullable(),
  imageName: z.string().nullable(),
  imageVersion: z.string().nullable(),
  installedPackages: z.string().nullable(),
  bootstrapAt: z.date().nullable(),
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
    .object({
      id: z.string(),
      name: z.string(),
      code: z.string(),
      /**
       * The bridge this station prints through, or null when it has none
       * (Plan 28). Configuration, not live status: whether the bridge is checked
       * in and its printer ready is the helper-labels endpoint's answer.
       */
      printBridge: z
        .object({
          deviceId: z.string(),
          name: z.string(),
          /**
           * Checked in within the offline rule's 20 seconds, as of this answer
           * (iOS Plan 26). For a status dot: the print endpoint's own answer is
           * still the real test.
           */
          online: z.boolean(),
          lastSeenAt: z.string().nullable(),
          /** Null while the bridge drives no printer. */
          printer: z
            .object({
              id: z.string(),
              model: z.string(),
              paperSize: z.string(),
              /** The bridge last reported this printer ready. */
              ready: z.boolean(),
            })
            .nullable(),
        })
        .nullable(),
    })
    .nullable(),
  /**
   * Every station this device serves (Plan 27). A tablet serves one; a print
   * bridge may serve several staffed stations, and `station` is then the first
   * of them by name.
   */
  stations: z.array(z.object({ id: z.string(), name: z.string(), code: z.string() })),
  /**
   * The resort this terminal clocks people in at, or null when nobody has
   * placed it yet. Null is the answer a client needs to distinguish "no resort
   * assigned" from "not synced yet", so it is always present rather than
   * omitted.
   *
   * `timeZone` travels with it because the nightly auto-close runs in resort
   * local time: sending it means a freshly provisioned tablet is right before
   * its first resort sync rather than after.
   */
  resort: z
    .object({ id: z.string(), name: z.string(), timeZone: z.string() })
    .nullable(),
  sellerSiteUrl: z.string(),
  orgLogoUrl: z.string().nullable().optional(),
});

/** A terminal moved between lodges, rebinding itself. */
export const RebindDeviceSchema = z.object({ resortId: z.string().min(1) }).strict();

/**
 * An admin placing a terminal, or taking it out of service.
 *
 * Nullable where the device's own rebind is not: unbinding is a thing staff do
 * to hardware they are putting away, and not something a tablet asks for about
 * itself.
 */
export const BindResortSchema = z.object({ resortId: z.string().min(1).nullable() }).strict();

// ─── Device PIN ───────────────────────────────────────────────────────────────

/**
 * The PIN that unlocks a device's settings screen.
 *
 * It lives here rather than with either module because both modules' PINs are
 * the same thing — a gate on a screen, on a piece of hardware — and only the
 * answer differs. The two settings rows each store their own; the shape is
 * defined once.
 *
 * Four digits, fixed: both keypads on the iPad are numeric and the ski-swap one
 * submits itself on the fourth tap. A variable length would cost that pad a
 * confirm button to buy strength a gate anyone can stand in front of does not
 * have either way.
 */
export const DevicePinSchema = z.string().regex(/^\d{4}$/, 'Must be exactly 4 digits');

export const DevicePinResponseSchema = z.object({
  /** Null when no PIN is set, which means the settings screen opens unguarded. */
  devicePin: z.string().nullable(),
});

/**
 * `null` removes the PIN, and is the only way to say so.
 *
 * The field is required rather than optional precisely so that "remove it" is
 * something a caller has to mean: a body that could omit the field would make
 * clearing indistinguishable from a client that forgot to send it.
 */
export const UpdateDevicePinSchema = z
  .object({ devicePin: DevicePinSchema.nullable() })
  .strict();

// ─── DTOs ────────────────────────────────────────────────────────────────────

export class ProvisionDeviceDto extends createZodDto(ProvisionDeviceSchema) {}
export class RebindDeviceDto extends createZodDto(RebindDeviceSchema) {}
export class BindResortDto extends createZodDto(BindResortSchema) {}
export class UpdateDevicePinDto extends createZodDto(UpdateDevicePinSchema) {}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ProvisionDeviceRequest = z.infer<typeof ProvisionDeviceSchema>;
export type ProvisionDeviceResponse = z.infer<typeof ProvisionDeviceResponseSchema>;
export type DeviceListItem = z.infer<typeof DeviceListItemSchema>;
export type DeviceTokenResponse = z.infer<typeof DeviceTokenResponseSchema>;
export type DeviceMeResponse = z.infer<typeof DeviceMeResponseSchema>;
export type DevicePinResponse = z.infer<typeof DevicePinResponseSchema>;
export type UpdateDevicePinRequest = z.infer<typeof UpdateDevicePinSchema>;
