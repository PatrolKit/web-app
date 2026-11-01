import { HttpPayPalClient } from './paypal.client';

/**
 * Whether an org's PayPal app may pay people, asked the way PayPal answers it.
 *
 * This used to match a scope name from PayPal's documentation against the
 * token, and PayPal grants a different name: BMBWAV's live app, with Payouts
 * enabled, was told it was not approved. Then it looked up a payout batch that
 * couldn't exist, which PayPal allowed for an app it then refused to let send.
 * So the test now sends a batch with no payments in it: "invalid" means
 * allowed, "refused" means not, and nobody can be paid either way.
 */

type Answer = { status: number; body?: unknown };

function harness(answers: { token: Answer; probe?: Answer }) {
  const calls: string[] = [];
  const sent: { url: string; method?: string; body?: unknown }[] = [];
  const fetchMock = jest.fn(async (url: string, init?: { method?: string; body?: string }) => {
    calls.push(url);
    sent.push({ url, method: init?.method, body: init?.body && !url.endsWith('/v1/oauth2/token') ? JSON.parse(init.body) : undefined });
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
  return { client: new HttpPayPalClient(prisma as never, crypto as never), calls, sent };
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
  it('passes when PayPal says a batch with no payments is invalid', async () => {
    const { client, sent } = harness({ token: LIVE_TOKEN, probe: { status: 400, body: { name: 'VALIDATION_ERROR' } } });
    await expect(client.testConnection('org-1')).resolves.toEqual({
      success: true, message: 'Connected to PayPal (live) with Payouts enabled',
    });
    const probe = sent.at(-1)!;
    expect(probe).toMatchObject({ url: 'https://api-m.paypal.com/v1/payments/payouts', method: 'POST' });
    // Nobody can be paid by it.
    expect((probe.body as { items: unknown[] }).items).toEqual([]);
    expect((probe.body as { sender_batch_header: { sender_batch_id: string } }).sender_batch_header.sender_batch_id).toMatch(/^PATROLKITPROBE\d+$/);
  });

  it('fails when PayPal only lets the app look, not send — the first live run', async () => {
    const { client } = harness({ token: LIVE_TOKEN, probe: { status: 403, body: { name: 'AUTHORIZATION_ERROR', debug_id: '49aed1c45570d' } } });
    const result = await client.testConnection('org-1');
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/refused to let this app use Payouts/);
    expect(result.message).toMatch(/49aed1c45570d/);
  });

  it('does not pass on an answer it does not expect', async () => {
    const { client } = harness({ token: LIVE_TOKEN, probe: { status: 404 } });
    await expect(client.testConnection('org-1')).resolves.toMatchObject({ success: false });
  });

  it('passes whatever the scopes are called — it does not read them', async () => {
    const { client } = harness({
      token: { status: 200, body: { access_token: 't', expires_in: 32000, scope: 'openid' } },
      probe: { status: 400 },
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
    const { client, calls } = harness({ token: LIVE_TOKEN, probe: { status: 400 } });
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
