import { z } from 'zod';
import { createZodDto } from 'nestjs-zod';
import { PAYOUT_LINE_STATUSES } from './payouts.contracts';

// ─── Square Config ────────────────────────────────────────────────────────────

export const UpsertSquareConfigSchema = z
  .object({
    accessToken: z.string().min(1),
    environment: z.enum(['sandbox', 'production']).default('production'),
  })
  .strict();

export const SquareConfigResponseSchema = z.object({
  orgId: z.string(),
  accessToken: z.literal('***'),
  environment: z.enum(['sandbox', 'production']),
  updatedAt: z.string().datetime(),
});

export class UpsertSquareConfigDto extends createZodDto(UpsertSquareConfigSchema) {}
export type SquareConfigResponse = z.infer<typeof SquareConfigResponseSchema>;

// ─── Swaps ────────────────────────────────────────────────────────────────────

/** A swap's public address segment (Plan 33). Mirrors `SWAP_SLUG_PATTERN`. */
const SwapSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9-]{1,40}$/, 'A slug is up to 40 lowercase letters, digits and hyphens');

/** The Receipts tab (Plan 36). Which combinations are legal is the service's to say. */
const ReceiptSettingsFields = {
  receiptMode: z.enum(['ITEMIZED', 'STATUS_ONLY', 'NONE']).optional(),
  receiptShowSku: z.boolean().optional(),
  receiptShowName: z.boolean().optional(),
  receiptShowPrice: z.boolean().optional(),
  receiptLink: z.enum(['NONE', 'SKU_LOOKUP', 'SELLER_STATUS', 'SELLER_LOGIN']).optional(),
  receiptPrintEnabled: z.boolean().optional(),
  receiptPaperSize: z.enum(['62x100', '50x30']).optional(),
  receiptFinePrintEnabled: z.boolean().optional(),
  /** HTML; sanitized to a small subset on save. Generous here, the 2,000-character text limit is the service's. */
  receiptFinePrint: z.string().max(20000).nullable().optional(),
};

/** The Status Page tab's three switches (Plan 33). */
const StatusPageToggles = {
  /** Unauthenticated SKU Lookup: anyone may check one SKU's status. */
  skuLookupEnabled: z.boolean().optional(),
  /** Unauthenticated Seller Status: the email and last-4 lookup, and `/s/`. */
  sellerLookupEnabled: z.boolean().optional(),
  /** Authenticated Seller Status: an individual seller here may sign in. */
  sellerLoginEnabled: z.boolean().optional(),
};

export const CreateSwapSchema = z
  .object({
    title: z.string().min(1).max(100),
    locationId: z.string().min(1),
    /** Derived from the title when absent. */
    slug: SwapSlug.optional(),
    ...StatusPageToggles,
    ...ReceiptSettingsFields,
  })
  .strict();

export const PatchSwapSchema = z
  .object({
    title: z.string().min(1).max(100).optional(),
    active: z.boolean().optional(),
    locationId: z.string().min(1).optional(),
    /**
     * How items come in, per place (Plan 34). Each place must take legacy
     * tickets, print tickets, or both; a patch leaving one with neither is
     * refused.
     */
    allowLegacyCheckin: z.boolean().optional(),
    allowLegacyWeb: z.boolean().optional(),
    allowPrintCheckin: z.boolean().optional(),
    allowPrintWeb: z.boolean().optional(),
    /** Refused unless staff check-in takes, or is being made to take, legacy tickets. */
    printLegacyHelperLabels: z.boolean().optional(),
    labelsPerItem: z.number().int().min(1).max(3).optional(),
    /** Changes the status page's address; a rename doesn't (Plan 33). */
    slug: SwapSlug.optional(),
    ...StatusPageToggles,
    ...ReceiptSettingsFields,
  })
  .strict()
  // Counted rather than named, so a field added above cannot be silently
  // rejected here as "nothing to do" — which is how the last one was missed.
  .refine((v) => Object.keys(v).length > 0, {
    message: 'At least one field must be provided',
  });

export const SwapResponseSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  title: z.string(),
  squareCategoryId: z.string(),
  locationId: z.string(),
  active: z.boolean(),
  skuPrefix: z.string(),
  /**
   * How items come in, said positively, per place (Plan 34). A legacy ticket is
   * already on the gear, from the old stockpile; a print ticket is a tag
   * printed here. Each place takes at least one.
   *
   * Staff check-in is the iPad's: `allowLegacyCheckin` shows its Add Legacy
   * Ticket option, and `allowPrintCheckin` false means no printed tags there,
   * so a bridge refuses item tags (`TAGS_OFF`). The web is a seller's own entry
   * and uploads, and staff uploading for one; the iPad doesn't read those two.
   */
  allowLegacyCheckin: z.boolean(),
  allowPrintCheckin: z.boolean(),
  allowLegacyWeb: z.boolean(),
  allowPrintWeb: z.boolean(),
  /**
   * Whether the staff iPad prints a helper label with each legacy ticket at
   * check-in. Only ever true alongside `allowLegacyCheckin`, which clears it.
   */
  printLegacyHelperLabels: z.boolean(),
  /** Price tags printed each time an item's tag is printed, 1 to 3. */
  labelsPerItem: z.number().int(),
  /** The public address segment: `<org>/<slug>/status` (Plan 33). */
  slug: z.string(),
  skuLookupEnabled: z.boolean(),
  sellerLookupEnabled: z.boolean(),
  sellerLoginEnabled: z.boolean(),
  /** Receipt settings (Plan 36). The iPad reads all but the fine print. */
  receiptMode: z.enum(['ITEMIZED', 'STATUS_ONLY', 'NONE']),
  receiptShowSku: z.boolean(),
  receiptShowName: z.boolean(),
  receiptShowPrice: z.boolean(),
  receiptLink: z.enum(['NONE', 'SKU_LOOKUP', 'SELLER_STATUS', 'SELLER_LOGIN']),
  receiptPrintEnabled: z.boolean(),
  receiptPaperSize: z.enum(['62x100', '50x30']),
  receiptFinePrintEnabled: z.boolean(),
  receiptFinePrint: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export class CreateSwapDto extends createZodDto(CreateSwapSchema) {}
export class PatchSwapDto extends createZodDto(PatchSwapSchema) {}
export type SwapResponse = z.infer<typeof SwapResponseSchema>;

// ─── Sellers ─────────────────────────────────────────────────────────────────

const PAYOUT_METHODS = ['PAYPAL', 'VENMO', 'CHECK', 'DONATE'] as const;

/**
 * Where a payout goes: a recipient type, and a value when one was typed.
 *
 * `EMAIL`, `PHONE` and `PAYPAL_ID` are PayPal Payouts' own recipient types, so
 * the type is a discriminator rather than decoration — the payment run has to
 * tell them apart. It also records whether the destination was proven or
 * self-asserted, which nothing else would.
 *
 * Which combinations are legal is enforced in the service, not here: the rules
 * span `payoutMethod`, the target, the handle and the person's verified
 * contacts, and a schema cannot see the last of those.
 */
export const PAYOUT_TARGETS = ['EMAIL', 'PHONE', 'PAYPAL_ID', 'VENMO_ID'] as const;

const PayoutFields = {
  payoutMethod: z.enum(PAYOUT_METHODS).nullable().optional(),
  payoutTarget: z.enum(PAYOUT_TARGETS).nullable().optional(),
  payoutHandle: z.string().trim().min(1).max(191).nullable().optional(),
  /**
   * Where a Venmo handle came from (Plan 35). `SCAN`: read from the seller's
   * Venmo code at the counter. Required to set or change one; a typed handle
   * is refused.
   */
  payoutHandleSource: z.enum(['SCAN']).optional(),
};

/** Person fields live on User and are global; they are edited through the seller API for convenience. */
const PersonFields = {
  firstName: z.string().trim().max(100).nullable().optional(),
  lastName: z.string().trim().max(100).nullable().optional(),
  phone: z.string().trim().max(32).nullable().optional(),
  email: z.string().trim().toLowerCase().email().nullable().optional(),
  street: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(50).nullable().optional(),
  zip: z.string().max(20).nullable().optional(),
};

/**
 * An id the client minted, for a row it is creating (iOS Plan 17 A).
 *
 * The offline client names a row before the server can, and one id means it
 * never has to rename one afterwards. Absent, the server mints it.
 *
 * Creating under an id that is already taken answers with the row that has it
 * — but only when that row is one the caller could already read. A primary key
 * is unique across the whole database, not per org, so "return what is there"
 * would otherwise hand somebody another organization's record for the cost of a
 * guess. The other org's row is a conflict, never an answer.
 */
export const ClientMintedId = z.string().uuid().optional();

export const CreateSellerSchema = z
  .object({
    id: ClientMintedId,
    ...PersonFields,
    /// Set ⇒ business seller. Null or absent ⇒ individual.
    businessName: z.string().trim().min(1).max(100).nullable().optional(),
    ...PayoutFields,
  })
  .strict()
  .refine((v) => Boolean(v.email || v.phone || (v.firstName && v.lastName) || v.businessName), {
    message: 'A seller needs at least a name, an email, or a phone number',
  });

export const PatchSellerSchema = z
  .object({
    ...PersonFields,
    businessName: z.string().trim().min(1).max(100).nullable().optional(),
    ...PayoutFields,
    /**
     * The `updatedAt` this client last saw for the seller (iOS Plan 17 C).
     *
     * Present, the write is refused with 409 and `SELLER_MODIFIED` if the row
     * has moved since — an iPad correcting a phone offline must not put back
     * an address an administrator fixed on the web in the meantime, which is
     * what a whole-record patch did, silently, to whoever saved first.
     *
     * Absent means no check, so a caller that does not track a watermark is
     * unaffected. The comparison is against the membership's `updatedAt`, the
     * same watermark the delta is filtered on — a person's fields live on
     * `User` and the profile's own column would not move when one changed.
     */
    baseUpdatedAt: z.string().datetime().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const SellerResponseSchema = z.object({
  /// SellerProfile id — the public /s/:sellerId identifier and the FK items point at.
  id: z.string(),
  orgId: z.string(),
  userId: z.string(),
  businessName: z.string().nullable(),
  firstName: z.string().nullable(),
  lastName: z.string().nullable(),
  /// businessName, else "First Last", else a contact. Never empty.
  displayName: z.string(),
  phone: z.string().nullable(),
  email: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  zip: z.string().nullable(),
  payoutMethod: z.enum(PAYOUT_METHODS).nullable(),
  payoutTarget: z.enum(PAYOUT_TARGETS).nullable(),
  payoutHandle: z.string().nullable(),
  /** Whether the Venmo handle was scanned from the seller's code (Plan 35). Unscanned isn't paid. */
  payoutHandleScanned: z.boolean(),
  emailVerifiedAt: z.string().datetime().nullable(),
  phoneVerifiedAt: z.string().datetime().nullable(),
  /**
   * Where a receipt would go, or null if there is nowhere to send one.
   *
   * Derived from the *verified* contacts, by the same rule the send itself
   * uses — so a client can disable the button rather than discovering the
   * refusal by pressing it. The channel rather than a boolean, because the
   * button says which it will be.
   *
   * Deliberately not the address: knowing a receipt can be sent is not the
   * same as needing the contact, and this rides on every seller in the list.
   */
  receiptChannel: z.enum(['EMAIL', 'SMS']).nullable(),
  /**
   * The active swaps this seller has items in: what a receipt can be printed
   * for. Empty when there are none, and the staff list then offers no receipt.
   */
  receiptSwaps: z.array(z.object({
    id: z.string(),
    title: z.string(),
    /** The paper its receipts print on, or null when it doesn't print them (Plan 36). */
    printPaperSize: z.string().nullable(),
  })),
  /**
   * Set once the seller has been removed, from the swap or from the org.
   * Returned only to a caller passing `updatedSince` — a soft removal exists so
   * that an offline client can learn about it, which it cannot do from a list
   * that simply stops mentioning the row.
   */
  deletedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  /**
   * `Membership.updatedAt` — the one watermark for everything about a person at
   * an org, and what `?updatedSince=` filters on. Not the seller profile's own
   * timestamp, which moves only when a business name changes.
   */
  updatedAt: z.string().datetime(),
});

/**
 * Cross-org lookup discloses a name and nothing else. The full record follows
 * only after staff confirm identity with the person in front of them.
 */
export const PersonSearchResultSchema = z.object({
  userId: z.string(),
  displayName: z.string(),
  /// True when this person already has a live seller profile at this org.
  alreadyHere: z.boolean(),
});

export const PersonSearchSchema = z
  .object({
    email: z.string().trim().toLowerCase().optional(),
    phone: z.string().trim().optional(),
  })
  .strict()
  .refine((v) => Boolean(v.email || v.phone), { message: 'Provide an email or a phone number' });

export const AddSellerFromPersonSchema = z.object({ userId: z.string().min(1) }).strict();

export class CreateSellerDto extends createZodDto(CreateSellerSchema) {}
export class PatchSellerDto extends createZodDto(PatchSellerSchema) {}
export class PersonSearchDto extends createZodDto(PersonSearchSchema) {}
export class AddSellerFromPersonDto extends createZodDto(AddSellerFromPersonSchema) {}
export type SellerResponse = z.infer<typeof SellerResponseSchema>;
export type PersonSearchResult = z.infer<typeof PersonSearchResultSchema>;

// ─── Items ────────────────────────────────────────────────────────────────────

/**
 * One answered question, on the way in (Plan 19 §7.3).
 *
 * Exactly one of the three value fields: a listed value, a number, or a string
 * the seller typed that mints a PENDING org value. The service refuses more
 * than one rather than picking — a client that sends two does not know what it
 * meant, and guessing would put the wrong thing on a tag.
 */
export const ItemAttributeInputSchema = z
  .object({
    attributeId: z.string().min(1),
    valueId: z.string().optional(),
    numberValue: z.number().optional(),
    freeText: z.string().min(1).max(120).optional(),
  })
  .strict();

export const CreateItemSchema = z
  .object({
    /** See `ClientMintedId`. Absent, the server mints one. */
    id: ClientMintedId,
    /**
     * The CATEGORY node this item is described under. The name is derived from
     * it and the answers below, so nothing sends a name any more.
     *
     * Optional (iOS Plan 20): an item nobody described is named by its tag
     * number, `Item #<sku>`, and carries no answers — `attributes` with no
     * category is refused. Omit the key rather than sending an empty string.
     */
    categoryId: z.string().min(1).optional(),
    attributes: z.array(ItemAttributeInputSchema).max(24).default([]),
    /**
     * The name the client already printed on the tag.
     *
     * Honoured only alongside `alreadyPrinted` — see there. Sent without it, it
     * is ignored and the name is derived, because a client that has not put ink
     * on the item has no claim the server's own derivation does not have.
     */
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).optional(),
    /**
     * Null or absent only for a legacy ticket, whose price comes after
     * check-in (Plan 32). The service refuses it for any other SKU: whether
     * an item is a ticket can depend on the number the server assigns.
     */
    priceCents: z.number().int().positive().nullable().optional(),
    quantity: z.number().int().positive(),
    sellerId: z.string().optional(),
    donateProceeds: z.boolean().default(false),
    sku: z.string().max(20).optional(),
    /**
     * The counter this was checked in at. Decides which station's queue prints
     * the tag and which code namespaces the SKU.
     */
    stationId: z.string().optional(),
    /**
     * The tag is already on the item — printed over Bluetooth by the client
     * rather than through the station's bridge.
     *
     * Skips the enqueue. Without it, an item checked in while the network was
     * down would print a second tag when it finally syncs, and during an outage
     * that happens for every item, discovered as a pile of orphan tags nobody
     * can place.
     *
     * It also decides whether `name` above is taken verbatim. The iPad prints
     * first and queues the create, and that queue may not drain for hours; by
     * the time it does, the name is ink on a ski in a rack. Re-deriving then
     * would produce a record that disagrees with the physical object, and the
     * object is the half nobody can correct. So when this says a tag exists, the
     * client that printed it is the authority on what it says.
     */
    alreadyPrinted: z.boolean().optional(),
    /**
     * `false`: queue no tag at the station's bridge, whatever `alreadyPrinted`
     * says (iOS Plan 26). The iPad prints the tag itself when the item is
     * saved, through the bridge or over Bluetooth, and patches `hasPrintedTag`
     * once it has. A tag queued when a delayed create finally lands would come
     * out after the seller has gone. Omitted, a create behaves as before.
     */
    queueTag: z.boolean().optional(),
  })
  .strict();

export const PatchItemSchema = z
  .object({
    /**
     * Changing the category re-asks every question, so `attributes` must come
     * with it. Sending either alone re-derives the name from what is stored.
     */
    categoryId: z.string().min(1).optional(),
    attributes: z.array(ItemAttributeInputSchema).max(24).optional(),
    /**
     * Replaces the name outright, for a client correcting an item whose tag it
     * holds. Unlike the create path this needs no flag: an item being patched
     * already exists, so a tag for it may already exist too, and an explicit
     * name here is a deliberate statement rather than an incidental one.
     */
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(2000).nullable().optional(),
    priceCents: z.number().int().positive().optional(),
    quantity: z.number().int().nonnegative().optional(),
    sellerId: z.string().nullable().optional(),
    donateProceeds: z.boolean().optional(),
    hasPrintedTag: z.boolean().optional(),
  })
  .strict();

export const ItemResponseSchema = z.object({
  id: z.string(),
  swapId: z.string(),
  orgId: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  sku: z.string(),
  /** Null for a legacy ticket not yet priced (Plan 32). */
  priceCents: z.number().int().nullable(),
  originalQuantity: z.number().int(),
  inStock: z.number().int(),
  soldCount: z.number().int(),
  /**
   * Whether `inStock` and `soldCount` are Square's answer. False when Square
   * could not be read: the two numbers then say "unsold" as a placeholder,
   * which is a guess and must be shown as one. True for anything not in Square,
   * whose stock is a fact about our own row.
   */
  inventoryKnown: z.boolean(),
  squareSynced: z.boolean(),
  donateProceeds: z.boolean(),
  hasPrintedTag: z.boolean(),
  /**
   * This item's tag came out of a box rather than a printer.
   *
   * Derived from the SKU, which is the only thing that carries it: a tag we
   * minted is a prefix, a station letter and a sequence, and a pre-printed
   * ticket is bare digits. Both check-in paths for one already set
   * `hasPrintedTag`, so the two are easy to confuse — that one says a tag
   * exists, this one says we cannot make another.
   */
  legacyTicket: z.boolean(),
  /**
   * When a staff member accepted this item onto the floor, or null while it is
   * still waiting to be looked at. An item is in Square exactly when this is
   * set — null means it cannot be sold, because it is not in the catalogue.
   */
  consignedAt: z.string().datetime().nullable(),
  seller: SellerResponseSchema.pick({ id: true, displayName: true, phone: true }).nullable(),
  photos: z.array(z.object({ id: z.string(), url: z.string() })),
  /**
   * What this item is, as the tree reads it now (Plan 19 D3). Null for an item
   * an importer created from a name alone.
   *
   * `name` above is the historic record — derived once, frozen, and what the tag
   * and the receipt say. These are the live pointers, resolved through the tree
   * on read, so the two are allowed to disagree after an administrator tidies a
   * label. §2.2 of the plan says why that is the intended reading.
   */
  category: z.object({ id: z.string(), label: z.string() }).nullable(),
  attributes: z.array(
    z.object({
      attributeId: z.string(),
      attributeLabel: z.string(),
      valueId: z.string().nullable(),
      valueLabel: z.string(),
      numberValue: z.number().nullable(),
    }),
  ),
  /**
   * The watermark `GET items?updatedSince=` filters on. Without it the filter
   * existed but nothing could supply a value for it.
   *
   * It tracks the item *record*, not the item's stock: `inStock` and
   * `soldCount` are read live from Square on every request, and a sale at the
   * register moves neither this column nor any other. A client polling deltas
   * sees edits, not sales.
   */
  updatedAt: z.string().datetime(),
  /**
   * When this item was withdrawn, or null.
   *
   * Only ever set on an item returned to a caller passing `updatedSince`. A
   * plain list has no tombstones in it, so a screen never sees this as anything
   * but null; a client holding a local mirror deletes its copy on seeing it.
   *
   * Absence cannot be expressed by a cursor — `updatedSince` returns what
   * changed, and a removed row has nothing to carry — so this exists to make a
   * deletion something a delta can say.
   */
  deletedAt: z.string().datetime().nullable(),
});

export class CreateItemDto extends createZodDto(CreateItemSchema) {}
export class PatchItemDto extends createZodDto(PatchItemSchema) {}
export type ItemResponse = z.infer<typeof ItemResponseSchema>;

// ─── Public seller lookup ─────────────────────────────────────────────────────

export const PublicSellerItemSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  /** Null for a legacy ticket not yet priced (Plan 32). */
  priceCents: z.number().int().nullable(),
  originalQuantity: z.number().int(),
  inStock: z.number().int(),
  soldCount: z.number().int(),
});

// ─── Business seller invite (admin) ──────────────────────────────────────────

export const InviteBusinessSellerSchema = z
  .object({
    businessName: z.string().trim().min(1).max(100),
    /**
     * Optional: a shop whose inventory staff upload for them may never sign in,
     * and an address worth keeping — it is where the check goes — should not
     * cost them a mailbox they did not ask to hear from.
     */
    email: z.string().trim().toLowerCase().email().optional(),
    /**
     * Whether to actually write to that address. Off by default: adding a
     * seller and inviting one are two different acts, and only one of them
     * leaves the building.
     */
    sendInvite: z.boolean().optional().default(false),
  })
  .strict()
  .refine((v) => !v.sendInvite || !!v.email, {
    message: 'An email address is needed to send an invite.',
  });

/** Removal is soft: the profile row survives as a tombstone. */
export const UpdateBusinessSellerStatusSchema = z
  .object({ removed: z.boolean() })
  .strict();

export const BusinessSellerMemberResponseSchema = z.object({
  userId: z.string(),
  sellerId: z.string(),
  email: z.string().nullable(),
  businessName: z.string().nullable(),
  displayName: z.string(),
  phone: z.string().nullable(),
  joinedAt: z.string().datetime(),
  removedAt: z.string().datetime().nullable(),
});

export class InviteBusinessSellerDto extends createZodDto(InviteBusinessSellerSchema) {}
export class UpdateBusinessSellerStatusDto extends createZodDto(UpdateBusinessSellerStatusSchema) {}
export type BusinessSellerMemberResponse = z.infer<typeof BusinessSellerMemberResponseSchema>;

// ─── Seller self-service ──────────────────────────────────────────────────────

export const SellerSwapSummarySchema = z.object({ id: z.string(), title: z.string() });

export const SellerItemCreateSchema = z
  .object({
    swapId: z.string(),
    /**
     * The CATEGORY node, and the answers under it. The name is derived from
     * them (Plan 19 §5).
     *
     * Optional, unlike the staff path, because a seller on issued tickets can
     * still list an item the tree says nothing about — the description is on the
     * paper tag (Plan 17). Absent, the name falls back to "<seller> <number>" as
     * it always did, because `SwapItem.name` is non-null and Square requires
     * one.
     */
    categoryId: z.string().min(1).optional(),
    attributes: z.array(ItemAttributeInputSchema).max(24).default([]),
    description: z.string().max(2000).optional(),
    /**
     * Null or absent only for a legacy ticket, whose price comes after
     * check-in (Plan 32). The service refuses it for any other SKU: whether
     * an item is a ticket can depend on the number the server assigns.
     */
    priceCents: z.number().int().positive().nullable().optional(),
    quantity: z.number().int().positive(),
    donateProceeds: z.boolean().default(false),
    /**
     * Present when the item is being entered at a check-in station: it decides
     * where the tag prints and which counter mints the SKU. Absent for a
     * business seller entering items from their own desk.
     */
    stationId: z.string().optional(),
    /**
     * A ticket number, for a seller on issued tickets. Honoured only when they
     * hold a range covering it — an ordinary seller sending one is refused,
     * because their number would collide with the minted sequence.
     */
    sku: z.string().max(20).optional(),
    /**
     * A seller on issued tickets asking for a generated SKU instead, for an
     * item they will print a label for (Plan 31). Needed because an omitted
     * `sku` means "take my next ticket", which older clients rely on. Refused
     * with `sku`, and in a swap whose web takes legacy tickets only.
     */
    generateSku: z.boolean().optional(),
  })
  .strict();

/** Check-in endpoints all name the pair the station QR encodes. */
export const CheckinContextSchema = z
  .object({ swapId: z.string().min(1), stationId: z.string().min(1) })
  .strict();

/**
 * A contact and nothing else.
 *
 * No name: most sellers are already on the roster, and a name supplied here
 * would be discarded for them — `resolveOrCreate` fills gaps and never
 * overwrites. Asking before we know who this is would also reveal whether a
 * number is already known to the org, which the rest of the auth design goes to
 * some trouble to avoid. The name is settled after the contact is proven, and
 * only when there isn't one.
 */
export const CheckinRegisterSchema = z
  .object({
    email: z.string().trim().toLowerCase().email().optional(),
    phone: z.string().trim().min(7).max(32).optional(),
  })
  .strict()
  .refine((v) => Boolean(v.email) || Boolean(v.phone), {
    message: 'An email address or phone number is required',
  });

export const ReprintItemSchema = z.object({ stationId: z.string().min(1) }).strict();

export class ReprintItemDto extends createZodDto(ReprintItemSchema) {}
export class CheckinContextDto extends createZodDto(CheckinContextSchema) {}
export class CheckinRegisterDto extends createZodDto(CheckinRegisterSchema) {}

export const SellerItemUpdateSchema = z
  .object({
    categoryId: z.string().min(1).optional(),
    attributes: z.array(ItemAttributeInputSchema).max(24).optional(),
    description: z.string().max(2000).nullable().optional(),
    priceCents: z.number().int().positive().optional(),
    quantity: z.number().int().nonnegative().optional(),
    donateProceeds: z.boolean().optional(),
    hasPrintedTag: z.boolean().optional(),
  })
  .strict();

export class SellerItemCreateDto extends createZodDto(SellerItemCreateSchema) {}
export class SellerItemUpdateDto extends createZodDto(SellerItemUpdateSchema) {}
export type SellerSwapSummary = z.infer<typeof SellerSwapSummarySchema>;

// ─── Legacy ticket ranges ─────────────────────────────────────────────────────

/**
 * A block of pre-printed tickets issued to a business seller for one swap.
 *
 * `usedCount` is derived from the items rather than stored, so it counts the
 * numbers actually on goods — not how far down the pad the seller has worked.
 */
export const LegacyTicketRangeResponseSchema = z.object({
  id: z.string(),
  swapId: z.string(),
  sellerId: z.string(),
  startNumber: z.number().int(),
  endNumber: z.number().int(),
  ticketCount: z.number().int(),
  usedCount: z.number().int(),
});

export const AddTicketRangeSchema = z
  .object({
    swapId: z.string().min(1),
    startNumber: z.number().int().positive(),
    endNumber: z.number().int().positive(),
  })
  .strict();

/**
 * What the item form needs to open: the number to offer, and whether the seller
 * has anything left at all. Separate answers — past the top of their ranges
 * there is nothing to suggest, but a skipped ticket they have found is still
 * enterable.
 */
export const TicketFormStateSchema = z.object({
  ranges: z.array(z.object({ startNumber: z.number().int(), endNumber: z.number().int() })),
  suggested: z.number().int().nullable(),
  exhausted: z.boolean(),
  /**
   * The swap's web takes legacy tickets only (Plan 31): every item this seller
   * enters must be a ticket, and nothing may get a generated SKU.
   */
  webTicketsOnly: z.boolean(),
});

/**
 * A seller staff can upload a file for: one holding tickets in this swap, and
 * when its web isn't tickets-only, any business seller, with no ranges (Plan
 * 31). A shop without ranges can only import rows that get generated SKUs.
 */
export const TicketSellerSchema = z.object({
  sellerId: z.string(),
  displayName: z.string(),
  ranges: z.array(z.object({ startNumber: z.number().int(), endNumber: z.number().int() })),
  ticketCount: z.number().int(),
  usedCount: z.number().int(),
});

export class AddTicketRangeDto extends createZodDto(AddTicketRangeSchema) {}
export type TicketSeller = z.infer<typeof TicketSellerSchema>;
export type LegacyTicketRangeResponse = z.infer<typeof LegacyTicketRangeResponseSchema>;
export type TicketFormState = z.infer<typeof TicketFormStateSchema>;

// ─── Printers ─────────────────────────────────────────────────────────────────

/**
 * Re-exported from the renderer's geometry rather than declared again.
 *
 * These lists used to be written out in three files and hand-typed as inline
 * unions in five more, so adding a size meant finding eight places with no help
 * from the compiler. There is one source now, and it is the one the renderer
 * actually draws from.
 */
export { PAPER_SIZES, PRINTER_MODELS } from '../ski-swap/printing/geometry';
export type { PaperSize, PrinterModelId } from '../ski-swap/printing/geometry';

import { PAPER_SIZES as SIZES, PRINTER_MODELS as MODELS } from '../ski-swap/printing/geometry';

export const CreatePrinterSchema = z
  .object({
    name: z.string().min(1).max(100),
    bluetoothName: z.string().min(1).max(100),
    model: z.enum(MODELS),
    paperSize: z.enum(SIZES),
  })
  .strict();

const MarginFields = {
  marginTop:    z.number().int().min(0).max(160),
  marginBottom: z.number().int().min(0).max(160),
  marginLeft:   z.number().int().min(0).max(160),
  marginRight:  z.number().int().min(0).max(160),
};

export const PatchPrinterSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    bluetoothName: z.string().min(1).max(100).optional(),
    assignedSellerId: z.string().nullable().optional(),
    /** The bridge that drives this printer. Mutually exclusive with a seller. */
    bridgeDeviceId: z.string().nullable().optional(),
    model: z.enum(MODELS).optional(),
    paperSize: z.enum(SIZES).optional(),
    ...Object.fromEntries(Object.entries(MarginFields).map(([k, v]) => [k, v.optional()])),
  })
  .strict()
  .refine((v) => Object.values(v).some((x) => x !== undefined), {
    message: 'At least one field must be provided',
  });

export const PatchPrinterPaperSizeSchema = z
  .object({ paperSize: z.enum(SIZES) })
  .strict();

export const SwapPrinterResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  bluetoothName: z.string(),
  model: z.enum(MODELS),
  paperSize: z.enum(SIZES),
  marginTop:    z.number().int(),
  marginBottom: z.number().int(),
  marginLeft:   z.number().int(),
  marginRight:  z.number().int(),
  assignedSellerId: z.string().nullable(),
  assignedSellerName: z.string().nullable(),
  /** The bridge that drives this printer, and the station that bridge serves. */
  bridgeDeviceId: z.string().nullable(),
  /**
   * No bridge name here: a bridge is called after the printer it drives, so on
   * a printer's own record that would only ever echo the row it sits on.
   * Whether one is attached is `bridgeDeviceId`; where it serves is below.
   */
  stationName: z.string().nullable(),
  /** Every station the driving bridge serves, one name each (Plan 27). */
  stationNames: z.array(z.string()),
});

export class CreatePrinterDto extends createZodDto(CreatePrinterSchema) {}
export class PatchPrinterDto extends createZodDto(PatchPrinterSchema) {}
export class PatchPrinterPaperSizeDto extends createZodDto(PatchPrinterPaperSizeSchema) {}
export type SwapPrinterResponse = z.infer<typeof SwapPrinterResponseSchema>;

// ─── Scanners ─────────────────────────────────────────────────────────────────

export const CreateScannerSchema = z
  .object({
    name: z.string().min(1).max(100),
    bluetoothName: z.string().min(1).max(100),
  })
  .strict();

export const PatchScannerSchema = z
  .object({
    name: z.string().min(1).max(100).optional(),
    bluetoothName: z.string().min(1).max(100).optional(),
    /** Null releases the scanner from whichever bridge holds it. */
    bridgeDeviceId: z.string().nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field must be provided' });

export const SwapScannerResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  bluetoothName: z.string(),
  /** The bridge that drives this scanner, and the station that bridge serves. */
  bridgeDeviceId: z.string().nullable(),
  stationName: z.string().nullable(),
  /** Every station the driving bridge serves, one name each (Plan 27). */
  stationNames: z.array(z.string()),
});

export class CreateScannerDto extends createZodDto(CreateScannerSchema) {}
export class PatchScannerDto extends createZodDto(PatchScannerSchema) {}
export type SwapScannerResponse = z.infer<typeof SwapScannerResponseSchema>;

// ─── Ski Swap Settings ────────────────────────────────────────────────────────

/**
 * Sent to a PATCH, not a PUT: the settings row carries more than this — a
 * device PIN, and whatever comes next — so a body naming one field is a change
 * to apply, not a replacement for the whole resource.
 */
export const UpdateSkiSwapSettingsSchema = z
  .object({
    /**
     * Whether a self check-in item waits for a staff member to scan it before
     * it can be sold. Decides what happens to items checked in from now on;
     * anything already on the floor is untouched.
     */
    requireConsignmentScan: z.boolean().optional(),
    /**
     * The org's cut, as a percentage — "20", "20.5", "20.5%".
     *
     * A percentage because that is what a patrol calls it (Plan 25 §3). Two
     * decimal places, and the regex refuses the rest rather than quietly
     * rounding a number and then showing somebody a different one back.
     */
    commissionPercent: z
      .union([z.string().regex(/^\d{1,3}(\.\d{1,2})?%?$/), z.number().min(0).max(100)])
      .optional(),
  })
  .strict();

export const SkiSwapSettingsResponseSchema = z.object({
  /**
   * Deprecated: labels per item is a swap's setting now (`SwapResponse`).
   * Still sent, as the org's running swap's value, for iPads that read it
   * from here; no longer written through here.
   */
  labelsPerItem: z.number().int(),
  requireConsignmentScan: z.boolean(),
  /** "20%", "20.5%". The form this is edited and displayed in, everywhere. */
  commissionPercent: z.string(),
  /**
   * The same number the arithmetic uses. Sent so a screen showing a
   * calculation can do it the same way the server did rather than parsing the
   * percentage back out of a string.
   */
  commissionBasisPoints: z.number().int(),
  /**
   * The version of this org's item-description tree, so a client can tell
   * whether its cached copy is stale without downloading one to find out.
   *
   * It rides here because this response is already fetched every inbound sync —
   * the version arrives for free, one integer is compared, and the tree is
   * refetched only when it differs. Its other home is the first field of the
   * tree itself, which is no use for deciding whether to ask for the tree.
   */
  taxonomyVersion: z.number().int(),
  /**
   * Whether texting is on, platform-wide (Plan 29). Rides here for the same
   * reason as `taxonomyVersion`: the iPad already fetches this every sync.
   * While false, every SMS feature is hidden and the server refuses them.
   */
  smsEnabled: z.boolean(),
});

export class UpdateSkiSwapSettingsDto extends createZodDto(UpdateSkiSwapSettingsSchema) {}
export type SkiSwapSettingsResponse = z.infer<typeof SkiSwapSettingsResponseSchema>;

// ─── Public seller detail (by ID) ────────────────────────────────────────────

export const PublicSellerDetailItemSchema = z.object({
  itemId: z.string(),
  name: z.string(),
  sku: z.string(),
  /** Null for a legacy ticket not yet priced (Plan 32). */
  priceCents: z.number().int().nullable(),
  originalQuantity: z.number().int(),
  inStock: z.number().int(),
  soldCount: z.number().int(),
  /**
   * Whether `inStock` and `soldCount` are Square's answer. False when Square
   * could not be read; the numbers then say "unsold" as a placeholder, and
   * the page says it could not check rather than showing either word.
   */
  inventoryKnown: z.boolean(),
  donateProceeds: z.boolean(),
  /**
   * False while the item is still waiting for a staff member to accept it, so
   * a seller who checks later can see which of their things were taken.
   */
  consigned: z.boolean(),
});

export const PublicSellerDetailSwapSchema = z.object({
  swapId: z.string(),
  swapTitle: z.string(),
  items: z.array(PublicSellerDetailItemSchema),
});

/**
 * What the seller is owed, and what became of it (Plan 25 §8).
 *
 * This page is reachable by seller id alone, so the destination is masked. A
 * seller needs to recognise their own address to answer "is that the right
 * one?"; nobody holding the link needs to be handed it.
 */
export const PublicSellerPayoutSchema = z.object({
  swapTitle: z.string(),
  status: z.enum(PAYOUT_LINE_STATUSES),
  grossCents: z.number().int(),
  commissionCents: z.number().int(),
  netCents: z.number().int(),
  /** "20%" — what the arithmetic above took. */
  commissionPercent: z.string(),
  method: z.enum(['PAYPAL', 'VENMO', 'CHECK', 'DONATE']),
  /** Masked: "d••••@example.com", "(•••) •••-1212". Null for a check. */
  destination: z.string().nullable(),
  sentAt: z.string().datetime().nullable(),
  checkSentAt: z.string().datetime().nullable(),
  /** The one state where the seller is the person who can do something. */
  needsAction: z.boolean(),
});

export const PublicSellerDetailResponseSchema = z.object({
  /**
   * False when none of this seller's swaps has Unauthenticated Seller Status
   * on (Plan 33). Nothing about them is sent then: no name, items or payouts.
   */
  available: z.boolean(),
  sellerName: z.string().nullable(),
  orgName: z.string(),
  orgLogoUrl: z.string().nullable(),
  /**
   * How this seller chose to be paid, so the page can say roughly when.
   *
   * The method and not the destination. "Check" tells somebody they are
   * waiting on the post; the address it goes to is nobody else's business,
   * and this page needs no sign-in.
   *
   * Null for a seller who has not been asked yet — nothing is promised then.
   */
  payoutMethod: z.enum(['PAYPAL', 'VENMO', 'CHECK', 'DONATE']).nullable(),
  swaps: z.array(PublicSellerDetailSwapSchema),
  /** Newest first. Empty until a payout run has been built. */
  payouts: z.array(PublicSellerPayoutSchema),
});

export type PublicSellerPayout = z.infer<typeof PublicSellerPayoutSchema>;
export type PublicSellerDetailItem = z.infer<typeof PublicSellerDetailItemSchema>;
export type PublicSellerDetailSwap = z.infer<typeof PublicSellerDetailSwapSchema>;
export type PublicSellerDetailResponse = z.infer<typeof PublicSellerDetailResponseSchema>;

// ─── Public seller find (email + last4) ──────────────────────────────────────

export const SellerFindResponseSchema = z.object({ sellerId: z.string() });
export type SellerFindResponse = z.infer<typeof SellerFindResponseSchema>;


// ─── Check-in stations ───────────────────────────────────────────────────────

export const CreateStationSchema = z.object({ name: z.string().min(1).max(60) }).strict();

export const UpdateStationSchema = z
  .object({
    name: z.string().min(1).max(60).optional(),
    attendantDeviceId: z.string().nullable().optional(),
    bridgeDeviceId: z.string().nullable().optional(),
  })
  .strict();

export const StationResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  code: z.string(),
  /**
   * Derived from whether a staff tablet is bound, never stored — a flag could
   * disagree with the hardware actually attached.
   */
  kind: z.enum(['staffed', 'self_service']),
  attendantDeviceId: z.string().nullable(),
  attendantName: z.string().nullable(),
  attendantLastSeenAt: z.string().nullable(),
  bridgeDeviceId: z.string().nullable(),
  /**
   * A bridge has no name of its own — it is one printer's network adapter and
   * is called after that printer. Null while it drives nothing.
   */
  bridgeName: z.string().nullable(),
  bridgeLastSeenAt: z.string().nullable(),
  /**
   * Reached through the bridge, never bound here: a bridge holds its printer's
   * Bluetooth link continuously, so the bridge is what decides which printer a
   * station prints to.
   */
  printerId: z.string().nullable(),
  printerName: z.string().nullable(),
  /**
   * The other stations printing through this station's bridge (Plan 27). Empty
   * when the bridge is this station's alone, or there is none.
   */
  bridgeSharedWith: z.array(z.string()),
  /**
   * The bridge's printer holds 25 × 67, so it prints legacy helper labels and
   * nothing else (Plan 28).
   */
  helperLabelsOnly: z.boolean(),
  createdAt: z.string(),
});

export class CreateStationDto extends createZodDto(CreateStationSchema) {}
export class UpdateStationDto extends createZodDto(UpdateStationSchema) {}
export type StationResponse = z.infer<typeof StationResponseSchema>;

export const StationQueueResponseSchema = z.object({
  stationId: z.string(),
  queued: z.number().int(),
  claimed: z.number().int(),
  /** A recipe that no longer resolves — the item was deleted mid-print. */
  failed: z.number().int(),
  /** Retried to the cap and given up on, or a helper pair not printed within its minute. */
  abandoned: z.number().int(),
  /** Why the most recent of those was given up on. Null when there are none. */
  lastAbandonedReason: z.string().nullable(),
  /** The bridge's last word on its printer link: ready | down, or null. */
  printerLink: z.enum(['ready', 'down']).nullable(),
  printerLinkAt: z.string().nullable(),
  oldestQueuedAt: z.string().nullable(),
  /** The bridge, when one is bound. Null for a staffed station without one. */
  bridgeLastSeenAt: z.string().nullable(),
  /** The staff tablet, when one is bound. What to watch when there is no bridge. */
  attendantLastSeenAt: z.string().nullable(),
  /** The app the tablet last reported running: "1.4.0" and its build. Null until it has said. */
  attendantAppVersion: z.string().nullable(),
  attendantAppBuild: z.string().nullable(),
  /** The other stations printing through this station's bridge (Plan 27). */
  bridgeSharedWith: z.array(z.string()),
});

export type StationQueueResponse = z.infer<typeof StationQueueResponseSchema>;

// ─── Print queue (device-facing) ─────────────────────────────────────────────

export const NackJobSchema = z.object({ error: z.string().max(500).optional() }).strict();

/**
 * What a bridge tells us about itself when it asks for work.
 *
 * On the claim rather than a separate heartbeat, so it costs no extra request
 * on venue wifi. A bridge whose printer is down still claims — with `limit=0`
 * if it has nowhere to put a job — because otherwise a dead printer and a dead
 * bridge look identical from here, and those need different people to fix them.
 */
export const ClaimJobsSchema = z
  .object({
    printerLink: z.enum(['ready', 'down']).optional(),
    /**
     * The same, for a scanner. Omitted entirely when no scanner is assigned —
     * and omitting it leaves the last report standing rather than clearing it,
     * the same rule `printerLink` already follows.
     */
    scannerLink: z.enum(['ready', 'down']).optional(),
    /** Percent. Read on connect, so it is "last known" rather than current. */
    scannerBattery: z.number().int().min(0).max(100).optional(),
    /** Scans taken but not yet accepted here. */
    scanQueueDepth: z.number().int().min(0).optional(),
  })
  .strict();

export class ClaimJobsDto extends createZodDto(ClaimJobsSchema) {}

export const ClaimedJobSchema = z.object({
  id: z.string(),
  kind: z.string(),
  seq: z.number().int(),
  /**
   * The base64 raster. The bridge wraps it in ESC/POS and adds its own feed.
   * Absent when the claim asked for `payload=omit`.
   */
  payload: z.string().optional(),
  /**
   * The raster's length in bytes, and exactly what `GET :jobId/raster` returns.
   * Sent on every claim.
   */
  rasterBytes: z.number().int().nonnegative(),
  /**
   * Bytes per raster row — how the bridge knows the label's width, and with the
   * payload's length, its height.
   *
   * Firmware that predates this field reads 50, which is right for every M110.
   * It refuses a payload that is not a whole number of `widthBytes` rows, so
   * this and the bytes beside it have to agree; both come off the same raster.
   */
  widthBytes: z.number().int().positive(),
});

/** A peripheral this bridge should be holding, by the name it advertises. */
export const ClaimPeripheralSchema = z.object({ bluetoothName: z.string() });

export const ClaimResponseSchema = z.object({
  /**
   * The first of `stationIds` by name. The firmware only shows it; nothing
   * about how a bridge behaves depends on it.
   */
  stationId: z.string(),
  /** Every station this bridge prints for — several when staffed counters share it (Plan 27). */
  stationIds: z.array(z.string()),
  backoffMs: z.number().int(),
  jobs: z.array(ClaimedJobSchema),
  /**
   * What this bridge should be connected to, sent on every claim so that
   * changing an assignment no longer means walking to the board and
   * re-provisioning it over BLE.
   *
   * `null` means "nothing is assigned, drop what you are holding". *Absent*
   * means a server that does not send assignments at all — which this one now
   * always does, so a field here is never missing. The distinction matters to
   * an older board talking to us, not to us.
   */
  printer: ClaimPeripheralSchema.nullable(),
  scanner: ClaimPeripheralSchema.nullable(),
});

/**
 * A barcode a bridge read off a tag.
 *
 * No symbology: both QR forms this system prints are URLs by construction, and
 * neither item form can be one, so the payload separates them on its own. The
 * firmware strips the scanner's code id before sending.
 */
export const SubmitScanSchema = z.object({ sku: z.string().min(1).max(64) }).strict();

export class SubmitScanDto extends createZodDto(SubmitScanSchema) {}

export class NackJobDto extends createZodDto(NackJobSchema) {}
export type ClaimedJob = z.infer<typeof ClaimedJobSchema>;
export type ClaimResponse = z.infer<typeof ClaimResponseSchema>;

// ─── Browser-driven label rendering ──────────────────────────────────────────

export const RenderLabelSchema = z
  .object({
    kind: z.enum(['item', 'receipt_header', 'receipt_items', 'qr', 'printer_label', 'calibration']),
    /** `escpos` for a Bluetooth write, `png` for on-screen preview. */
    format: z.enum(['escpos', 'png']).default('escpos'),
    itemId: z.string().optional(),
    sellerId: z.string().optional(),
    swapId: z.string().optional(),
  })
  .strict();

export const RenderLabelResponseSchema = z.object({
  format: z.enum(['escpos', 'png']),
  /** One entry per label; a receipt's item list paginates across several. */
  pages: z.array(z.string()),
});

export class RenderLabelDto extends createZodDto(RenderLabelSchema) {}
export type RenderLabelResponse = z.infer<typeof RenderLabelResponseSchema>;

// ─── Printing what the iPad drew (iOS Plan 26) ───────────────────────────────

export const STATION_PRINT_KINDS = ['item_tag', 'receipt', 'seller_qr', 'helper_labels'] as const;
export type StationPrintKind = (typeof STATION_PRINT_KINDS)[number];

/** A long receipt is a handful of pages; this is room for one and then some. */
export const STATION_PRINT_MAX_PAGES = 20;
export const STATION_PRINT_MAX_COPIES = 5;

export const StationPrintRequestSchema = z
  .object({
    kind: z.enum(STATION_PRINT_KINDS),
    swapId: z.string().min(1),
    /** For the record only; it may not have synced yet. */
    itemId: z.string().nullish(),
    sellerId: z.string().nullish(),
    copies: z.number().int().min(1).max(STATION_PRINT_MAX_COPIES).default(1),
    /** What the iPad drew for. Checked against the bridge's printer as it is now. */
    model: z.string().min(1).max(20),
    paperSize: z.string().min(1).max(20),
    widthDots: z.number().int().positive().max(2048).refine((n) => n % 8 === 0, 'widthDots must be a whole number of bytes'),
    heightDots: z.number().int().positive().max(4096),
    /** Optional: when sent, a raster drawn for other margins is refused too. */
    margins: z
      .object({ top: z.number().int(), bottom: z.number().int(), left: z.number().int(), right: z.number().int() })
      .strict()
      .optional(),
    /** One per label, in print order, in `packRaster`'s format, base64. */
    pages: z.array(z.string().min(1).max(200_000)).min(1).max(STATION_PRINT_MAX_PAGES),
  })
  .strict();

export class StationPrintRequestDto extends createZodDto(StationPrintRequestSchema) {}
export type StationPrintRequest = z.infer<typeof StationPrintRequestSchema>;
