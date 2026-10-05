import { ConflictException, Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { payoutGaps } from '../contracts/payout-gaps';
import { PrismaService } from '../prisma/prisma.service';
import { isUniqueViolation } from '../common/util/prisma-errors';
import { IdempotencyService } from '../common/services/idempotency.service';
import { PersonService } from '../common/identity/person.service';
import { MembershipTouchService } from '../common/identity/membership-touch.service';
import { displayName, normalizeNamePart, normalizePhone, splitName } from '../common/util/person';
import { createId } from '@paralleldrive/cuid2';
import { parse as parseCsv } from 'csv-parse/sync';
import { SmsService } from '../sms/sms.service';
import type { PersonSearchResult, SellerResponse } from '../contracts/ski-swap.contracts';
import { unverifyChangedContacts } from '../common/identity/contact-verification';

// ─── Address normalisation ────────────────────────────────────────────────────

const STATE_MAP: Record<string, string> = {
  'alabama':'AL','alaska':'AK','arizona':'AZ','arkansas':'AR','california':'CA',
  'colorado':'CO','connecticut':'CT','delaware':'DE','florida':'FL','georgia':'GA',
  'hawaii':'HI','idaho':'ID','illinois':'IL','indiana':'IN','iowa':'IA',
  'kansas':'KS','kentucky':'KY','louisiana':'LA','maine':'ME','maryland':'MD',
  'massachusetts':'MA','michigan':'MI','minnesota':'MN','mississippi':'MS',
  'missouri':'MO','montana':'MT','nebraska':'NE','nevada':'NV','new hampshire':'NH',
  'new jersey':'NJ','new mexico':'NM','new york':'NY','north carolina':'NC',
  'north dakota':'ND','ohio':'OH','oklahoma':'OK','oregon':'OR','pennsylvania':'PA',
  'rhode island':'RI','south carolina':'SC','south dakota':'SD','tennessee':'TN',
  'texas':'TX','utah':'UT','vermont':'VT','virginia':'VA','washington':'WA',
  'west virginia':'WV','wisconsin':'WI','wyoming':'WY',
  'district of columbia':'DC','washington dc':'DC','washington d.c.':'DC',
};

function normalizeState(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return '';
  if (trimmed.length === 2) return trimmed.toUpperCase();
  return STATE_MAP[trimmed.toLowerCase()] ?? trimmed.toUpperCase().slice(0, 2);
}

function normalizeZip(s: string): string {
  return s.replace(/\D/g, '').slice(0, 5);
}

function toTitleCase(s: string): string {
  return s.trim().replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeSellerRow(raw: {
  name?: string; phone?: string; email?: string;
  street?: string; city?: string; state?: string; zip?: string;
}): { name: string; phone: string; email: string; street: string; city: string; state: string; zip: string; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];

  const name  = toTitleCase(raw.name ?? '');
  const phone = normalizePhone(raw.phone ?? '') ?? '';
  const email = (raw.email ?? '').trim().toLowerCase();
  const zip   = normalizeZip(raw.zip ?? '');
  const rawState = (raw.state ?? '').trim();
  const state = normalizeState(rawState);

  if (!name) errors.push('name is required');
  // A person needs at least one way to be reached; neither alone is mandatory.
  if (!phone && !email) errors.push('an email or phone number is required');
  if (raw.phone?.trim() && !phone) errors.push(`"${raw.phone.trim()}" is not a valid phone number`);
  if (email && !EMAIL_RE.test(email)) errors.push(`"${email}" is not a valid email address`);

  if (zip && zip.length !== 5) warnings.push(`ZIP "${raw.zip?.trim()}" is not 5 digits; stored as-is`);
  if (rawState && rawState.length > 2 && !STATE_MAP[rawState.toLowerCase()]) warnings.push(`State "${rawState}" not recognised; stored as "${state}"`);

  return { name, phone, email, street: toTitleCase(raw.street ?? ''), city: toTitleCase(raw.city ?? ''), state, zip, errors, warnings };
}

// ─── Query shape ──────────────────────────────────────────────────────────────

const SELLER_INCLUDE = {
  membership: { include: { user: true, org: { select: { id: true } } } },
} as const;

type SellerRow = {
  id: string;
  businessName: string | null;
  createdAt: Date;
  deletedAt: Date | null;
  membership: {
    orgId: string;
    userId: string;
    /**
     * The watermark, not `SellerProfile.updatedAt`. A seller row is assembled
     * from three tables and almost nothing a client reads lives on the profile:
     * a rename, a corrected phone number or a new payout all write `User` and
     * bump the membership, leaving the profile's own timestamp untouched.
     */
    updatedAt: Date;
    deletedAt: Date | null;
    user: {
      firstName: string | null; lastName: string | null;
      email: string | null; phone: string | null;
      street: string | null; city: string | null; state: string | null; zip: string | null;
      emailVerifiedAt: Date | null; phoneVerifiedAt: Date | null;
      verifiedEmail: string | null; verifiedPhone: string | null;
      payoutMethod: string | null; payoutTarget: string | null; payoutHandle: string | null;
      payoutHandleScannedAt: Date | null;
    };
  };
};

/**
 * `smsOn` is the platform switch (Plan 29): while texting is off a receipt is
 * never offered by text, even to a phone verified before.
 */
export function toSellerResponse(
  s: SellerRow,
  smsOn: boolean,
  receiptSwaps: ReceiptSwap[] = [],
): SellerResponse {
  const u = s.membership.user;
  // Either row can carry the tombstone: a seller can be removed from the swap,
  // or leave the org entirely. Whichever happened, the client needs to know.
  const deletedAt = s.deletedAt ?? s.membership.deletedAt;
  return {
    id: s.id,
    orgId: s.membership.orgId,
    userId: s.membership.userId,
    businessName: s.businessName,
    firstName: u.firstName,
    lastName: u.lastName,
    displayName: displayName(u, s.businessName),
    phone: u.phone,
    email: u.email,
    street: u.street,
    city: u.city,
    state: u.state,
    zip: u.zip,
    payoutMethod: u.payoutMethod as SellerResponse['payoutMethod'],
    payoutTarget: u.payoutTarget as SellerResponse['payoutTarget'],
    payoutHandle: u.payoutHandle,
    // Whether a Venmo account was read from the seller's code (Plan 35), so
    // every iPad can flag one that wasn't, and the payout run won't pay it.
    payoutHandleScanned: u.payoutHandleScannedAt !== null,
    emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null,
    phoneVerifiedAt: u.phoneVerifiedAt?.toISOString() ?? null,
    // The same precedence the send uses, from the same columns. A claim in
    // `email` is not somewhere a receipt may go.
    receiptChannel: u.verifiedEmail ? 'EMAIL' : u.verifiedPhone && smsOn ? 'SMS' : null,
    receiptSwaps,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.membership.updatedAt.toISOString(),
    deletedAt: deletedAt?.toISOString() ?? null,
  };
}


/** A swap a seller's receipt can be made for. */
type ReceiptSwap = { id: string; title: string; printPaperSize: string | null };

@Injectable()
export class SellerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly people: PersonService,
    private readonly touch: MembershipTouchService,
    private readonly sms: SmsService,
  ) {}

  /** A seller as the API answers with it, under the current texting switch. */
  private async respond(row: SellerRow): Promise<SellerResponse> {
    const [smsOn, receiptSwaps] = await Promise.all([this.sms.enabled(), this.receiptSwapsFor([row.id])]);
    return toSellerResponse(row, smsOn, receiptSwaps.get(row.id) ?? []);
  }

  /**
   * For each seller, the active swaps they have live items in, newest swap
   * first: the swaps a receipt can be printed for. One query, whatever the
   * number of sellers.
   */
  private async receiptSwapsFor(sellerIds: string[]): Promise<Map<string, ReceiptSwap[]>> {
    const bySeller = new Map<string, ReceiptSwap[]>();
    if (sellerIds.length === 0) return bySeller;
    const pairs = await this.prisma.swapItem.findMany({
      // Only swaps that give receipts (Plan 36 D4).
      where: { sellerId: { in: sellerIds }, deletedAt: null, swap: { active: true, receiptMode: { not: 'NONE' } } },
      distinct: ['sellerId', 'swapId'],
      select: {
        sellerId: true,
        swap: { select: { id: true, title: true, createdAt: true, receiptPrintEnabled: true, receiptPaperSize: true } },
      },
    });
    pairs.sort((a, b) => b.swap.createdAt.getTime() - a.swap.createdAt.getTime());
    for (const { sellerId, swap } of pairs) {
      if (!sellerId) continue;
      const list = bySeller.get(sellerId) ?? [];
      list.push({
        id: swap.id,
        title: swap.title,
        // The paper its receipts print on, or null when they don't print (Plan 36).
        printPaperSize: swap.receiptPrintEnabled ? swap.receiptPaperSize : null,
      });
      bySeller.set(sellerId, list);
    }
    return bySeller;
  }

  /**
   * Whether a seller could actually be reached and paid: an address, and a
   * payout the run can send (Plan 35). The rule is `payoutGaps`, shared with
   * the web, which says per seller what to fix.
   *
   * A gap here is invisible until someone tries to act on it — a cheque with
   * nowhere to go, an unsold item nobody can return — so it is worth being able
   * to ask for the incomplete ones before a swap closes rather than after.
   */
  static isIncomplete(s: SellerResponse): boolean {
    return payoutGaps(s).length > 0;
  }

  async list(
    orgId: string,
    query?: string,
    updatedSince?: string,
    incompleteOnly?: boolean,
  ): Promise<{ sellers: SellerResponse[]; syncedAt: string }> {
    // Tombstones appear only in a delta. A client asking "what changed since"
    // has a local mirror and needs to be told about a removal; a caller with no
    // cursor is a screen, and a removed seller has no business on it.
    //
    // The roster includes them unconditionally and leaves the filtering to its
    // callers. That is not worth copying: this endpoint backs the staff Sellers
    // page directly.
    /*
     * Read before the query, not after (iOS Plan 17 D).
     *
     * This is what a client sets its next `updatedSince` to. Taken after the
     * read, a row committed while the query ran would sit between this answer
     * and the next one's filter — missing from both, and gone until somebody
     * edits it again. Sellers have no periodic full pass to catch that, so it
     * would simply be lost. Taken before, the row comes back twice instead,
     * and an upsert does not mind.
     */
    const syncedAt = new Date();

    const live = updatedSince ? {} : { deletedAt: null };
    const liveMembership = updatedSince ? {} : { deletedAt: null };

    const sellers = await this.prisma.sellerProfile.findMany({
      where: {
        ...live,
        membership: {
          orgId,
          ...liveMembership,
          // The watermark is the membership's — see SellerRow.
          ...(updatedSince ? { updatedAt: { gt: new Date(updatedSince) } } : {}),
          ...(query
            ? {
                user: {
                  OR: [
                    { firstName: { contains: query } },
                    { lastName: { contains: query } },
                    // Only when the query has digits in it. Stripped of
                    // letters, "Smith" is the empty string, and `contains: ''`
                    // matches every phone on the roster.
                    ...(query.replace(/\D/g, '')
                      ? [{ phone: { contains: query.replace(/\D/g, '') } }]
                      : []),
                    { email: { contains: query } },
                  ],
                },
              }
            : {}),
        },
      },
      include: SELLER_INCLUDE,
      orderBy: [{ membership: { user: { lastName: 'asc' } } }, { createdAt: 'asc' }],
    });
    // Business-name matches cannot be expressed in the same OR as user fields.
    const byBusiness = query
      ? await this.prisma.sellerProfile.findMany({
          where: {
            ...live,
            businessName: { contains: query },
            membership: {
              orgId,
              ...liveMembership,
              ...(updatedSince ? { updatedAt: { gt: new Date(updatedSince) } } : {}),
            },
          },
          include: SELLER_INCLUDE,
        })
      : [];

    const merged = new Map(
      [...sellers, ...byBusiness].map((s) => [s.id, s] as const),
    );
    const [smsOn, receiptSwaps] = await Promise.all([
      this.sms.enabled(),
      this.receiptSwapsFor([...merged.keys()]),
    ]);
    const all = [...merged.values()].map((row) => toSellerResponse(row, smsOn, receiptSwaps.get(row.id) ?? []));
    // Filtered after mapping rather than in SQL: the rule spans four address
    // columns and two payout ones, and is stated once here so the list and the
    // dashboard count cannot drift apart.
    return {
      sellers: incompleteOnly
        ? all.filter((x) => !x.deletedAt && SellerService.isIncomplete(x))
        : all,
      syncedAt: syncedAt.toISOString(),
    };
  }

  async get(orgId: string, sellerId: string): Promise<SellerResponse> {
    return this.respond(await this.findOrThrow(orgId, sellerId));
  }

  /**
   * Name-only cross-org lookup. Disclosing anything more before staff confirm
   * identity with the person in front of them would leak another org's data.
   */
  async searchPeople(
    orgId: string,
    input: { email?: string; phone?: string },
  ): Promise<PersonSearchResult[]> {
    const user = await this.people.resolve(input);
    if (!user) return [];

    const membership = await this.prisma.membership.findUnique({
      where: { userId_orgId: { userId: user.id, orgId } },
      include: { sellerProfile: true },
    });

    return [
      {
        userId: user.id,
        displayName: displayName(user),
        alreadyHere: Boolean(
          membership && !membership.deletedAt && membership.sellerProfile && !membership.sellerProfile.deletedAt,
        ),
      },
    ];
  }

  /** Grants the seller role to an already-identified person (post-confirmation). */
  async addFromPerson(orgId: string, userId: string): Promise<SellerResponse> {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Person not found');

    const membership = await this.people.upsertMembership(userId, orgId);
    const profile = await this.upsertSellerProfile(membership.id, null);
    return this.respond(await this.findByIdOrThrow(profile.id));
  }

  async create(
    orgId: string,
    data: {
      id?: string;
      firstName?: string | null; lastName?: string | null;
      phone?: string | null; email?: string | null;
      businessName?: string | null;
      street?: string | null; city?: string | null; state?: string | null; zip?: string | null;
      payoutMethod?: string | null; payoutTarget?: string | null; payoutHandle?: string | null;
      payoutHandleSource?: 'SCAN';
    },
    idempotencyKey?: string,
  ): Promise<SellerResponse> {
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(`seller-create:${orgId}`, idempotencyKey);
      if (cached) return cached as unknown as SellerResponse;
    }

    /*
     * A create under an id this org already has is that same create arriving
     * twice — the offline queue retrying after a lost response. For creates the
     * id is the idempotency key, so this answers before anything is written.
     */
    if (data.id) {
      const already = await this.assertIdUsable(orgId, data.id);
      if (already) return already;
    }

    const { user } = await this.people.resolveOrCreate({
      email: data.email,
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
    });

    await this.writeUserFields(user.id, data);
    const membership = await this.people.upsertMembership(user.id, orgId);
    const profile = await this.upsertSellerProfile(
      membership.id,
      data.businessName ?? null,
      data.id,
    );

    const response = await this.respond(await this.findByIdOrThrow(profile.id));

    if (idempotencyKey) {
      await this.idempotency.save(
        `seller-create:${orgId}`,
        idempotencyKey,
        response as unknown as Record<string, unknown>,
      );
    }
    return response;
  }

  async patch(
    orgId: string,
    sellerId: string,
    data: {
      firstName?: string | null; lastName?: string | null;
      phone?: string | null; email?: string | null;
      businessName?: string | null;
      street?: string | null; city?: string | null; state?: string | null; zip?: string | null;
      payoutMethod?: string | null; payoutTarget?: string | null; payoutHandle?: string | null;
      payoutHandleSource?: 'SCAN';
      baseUpdatedAt?: string;
    },
    idempotencyKey?: string,
  ): Promise<SellerResponse> {
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(`seller-patch:${orgId}`, idempotencyKey);
      if (cached) return cached as unknown as SellerResponse;
    }

    const existing = await this.findOrThrow(orgId, sellerId);

    /*
     * Refused if somebody else has written since this client last looked
     * (iOS Plan 17 C).
     *
     * The scenario is two people editing one seller during a swap: an iPad at
     * the counter correcting a phone while it is offline, an administrator
     * fixing the address on the web. A whole-record patch put the old address
     * back when the iPad came online, and told nobody.
     *
     * The comparison is `>`, not `>=`: a client that sends back the exact
     * watermark it was given has seen everything, and two writes inside the
     * same millisecond are the one case this cannot separate either way.
     *
     * The current seller rides along on the refusal so the client can show
     * both versions and ask, rather than making somebody go and look.
     */
    if (data.baseUpdatedAt) {
      const seen = new Date(data.baseUpdatedAt);
      if (existing.membership.updatedAt > seen) {
        throw new ConflictException({
          message: 'This seller was changed by somebody else while you were editing.',
          code: 'SELLER_MODIFIED',
          // Under `details` because that is what the error envelope carries;
          // `message` and `code` are the only other fields it keeps.
          details: { seller: await this.respond(await this.findByIdOrThrow(sellerId)) },
        });
      }
    }

    await this.writeUserFields(existing.membership.userId, data, { overwrite: true });

    if (data.businessName !== undefined) {
      await this.prisma.sellerProfile.update({
        where: { id: sellerId },
        data: { businessName: data.businessName },
      });
    }
    await this.touch.touch(existing.membership.id);

    const response = await this.respond(await this.findByIdOrThrow(sellerId));
    if (idempotencyKey) {
      await this.idempotency.save(
        `seller-patch:${orgId}`,
        idempotencyKey,
        response as unknown as Record<string, unknown>,
      );
    }
    return response;
  }

  /** Soft removal — revokes the seller role, keeping the row as a tombstone. */
  async remove(orgId: string, sellerId: string): Promise<void> {
    const existing = await this.findOrThrow(orgId, sellerId);
    const itemCount = await this.prisma.swapItem.count({ where: { sellerId, deletedAt: null } });
    if (itemCount > 0) {
      throw new ConflictException(
        'Cannot remove a seller with active item mappings. Unassign all items first.',
      );
    }
    await this.prisma.sellerProfile.update({
      where: { id: sellerId },
      data: { deletedAt: new Date() },
    });
    await this.touch.touch(existing.membership.id);
  }

  // ─── CSV import ────────────────────────────────────────────────────────────

  static readonly FIELD_ALIASES: Record<string, string[]> = {
    name:   ['name', 'seller', 'seller name', 'full name', 'fullname'],
    phone:  ['phone', 'phone number', 'tel', 'telephone', 'cell', 'mobile'],
    email:  ['email', 'email address', 'e-mail'],
    street: ['street', 'address', 'address1', 'street address'],
    city:   ['city'],
    state:  ['state', 'province'],
    zip:    ['zip', 'zip code', 'postal code', 'postcode'],
  };

  static detectMapping(headers: string[]): Record<string, string> {
    const mapping: Record<string, string> = {};
    const lowers = headers.map((h) => h.trim().toLowerCase());
    for (const [field, aliases] of Object.entries(SellerService.FIELD_ALIASES)) {
      for (const alias of aliases) {
        const idx = lowers.indexOf(alias);
        if (idx !== -1) { mapping[field] = headers[idx]; break; }
      }
    }
    return mapping;
  }

  parseImportFile(buffer: Buffer): { headers: string[]; rows: Record<string, string>[]; mapping: Record<string, string> } {
    const records: string[][] = parseCsv(buffer, { skip_empty_lines: true, trim: true });
    if (!records.length) return { headers: [], rows: [], mapping: {} };
    const [rawHeaders, ...dataRows] = records;
    const headers = rawHeaders.map((h) => h.trim());
    const mapping = SellerService.detectMapping(headers);

    const rows = dataRows.map((row) => {
      const raw = Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']));
      const { errors: _e, warnings: _w, ...normalizedFields } = normalizeSellerRow(pick(raw, mapping));
      return { ...raw, ...Object.fromEntries(Object.entries(mapping).map(([field, header]) => [header, (normalizedFields as Record<string, string>)[field] ?? ''])) };
    });
    return { headers, rows, mapping };
  }

  /**
   * Imports last season's sellers. Matching is blind by design: email, then
   * phone, then create. A row that matches an existing person joins them to
   * this org rather than creating a second record.
   */
  async importSellers(
    orgId: string,
    buffer: Buffer,
    mapping: Record<string, string>,
    duplicateStrategy: 'overwrite' | 'preserve',
  ): Promise<{ row: number; outcome: 'created' | 'updated' | 'skipped' | 'warning' | 'error'; name?: string; phone?: string; error?: string; warning?: string }[]> {
    const { rows } = this.parseImportFile(buffer);
    const results = [];

    for (let i = 0; i < rows.length; i++) {
      const raw = rows[i];
      const rowNum = i + 2;

      const { name, phone, email, street, city, state, zip, errors, warnings } =
        normalizeSellerRow(pick(raw, mapping));

      if (errors.length) {
        results.push({ row: rowNum, outcome: 'error' as const, name, phone, error: errors.join('; ') });
        continue;
      }

      try {
        const parts = splitName(name);
        const existingUser = await this.people.resolve({ email, phone });
        const existingProfile = existingUser
          ? await this.prisma.sellerProfile.findFirst({
              where: { membership: { orgId, userId: existingUser.id }, deletedAt: null },
            })
          : null;

        if (existingProfile && duplicateStrategy === 'preserve') {
          results.push({ row: rowNum, outcome: 'skipped' as const, name, phone, warning: warnings.join('; ') || undefined });
          continue;
        }

        const { user } = await this.people.resolveOrCreate({
          email, phone, firstName: parts.firstName, lastName: parts.lastName,
        });
        await this.writeUserFields(
          user.id,
          { street: street || null, city: city || null, state: state || null, zip: zip || null },
          { overwrite: duplicateStrategy === 'overwrite' },
        );
        const membership = await this.people.upsertMembership(user.id, orgId);
        await this.upsertSellerProfile(membership.id, null);

        const outcome = existingProfile ? 'updated' : 'created';
        results.push({
          row: rowNum,
          outcome: warnings.length ? ('warning' as const) : (outcome as 'created' | 'updated'),
          name, phone,
          warning: warnings.join('; ') || undefined,
        });
      } catch (err) {
        results.push({ row: rowNum, outcome: 'error' as const, name, phone, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    return results;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async findOrThrow(orgId: string, sellerId: string) {
    const seller = await this.prisma.sellerProfile.findFirst({
      where: { id: sellerId, deletedAt: null, membership: { orgId } },
      include: { ...SELLER_INCLUDE, membership: { include: { user: true, org: { select: { id: true } } } } },
    });
    if (!seller) throw new NotFoundException('Seller not found');
    return seller;
  }

  private async findByIdOrThrow(sellerId: string) {
    return this.prisma.sellerProfile.findUniqueOrThrow({
      where: { id: sellerId },
      include: SELLER_INCLUDE,
    });
  }

  private async upsertSellerProfile(
    membershipId: string,
    businessName: string | null,
    /**
     * An id the caller minted, used only if a row is actually created.
     *
     * A membership that already has a profile keeps the id it has. That is the
     * `resolveOrCreate` case iOS calls out: the person was matched by contact,
     * so this is a draft merging into somebody who already exists, and telling
     * the client its chosen id won that argument would be a lie it would then
     * have to unpick.
     */
    id?: string,
  ) {
    const profile = await this.prisma.sellerProfile.upsert({
      where: { membershipId },
      update: { deletedAt: null, ...(businessName !== null ? { businessName } : {}) },
      create: { id: id ?? createId(), membershipId, businessName },
    }).catch((err: unknown) => {
      /*
       * The one way a caller-supplied id still collides here: it belongs to
       * another membership in this org, so the upsert misses on `membershipId`
       * and tries to insert under an id that is taken. Rare, and the client's
       * to resolve, but a raw constraint violation would reach it as a 500.
       */
      if (isUniqueViolation(err)) throw new ConflictException('That id is already in use.');
      throw err;
    });
    await this.touch.touch(membershipId);
    return profile;
  }

  /**
   * Whether a client-minted id is free to use, refusing if it is not ours.
   *
   * A create under an id that already exists answers with that row — that is
   * what makes a retried offline create safe. But a primary key is unique
   * across the database rather than per org, so answering unconditionally would
   * hand a caller another organization's seller for the price of a guessed
   * UUID. Somebody else's row is a conflict, and the message says nothing about
   * whose it is.
   */
  private async assertIdUsable(orgId: string, id: string): Promise<SellerResponse | null> {
    const existing = await this.prisma.sellerProfile.findUnique({
      where: { id },
      include: SELLER_INCLUDE,
    });
    if (!existing) return null;
    if (existing.membership.orgId !== orgId) {
      throw new ConflictException('That id is already in use.');
    }
    /*
     * A removed seller is not an answer, it is a row to bring back.
     *
     * Falling through puts this on the ordinary create path, where
     * `upsertSellerProfile` clears `deletedAt` — which is already what
     * re-adding a removed seller does when no id is involved. Returning the
     * tombstone here instead told the client its create had succeeded and
     * handed it a row with `deletedAt` set.
     *
     * Items go the other way and refuse: a withdrawn item's tag is out of
     * circulation and its SKU may have been re-issued, so there is nothing to
     * restore it into. A person can simply be a seller again.
     */
    if (existing.deletedAt) return null;
    return this.respond(existing);
  }

  /**
   * Person fields live on `User` and are global. On import they only fill gaps;
   * a staff edit overwrites, because the person is standing right there.
   */
  private async writeUserFields(
    userId: string,
    data: {
      firstName?: string | null; lastName?: string | null;
      phone?: string | null; email?: string | null;
      street?: string | null; city?: string | null; state?: string | null; zip?: string | null;
      payoutMethod?: string | null; payoutTarget?: string | null; payoutHandle?: string | null;
      payoutHandleSource?: 'SCAN';
    },
    opts: { overwrite?: boolean } = {},
  ): Promise<void> {
    const current = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    const keep = <T>(incoming: T | null | undefined, existing: T | null): T | null | undefined => {
      if (incoming === undefined) return undefined;
      if (!opts.overwrite && existing != null && existing !== '') return undefined;
      return incoming;
    };

    const update = {
      // Normalized only when the caller actually sent the field.
      // `normalizeNamePart(undefined)` is null, not undefined — passing it
      // straight through made every patch that omits a name (an address, a
      // payout) write null over the one already there.
      ...defined('firstName', keep(namePart(data.firstName), current.firstName)),
      ...defined('lastName', keep(namePart(data.lastName), current.lastName)),
      ...defined('phone', keep(data.phone ? normalizePhone(data.phone) : data.phone, current.phone)),
      ...defined('email', keep(data.email?.toLowerCase() ?? data.email, current.email)),
      ...defined('street', keep(data.street, current.street)),
      ...defined('city', keep(data.city, current.city)),
      ...defined('state', keep(data.state, current.state)),
      ...defined('zip', keep(data.zip, current.zip)),
      /*
       * The three payout fields move as one, and under the same rule as the
       * rest: fill a gap, never overwrite without being told to.
       *
       * They used to bypass `keep`. Staff adding last season's seller again by
       * phone matched the existing person, and the form's default of CHECK
       * silently replaced the PayPal details they had given — the first anyone
       * heard of it was a cheque in the post.
       */
      ...(!opts.overwrite && current.payoutMethod != null
        ? {}
        : {
            ...defined('payoutMethod', data.payoutMethod),
            ...defined('payoutTarget', data.payoutTarget),
            ...defined('payoutHandle', data.payoutHandle),
          }),
    };

    if (Object.keys(update).length === 0) return;

    const unverify = unverifyChangedContacts(current, {
      email: update.email as string | null | undefined,
      phone: update.phone as string | null | undefined,
    });

    // A payout target written now is judged against the contacts as they'll
    // stand after this write. One already stored isn't re-judged: an address
    // corrected under it leaves the next payout run to flag it, where somebody
    // can fix it, rather than refusing the correction.
    const targetWritten = 'payoutTarget' in update;
    const payoutWritten = 'payoutMethod' in update || targetWritten || 'payoutHandle' in update;
    const scanned = payoutWritten
      ? payoutHandleScannedAt(
          {
            method: 'payoutMethod' in update ? (update.payoutMethod as string | null) : current.payoutMethod,
            target: targetWritten ? (update.payoutTarget as string | null) : current.payoutTarget,
            handle: 'payoutHandle' in update ? (update.payoutHandle as string | null) : current.payoutHandle,
          },
          { handle: current.payoutHandle, scannedAt: current.payoutHandleScannedAt },
          data.payoutHandleSource,
        )
      : undefined;
    // Only when a payout is written, as the comment above says: a payout on file
    // that's no longer provable (a PayPal email never verified) mustn't block
    // fixing the address the dashboard is asking for.
    if (payoutWritten) assertPayoutIsCoherent({
      method: 'payoutMethod' in update ? (update.payoutMethod as string | null) : current.payoutMethod,
      target: targetWritten ? (update.payoutTarget as string | null) : current.payoutTarget,
      handle: 'payoutHandle' in update ? (update.payoutHandle as string | null) : current.payoutHandle,
      emailVerified: !!current.emailVerifiedAt && !(targetWritten && 'verifiedEmail' in unverify),
      phoneVerified: !!current.phoneVerifiedAt && !(targetWritten && 'verifiedPhone' in unverify),
    });

    await this.prisma.user.update({
      where: { id: userId },
      data: { ...update, ...unverify, ...(scanned !== undefined ? { payoutHandleScannedAt: scanned } : {}) },
    });
    await this.touch.touchAllForUser(userId);
  }
}

/**
 * Only a proven destination may be set as a payout (Plan 35): the owner's rule
 * is no unverified electronic payment target. Judged only when a payout is
 * being written, so one already on file never blocks an unrelated edit; the
 * payout run flags it instead.
 *
 * - PayPal pays the seller's verified email, and nothing else: a typed PayPal
 *   ID or a phone is only somebody's word for the account.
 * - Venmo pays the account on the seller's Venmo code, scanned at the counter.
 *   A write that sets or changes the handle must say it was scanned
 *   (`payoutHandleSource: 'SCAN'`). Re-saving a scanned handle unchanged is
 *   fine.
 *
 * Returns what `payoutHandleScannedAt` becomes: now for a scan, unchanged for
 * the same scanned handle, and null once there's no Venmo handle.
 */
export function payoutHandleScannedAt(
  next: { method: string | null; target: string | null; handle: string | null },
  current: { handle: string | null; scannedAt: Date | null },
  source: 'SCAN' | undefined,
): Date | null {
  if (next.method === 'PAYPAL' && next.target !== null && next.target !== 'EMAIL') {
    throw new BadRequestException('PayPal pays the seller’s verified email only.');
  }
  if (next.method !== 'VENMO' || !next.handle) return null;

  if (source === 'SCAN') return new Date();
  if (next.handle === current.handle && current.scannedAt) return current.scannedAt;
  throw new BadRequestException({
    message: 'A Venmo account can only be set by scanning the seller’s Venmo code at the counter.',
    code: 'VENMO_NOT_SCANNED',
  });
}

/** normalizeNamePart, but absent stays absent. */
function namePart(raw: string | null | undefined): string | null | undefined {
  return raw === undefined ? undefined : normalizeNamePart(raw);
}

function defined<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}

function pick(raw: Record<string, string>, mapping: Record<string, string>) {
  return {
    name:   mapping.name   ? raw[mapping.name]   : '',
    phone:  mapping.phone  ? raw[mapping.phone]  : '',
    email:  mapping.email  ? raw[mapping.email]  : '',
    street: mapping.street ? raw[mapping.street] : '',
    city:   mapping.city   ? raw[mapping.city]   : '',
    state:  mapping.state  ? raw[mapping.state]  : '',
    zip:    mapping.zip    ? raw[mapping.zip]    : '',
  };
}

// ─── Display helpers shared with printers, items and public pages ────────────

/** Include that carries just enough of the person to render a seller's name. */
export const SELLER_NAME_INCLUDE = {
  membership: { select: { user: { select: { firstName: true, lastName: true, email: true, phone: true } } } },
} as const;

export interface SellerNameRow {
  businessName: string | null;
  membership: {
    user: {
      firstName: string | null;
      lastName: string | null;
      email?: string | null;
      phone?: string | null;
    };
  };
}

/** businessName, else "First Last", else a contact. Never empty. */
export function sellerDisplayName(seller: SellerNameRow | null | undefined): string | null {
  if (!seller) return null;
  return displayName(seller.membership.user, seller.businessName);
}

/**
 * The combinations a payout may be in, checked against what the row will hold
 * after the write rather than what was sent — a patch that moves the method
 * without the target has to be judged on the pair it leaves behind.
 *
 * These are invariants rather than completeness: they say a destination makes
 * sense, not that one is present. Whether a seller has answered at all is a
 * question for the point their check-in completes, because a staff member
 * correcting one field on an incomplete record must not be refused for the
 * fields they did not touch.
 */
export function assertPayoutIsCoherent(row: {
  method: string | null;
  target: string | null;
  handle: string | null;
  emailVerified: boolean;
  phoneVerified: boolean;
}): void {
  const { method, target, handle } = row;

  // A method that pays no one carries no destination.
  if (method === null || method === 'CHECK' || method === 'DONATE') {
    if (target !== null || handle !== null) {
      throw new BadRequestException(
        `A ${method ?? 'blank'} payout has no destination to send to.`,
      );
    }
    return;
  }

  if (method === 'PAYPAL') {
    if (target !== null && !['EMAIL', 'PHONE', 'PAYPAL_ID'].includes(target)) {
      throw new BadRequestException('PayPal can pay an email, a phone or a PayPal ID.');
    }
  }

  if (method === 'VENMO' && target !== null && target !== 'VENMO_ID') {
    throw new BadRequestException('Venmo can only pay a Venmo ID.');
  }

  // A typed target needs its value; a verified one must not carry a copy, which
  // could go stale against the contact it duplicates.
  if (target === 'PAYPAL_ID' || target === 'VENMO_ID') {
    if (!handle || handle.trim() === '') {
      throw new BadRequestException('That payout needs an ID to send to.');
    }
  } else if (handle !== null) {
    throw new BadRequestException(
      'A payout to a verified contact is resolved from that contact, not stored beside it.',
    );
  }

  // A contact can only receive money once its owner has proved they hold it.
  if (target === 'EMAIL' && !row.emailVerified) {
    throw new BadRequestException('That email has not been verified, so it cannot be paid.');
  }
  if (target === 'PHONE' && !row.phoneVerified) {
    throw new BadRequestException('That phone has not been verified, so it cannot be paid.');
  }
}
