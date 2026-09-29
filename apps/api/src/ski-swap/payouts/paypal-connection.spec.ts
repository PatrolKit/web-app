import { HttpPayPalClient } from './paypal.client';

/**
 * Whether an org's PayPal app may pay people, asked the way PayPal answers it.
 *
 * This used to match a scope name from PayPal's documentation against the
 * token, and PayPal grants a different name: BMBWAV's live app, with Payouts
 * enabled, was told it was not approved. So the test now looks up a payout
 * batch that cannot exist — "not found" means allowed, "refused" means not.
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
  it('passes when PayPal says a made-up payout batch was not found', async () => {
    const { client, calls } = harness({ token: LIVE_TOKEN, probe: { status: 404 } });
    await expect(client.testConnection('org-1')).resolves.toEqual({
      success: true, message: 'Connected to PayPal (live) with Payouts enabled',
    });
    expect(calls.at(-1)).toMatch(/^https:\/\/api-m\.paypal\.com\/v1\/payments\/payouts\//);
  });

  it('passes whatever the scopes are called — it does not read them', async () => {
    const { client } = harness({
      token: { status: 200, body: { access_token: 't', expires_in: 32000, scope: 'openid' } },
      probe: { status: 404 },
    });
    await expect(client.testConnection('org-1')).resolves.toMatchObject({ success: true });
  });

  it('fails, saying why, when PayPal refuses the app Payouts', async () => {
    const { client } = harness({ token: LIVE_TOKEN, probe: { status: 403 } });
    const result = await client.testConnection('org-1');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/refused to let this app use Payouts/);
  });

  it('says so plainly when the credentials themselves are wrong', async () => {
    const { client } = harness({ token: { status: 401 } });
    const result = await client.testConnection('org-1');
    expect(result).toMatchObject({ success: false });
    expect(result.message).toMatch(/did not accept this Client ID and Secret/);
  });

  it('asks with a fresh token every time, so it answers about the app as it is now', async () => {
    const { client, calls } = harness({ token: LIVE_TOKEN, probe: { status: 404 } });
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
