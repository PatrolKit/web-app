import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { IdempotencyService } from '../common/services/idempotency.service';
import { createId } from '@paralleldrive/cuid2';
import { parse as parseCsv } from 'csv-parse/sync';
import type { SellerResponse } from '../contracts/ski-swap.contracts';

// ─── Normalization helpers ────────────────────────────────────────────────────

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

/** Stores as XXX-XXX-XXXX; also used for duplicate lookup (strip dashes first). */
export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  // Strip leading country code 1 from 11-digit US numbers
  const ten = digits.length === 11 && digits[0] === '1' ? digits.slice(1) : digits;
  if (ten.length !== 10) return ten; // return raw digits if non-standard length
  return `${ten.slice(0, 3)}-${ten.slice(3, 6)}-${ten.slice(6)}`;
}

function normalizeState(s: string): string {
  const trimmed = s.trim();
  if (!trimmed) return '';
  // Already a 2-char abbreviation
  if (trimmed.length === 2) return trimmed.toUpperCase();
  const lower = trimmed.toLowerCase();
  return STATE_MAP[lower] ?? trimmed.toUpperCase().slice(0, 2); // best-effort if unknown
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
  const phone = normalizePhone(raw.phone ?? '');
  const email = (raw.email ?? '').trim().toLowerCase();
  const zip   = normalizeZip(raw.zip ?? '');
  const rawState = (raw.state ?? '').trim();
  const state = normalizeState(rawState);

  if (!name)  errors.push('name is required');
  if (!phone) errors.push('phone is required');
  else if (phone.replace(/\D/g, '').length !== 10) errors.push(`"${raw.phone?.trim()}" is not a valid 10-digit phone number`);
  if (!email) errors.push('email is required');
  else if (!EMAIL_RE.test(email)) errors.push(`"${email}" is not a valid email address`);

  // Optional-field issues are warnings — row is still imported
  if (zip && zip.length !== 5) warnings.push(`ZIP "${raw.zip?.trim()}" is not 5 digits; stored as-is`);
  if (rawState && rawState.length > 2 && !STATE_MAP[rawState.toLowerCase()]) warnings.push(`State "${rawState}" not recognised; stored as "${state}"`);

  return { name, phone, email, street: toTitleCase(raw.street ?? ''), city: toTitleCase(raw.city ?? ''), state, zip, errors, warnings };
}

@Injectable()
export class SellerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async list(orgId: string, query?: string, updatedSince?: string): Promise<SellerResponse[]> {
    const sellers = await this.prisma.swapSeller.findMany({
      where: {
        orgId,
        ...(query
          ? {
              OR: [
                { name: { contains: query } },
                { phone: { contains: query.replace(/\D/g, '') } },
                { email: { contains: query } },
              ],
            }
          : {}),
        ...(updatedSince ? { updatedAt: { gt: new Date(updatedSince) } } : {}),
      },
      orderBy: { name: 'asc' },
    });
    return sellers.map(this.toResponse);
  }

  async get(orgId: string, sellerId: string): Promise<SellerResponse> {
    const seller = await this.findOrThrow(orgId, sellerId);
    return this.toResponse(seller);
  }

  async create(
    orgId: string,
    data: {
      name: string; phone: string; email?: string; type?: string;
      street?: string; city?: string; state?: string; zip?: string;
      payoutMethod?: string | null; payoutIdentifierType?: string | null;
      payoutIdentifier?: string | null; payoutIdentifierConfirmedAt?: string | null;
    },
    idempotencyKey?: string,
  ): Promise<SellerResponse> {
    if (idempotencyKey) {
      const cached = await this.idempotency.getCached(idempotencyKey);
      if (cached) return cached as unknown as SellerResponse;
    }

    const seller = await this.prisma.swapSeller.create({
      data: {
        id: createId(), orgId, type: data.type ?? 'individual',
        name: data.name, phone: normalizePhone(data.phone),
        email: data.email ?? null, street: data.street ?? null,
        city: data.city ?? null, state: data.state ?? null, zip: data.zip ?? null,
        payoutMethod: data.payoutMethod ?? null,
        payoutIdentifierType: data.payoutIdentifierType ?? null,
        payoutIdentifier: data.payoutIdentifier ?? null,
        payoutIdentifierConfirmedAt: data.payoutIdentifierConfirmedAt ? new Date(data.payoutIdentifierConfirmedAt) : null,
      },
    });
    const response = this.toResponse(seller);

    if (idempotencyKey) {
      await this.idempotency.save(idempotencyKey, response as unknown as Record<string, unknown>);
    }

    return response;
  }

  async patch(
    orgId: string,
    sellerId: string,
    data: {
      name?: string; phone?: string; email?: string | null; type?: string;
      street?: string | null; city?: string | null; state?: string | null; zip?: string | null;
      payoutMethod?: string | null; payoutIdentifierType?: string | null;
      payoutIdentifier?: string | null; payoutIdentifierConfirmedAt?: string | null;
    },
  ): Promise<SellerResponse> {
    await this.findOrThrow(orgId, sellerId);
    const seller = await this.prisma.swapSeller.update({
      where: { id: sellerId },
      data: {
        ...(data.name !== undefined ? { name: data.name } : {}),
        ...(data.phone !== undefined ? { phone: normalizePhone(data.phone) } : {}),
        ...(data.email !== undefined ? { email: data.email } : {}),
        ...(data.type !== undefined ? { type: data.type } : {}),
        ...(data.street !== undefined ? { street: data.street } : {}),
        ...(data.city !== undefined ? { city: data.city } : {}),
        ...(data.state !== undefined ? { state: data.state } : {}),
        ...(data.zip !== undefined ? { zip: data.zip } : {}),
        ...(data.payoutMethod !== undefined ? { payoutMethod: data.payoutMethod } : {}),
        ...(data.payoutIdentifierType !== undefined ? { payoutIdentifierType: data.payoutIdentifierType } : {}),
        ...(data.payoutIdentifier !== undefined ? { payoutIdentifier: data.payoutIdentifier } : {}),
        ...(data.payoutIdentifierConfirmedAt !== undefined ? { payoutIdentifierConfirmedAt: data.payoutIdentifierConfirmedAt ? new Date(data.payoutIdentifierConfirmedAt) : null } : {}),
      },
    });
    return this.toResponse(seller);
  }

  async remove(orgId: string, sellerId: string): Promise<void> {
    await this.findOrThrow(orgId, sellerId);
    const itemCount = await this.prisma.swapItem.count({ where: { sellerId } });
    if (itemCount > 0) {
      throw new ConflictException(
        'Cannot delete a seller with active item mappings. Unassign all items first.',
      );
    }
    await this.prisma.swapSeller.delete({ where: { id: sellerId } });
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

    // Normalize each row so the preview shows what will actually be imported
    const rows = dataRows.map((row) => {
      const raw = Object.fromEntries(headers.map((h, i) => [h, row[i] ?? '']));
      const { errors: _e, warnings: _w, ...normalizedFields } = normalizeSellerRow({
        name:   mapping.name   ? raw[mapping.name]   : '',
        phone:  mapping.phone  ? raw[mapping.phone]  : '',
        email:  mapping.email  ? raw[mapping.email]  : '',
        street: mapping.street ? raw[mapping.street] : '',
        city:   mapping.city   ? raw[mapping.city]   : '',
        state:  mapping.state  ? raw[mapping.state]  : '',
        zip:    mapping.zip    ? raw[mapping.zip]     : '',
      });
      // Merge normalized values back under original header keys so the preview table works
      return { ...raw, ...Object.fromEntries(Object.entries(mapping).map(([field, header]) => [header, (normalizedFields as Record<string, string>)[field] ?? ''])) };
    });
    return { headers, rows, mapping };
  }

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

      const { name, phone, email, street, city, state, zip, errors, warnings } = normalizeSellerRow({
        name:   mapping.name   ? raw[mapping.name]   : '',
        phone:  mapping.phone  ? raw[mapping.phone]  : '',
        email:  mapping.email  ? raw[mapping.email]  : '',
        street: mapping.street ? raw[mapping.street] : '',
        city:   mapping.city   ? raw[mapping.city]   : '',
        state:  mapping.state  ? raw[mapping.state]  : '',
        zip:    mapping.zip    ? raw[mapping.zip]     : '',
      });

      if (errors.length) {
        results.push({ row: rowNum, outcome: 'error' as const, name, phone, error: errors.join('; ') });
        continue;
      }

      try {
        const existing = await this.prisma.swapSeller.findFirst({ where: { orgId, phone } });
        if (existing) {
          if (duplicateStrategy === 'preserve') {
            results.push({ row: rowNum, outcome: 'skipped' as const, name, phone, warning: warnings.join('; ') || undefined });
          } else {
            await this.prisma.swapSeller.update({
              where: { id: existing.id },
              data: { name, email, street: street || existing.street, city: city || existing.city, state: state || existing.state, zip: zip || existing.zip },
            });
            results.push({ row: rowNum, outcome: warnings.length ? 'warning' as const : 'updated' as const, name, phone, warning: warnings.join('; ') || undefined });
          }
        } else {
          await this.prisma.swapSeller.create({
            data: { id: createId(), orgId, name, phone, email, street: street || null, city: city || null, state: state || null, zip: zip || null },
          });
          results.push({ row: rowNum, outcome: warnings.length ? 'warning' as const : 'created' as const, name, phone, warning: warnings.join('; ') || undefined });
        }
      } catch (err) {
        results.push({ row: rowNum, outcome: 'error' as const, name, phone, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    return results;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────────

  async findOrThrow(orgId: string, sellerId: string) {
    const seller = await this.prisma.swapSeller.findFirst({ where: { id: sellerId, orgId } });
    if (!seller) throw new NotFoundException('Seller not found');
    return seller;
  }

  private toResponse(seller: {
    id: string; orgId: string; type: string; name: string; phone: string;
    email: string | null; street: string | null; city: string | null;
    state: string | null; zip: string | null;
    payoutMethod: string | null; payoutIdentifierType: string | null;
    payoutIdentifier: string | null; payoutIdentifierConfirmedAt: Date | null;
    createdAt: Date; updatedAt: Date;
  }): SellerResponse {
    return {
      id: seller.id, orgId: seller.orgId,
      type: (seller.type ?? 'individual') as 'individual' | 'business',
      name: seller.name, phone: seller.phone, email: seller.email,
      street: seller.street, city: seller.city, state: seller.state, zip: seller.zip,
      payoutMethod: seller.payoutMethod as SellerResponse['payoutMethod'],
      payoutIdentifierType: seller.payoutIdentifierType as SellerResponse['payoutIdentifierType'],
      payoutIdentifier: seller.payoutIdentifier,
      payoutIdentifierConfirmedAt: seller.payoutIdentifierConfirmedAt?.toISOString() ?? null,
      createdAt: seller.createdAt.toISOString(), updatedAt: seller.updatedAt.toISOString(),
    };
  }
}
