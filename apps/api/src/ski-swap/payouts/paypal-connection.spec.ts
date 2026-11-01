import { HttpPayPalClient } from './paypal.client';

/**
 * Whether an org's PayPal app may pay people, as far as PayPal says short of
 * paying them.
 *
 * Matching the scope name from PayPal's documentation told BMBWAV's live app,
 * with Payouts enabled, that it was not approved: PayPal grants a different
 * name. Looking up a batch, then sending one with no payments, both passed for
 * an account still in PayPal's Payouts review, whose real send was refused. So
 * the test reads the scope PayPal actually grants, and leaves approval to Send.
 */

type Answer = { status: number; body?: unknown };

function harness(answers: { token: Answer; probe?: Answer }) {
  const calls: string[] = [];
  const fetchMock = jest.fn(async (url: string) => {
    calls.push(url);
    const answer = url.endsWith('/v1/oauth2/token') ? answers.token : answers.probe!;
    return {
      ok: answer.status >= 200 && answer.status < 300,
      status: answer.status,
      headers: { get: () => null },
      json: async () => answer.body ?? {},
      text: async () => JSON.stringify(answer.body ?? {}),
    };
  });
  global.fetch = fetchMock as unknown as typeof fetch;

  const prisma = {
    payPalConfig: {
      findUnique: async () => ({ clientId: 'id', clientSecretEnc: 'enc', environment: 'live' }),
    },
  };
  const crypto = { decrypt: () => 'secret' };
  return { client: new HttpPayPalClient(prisma as never, crypto as never), calls };
}

// The scopes PayPal actually granted BMBWAV's app — without the documented name.
const LIVE_TOKEN = {
  status: 200,
  body: {
    access_token: 't', expires_in: 32000,
    scope: 'openid https://uri.paypal.com/payments/payouts https://api.paypal.com/v1/payments/.*',
  },
};

const realFetch = global.fetch;
afterEach(() => { global.fetch = realFetch; });

describe('testing a PayPal connection', () => {
  it('passes when the app has Payouts turned on, and says the first Send is what proves approval', async () => {
    const { client, calls } = harness({ token: LIVE_TOKEN });
    const result = await client.testConnection('org-1');
    expect(result.success).toBe(true);
    expect(result.message).toMatch(/^Connected to PayPal \(live\), and Payouts is turned on for this app/);
    expect(result.message).toMatch(/Send is refused and nobody is paid/);
    // Asks PayPal nothing beyond a token: neither a lookup nor an empty batch
    // told an app in PayPal's review from an approved one.
    expect(calls).toEqual(['https://api-m.paypal.com/v1/oauth2/token']);
  });

  it('says to turn Payouts on when the app doesn’t have it', async () => {
    const { client } = harness({ token: { status: 200, body: { access_token: 't', expires_in: 32000, scope: 'openid https://uri.paypal.com/services/invoicing' } } });
    const result = await client.testConnection('org-1');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Payouts isn't turned on for this app/);
    expect(result.message).toMatch(/check Payouts under Features/);
  });

  it('matches the Payouts scope as PayPal grants it, not a name containing it', async () => {
    const { client } = harness({ token: { status: 200, body: { access_token: 't', expires_in: 32000, scope: 'https://uri.paypal.com/payments/payouts-readonly' } } });
    await expect(client.testConnection('org-1')).resolves.toMatchObject({ success: false });
  });

  it('says so plainly when the credentials themselves are wrong', async () => {
    const { client } = harness({ token: { status: 401 } });
    const result = await client.testConnection('org-1');
    expect(result).toMatchObject({ success: false });
    expect(result.message).toMatch(/did not accept this Client ID and Secret/);
  });

  it('asks with a fresh token every time, so it answers about the app as it is now', async () => {
    const { client, calls } = harness({ token: LIVE_TOKEN });
    await client.testConnection('org-1');
    await client.testConnection('org-1');
    expect(calls.filter((u) => u.endsWith('/v1/oauth2/token'))).toHaveLength(2);
  });
});

describe('the token cache', () => {
  it('is dropped when the org’s credentials change', async () => {
    const { client, calls } = harness({ token: LIVE_TOKEN, probe: { status: 200, body: {} } });
    const read = () => client.getBatch('org-1', 'batch-1');
    await read();
    await read();
    expect(calls.filter((u) => u.endsWith('/v1/oauth2/token'))).toHaveLength(1);

    client.forget('org-1');
    await read();
    expect(calls.filter((u) => u.endsWith('/v1/oauth2/token'))).toHaveLength(2);
  });
});
