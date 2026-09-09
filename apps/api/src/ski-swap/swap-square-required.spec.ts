import { ServiceUnavailableException } from '@nestjs/common';
import { SwapService } from './swap.service';

/**
 * What a client is told when it tries to make a swap on an org with no Square.
 *
 * A swap files its items under a Square catalogue category, so this one path
 * genuinely cannot degrade — while everything downstream of it does, skipping
 * Square rather than failing. From outside that asymmetry reads as a bug, and
 * the bare "Square is not configured" gives a caller nothing to act on: the
 * iPad team spent an hour tracing it back to the swap-creation call.
 */

/** Stands in for the client factory, refusing exactly the way the real one does. */
function refusingSquare() {
  return {
    forOrg: async () => {
      throw new ServiceUnavailableException({
        message: 'Square is not configured for this organization',
        code: 'SQUARE_NOT_CONFIGURED',
      });
    },
  };
}

/** `create` reaches Square before it reaches the database, so prisma stays unbuilt. */
function service(square: { forOrg: () => Promise<unknown> }) {
  return new SwapService({} as never, square as unknown as never);
}

/** The body the exception filter would send, which is all a client ever sees. */
function bodyOf(err: unknown): { message?: string; code?: string } {
  return (err as ServiceUnavailableException).getResponse() as { message?: string; code?: string };
}

describe('creating a swap without Square', () => {
  it('names what the caller was doing', async () => {
    const err = await service(refusingSquare())
      .create('org-1', 'Ski Swap 2026', 'loc-1', 'actor-1')
      .catch((e: unknown) => e);

    expect(bodyOf(err).message).toBe(
      'Connect Square before creating a swap — the swap needs a catalog category to file its items under.',
    );
  });

  it('says why, so the requirement is not just a rule', async () => {
    const err = await service(refusingSquare())
      .create('org-1', 'Ski Swap 2026', 'loc-1', 'actor-1')
      .catch((e: unknown) => e);

    expect(bodyOf(err).message).toContain('catalog category');
  });

  it('keeps the code, so a client can branch without matching prose', async () => {
    const err = await service(refusingSquare())
      .create('org-1', 'Ski Swap 2026', 'loc-1', 'actor-1')
      .catch((e: unknown) => e);

    expect(bodyOf(err).code).toBe('SQUARE_NOT_CONFIGURED');
    expect((err as ServiceUnavailableException).getStatus()).toBe(503);
  });

  it('is still a 503 the client can retry after connecting', async () => {
    const err = await service(refusingSquare())
      .create('org-1', 'Ski Swap 2026', 'loc-1', 'actor-1')
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ServiceUnavailableException);
  });
});

describe('a Square failure that is not a missing config', () => {
  it('travels untouched rather than being relabelled', async () => {
    // Only the missing-config refusal has a swap-specific thing to say. An
    // expired token or an outage must not be reported as "connect Square".
    const outage = new ServiceUnavailableException({
      message: 'Square returned 503',
      code: 'SQUARE_UNAVAILABLE',
    });
    const err = await service({ forOrg: async () => { throw outage; } })
      .create('org-1', 'Ski Swap 2026', 'loc-1', 'actor-1')
      .catch((e: unknown) => e);

    expect(err).toBe(outage);
  });
});
