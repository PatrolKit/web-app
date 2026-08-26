import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { PersonService } from '../common/identity/person.service';
import { MembershipTouchService } from '../common/identity/membership-touch.service';
import { displayName, normalizeNamePart, normalizePhone, splitName } from '../common/util/person';
import { createId } from '@paralleldrive/cuid2';
import { parse as parseCsv } from 'csv-parse/sync';
import type { PersonSearchResult, SellerResponse } from '../contracts/ski-swap.contracts';

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
  updatedAt: Date;
  membership: {
    orgId: string;
    userId: string;
    user: {
      firstName: string | null; lastName: string | null;
      email: string | null; phone: string | null;
      street: string | null; city: string | null; state: string | null; zip: string | null;
      emailVerifiedAt: Date | null; phoneVerifiedAt: Date | null;
      payoutMethod: string | null; payoutChannel: string | null;
    };
  };
};

export function toSellerResponse(s: SellerRow): SellerResponse {
  const u = s.membership.user;
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
    payoutChannel: u.payoutChannel as SellerResponse['payoutChannel'],
    emailVerifiedAt: u.emailVerifiedAt?.toISOString() ?? null,
    phoneVerifiedAt: u.phoneVerifiedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

@Injectable()
export class SellerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly people: PersonService,
    private readonly touch: MembershipTouchService,
  ) {}

  async list(orgId: string, query?: string, updatedSince?: string): Promise<SellerResponse[]> {
    const sellers = await this.prisma.sellerProfile.findMany({
      where: {
        deletedAt: null,
        membership: {
          orgId,
          deletedAt: null,
          ...(query
            ? {
                user: {
                  OR: [
                    { firstName: { contains: query } },
                    { lastName: { contains: query } },
                    { phone: { contains: query.replace(/\D/g, '') } },
                    { email: { contains: query } },
                  ],
                },
              }
            : {}),
        },
        ...(updatedSince ? { updatedAt: { gt: new Date(updatedSince) } } : {}),
        ...(query ? {} : {}),
      },
      include: SELLER_INCLUDE,
      orderBy: [{ membership: { user: { lastName: 'asc' } } }, { createdAt: 'asc' }],
    });
    // Business-name matches cannot be expressed in the same OR as user fields.
    const byBusiness = query
      ? await this.prisma.sellerProfile.findMany({
          where: {
            deletedAt: null,
            businessName: { contains: query },
            membership: { orgId, deletedAt: null },
          },
          include: SELLER_INCLUDE,
        })
      : [];

    const merged = new Map(
      [...sellers, ...byBusiness].map((s) => [s.id, s] as const),
    );
    return [...merged.values()].map(toSellerResponse);
  }

  async get(orgId: string, sellerId: string): Promise<SellerResponse> {
    return toSellerResponse(await this.findOrThrow(orgId, sellerId));
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
    return toSellerResponse(await this.findByIdOrThrow(profile.id));
  }

  async create(
    orgId: string,
    data: {
      firstName?: string | null; lastName?: string | null;
      phone?: string | null; email?: string | null;
      businessName?: string | null;
      street?: string | null; city?: string | null; state?: string | null; zip?: string | null;
      payoutMethod?: string | null; payoutChannel?: string | null;
    },
    idempotencyKey?: string,
  ): Promise<SellerResponse> {
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(`seller-create:${orgId}`, idempotencyKey);
      if (cached) return cached as unknown as SellerResponse;
    }

    const { user } = await this.people.resolveOrCreate({
      email: data.email,
      phone: data.phone,
      firstName: data.firstName,
      lastName: data.lastName,
    });

    await this.writeUserFields(user.id, data);
    const membership = await this.people.upsertMembership(user.id, orgId);
    const profile = await this.upsertSellerProfile(membership.id, data.businessName ?? null);

    const response = toSellerResponse(await this.findByIdOrThrow(profile.id));

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
      payoutMethod?: string | null; payoutChannel?: string | null;
    },
  ): Promise<SellerResponse> {
    const existing = await this.findOrThrow(orgId, sellerId);

    await this.writeUserFields(existing.membership.userId, data, { overwrite: true });

    if (data.businessName !== undefined) {
      await this.prisma.sellerProfile.update({
        where: { id: sellerId },
        data: { businessName: data.businessName },
      });
    }
    await this.touch.touch(existing.membership.id);

    return toSellerResponse(await this.findByIdOrThrow(sellerId));
  }

  /** Soft removal — revokes the seller role, keeping the row as a tombstone. */
  async remove(orgId: string, sellerId: string): Promise<void> {
    const existing = await this.findOrThrow(orgId, sellerId);
    const itemCount = await this.prisma.swapItem.count({ where: { sellerId } });
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

  private async upsertSellerProfile(membershipId: string, businessName: string | null) {
    const profile = await this.prisma.sellerProfile.upsert({
      where: { membershipId },
      update: { deletedAt: null, ...(businessName !== null ? { businessName } : {}) },
      create: { id: createId(), membershipId, businessName },
    });
    await this.touch.touch(membershipId);
    return profile;
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
      payoutMethod?: string | null; payoutChannel?: string | null;
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
      ...defined('firstName', keep(normalizeNamePart(data.firstName), current.firstName)),
      ...defined('lastName', keep(normalizeNamePart(data.lastName), current.lastName)),
      ...defined('phone', keep(data.phone ? normalizePhone(data.phone) : data.phone, current.phone)),
      ...defined('email', keep(data.email?.toLowerCase() ?? data.email, current.email)),
      ...defined('street', keep(data.street, current.street)),
      ...defined('city', keep(data.city, current.city)),
      ...defined('state', keep(data.state, current.state)),
      ...defined('zip', keep(data.zip, current.zip)),
      ...defined('payoutMethod', data.payoutMethod),
      ...defined('payoutChannel', data.payoutChannel),
    };

    if (Object.keys(update).length === 0) return;
    await this.prisma.user.update({ where: { id: userId }, data: update });
    await this.touch.touchAllForUser(userId);
  }
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
