import { ContactChallengeService, type ChallengePurpose } from './contact-challenge.service';

/**
 * Which email each kind of challenge actually sends.
 *
 * All three used to be one branch on `invite`, so `login` and `verify` shared
 * the sign-in template: somebody asked at a counter to confirm an address
 * received "Your sign-in link", tapped "Sign in", and was told their contact
 * was verified instead. A verification template existed the whole time and
 * nothing called it — which is exactly the kind of thing that survives a
 * reading of either file on its own.
 *
 * So this walks the dispatcher rather than the branch.
 */
describe('which email a challenge sends', () => {
  function harness() {
    const sent: { which: string; url: string; brand?: { name: string } }[] = [];

    const mail = {
      sendMagicLink: async (_to: string, url: string, brand?: { name: string }) => {
        sent.push({ which: 'magicLink', url, brand });
        return { status: 'sent' as const };
      },
      sendVerificationEmail: async (_to: string, url: string, brand?: { name: string }) => {
        sent.push({ which: 'verification', url, brand });
        return { status: 'sent' as const };
      },
      sendSellerInvite: async (_to: string, url: string) => {
        sent.push({ which: 'invite', url });
        return { status: 'sent' as const };
      },
    };

    const service = new ContactChallengeService(
      { membership: { findMany: async () => [] } } as unknown as never,
      mail as unknown as never,
      { send: async () => ({ status: 'sent' }) } as unknown as never,
      { get: (k: string, d?: unknown) => (k === 'app.appUrl' ? 'https://patrolkit.io' : d) } as unknown as never,
      { record: () => undefined } as unknown as never,
      {} as never,
    );

    /** `dispatch` is private to the service and public to its behaviour. */
    const dispatch = (purpose: ChallengePurpose, brand?: { name: string; logoUrl: string | null }) =>
      (service as unknown as { dispatch: (p: Record<string, unknown>) => Promise<void> }).dispatch({
        challengeId: 'chal-1',
        channel: 'email',
        target: 'someone@example.com',
        rawCode: 'code-1',
        purpose,
        orgName: 'Stowe Ski Patrol',
        context: null,
        brand,
      });

    return { sent, dispatch };
  }

  it('sends the sign-in email for a sign-in', async () => {
    const { sent, dispatch } = harness();
    await dispatch('login');
    expect(sent[0].which).toBe('magicLink');
  });

  it('sends the verification email for a verification', async () => {
    const { sent, dispatch } = harness();
    await dispatch('verify');
    expect(sent[0].which).toBe('verification');
  });

  it('sends the invitation for an invitation', async () => {
    const { sent, dispatch } = harness();
    await dispatch('invite');
    expect(sent[0].which).toBe('invite');
  });

  it('carries the club through to a verification, not only to a sign-in', async () => {
    // Staff at a counter ask a seller to confirm an address. The seller is
    // expecting to hear from the club, not from the software it runs.
    const { sent, dispatch } = harness();
    const brand = { name: 'Stowe Ski Patrol', logoUrl: null };
    await dispatch('verify', brand);
    // Both halves. The sign-in email takes a brand too, so asserting only that
    // one arrived passes just as well when the wrong template sent it — which
    // is exactly the state this whole spec exists to catch.
    expect(sent[0]).toMatchObject({ which: 'verification', brand });
  });

  it('marks a verification link so the page can say what it is for', async () => {
    // The page cannot tell a sign-in from a confirmation until it has spent the
    // challenge, so without this everybody is greeted with "Sign in" and only
    // afterwards told some of them were confirming an address.
    const { sent, dispatch } = harness();
    await dispatch('verify');
    expect(sent[0].url).toContain('p=verify');
  });

  it('leaves a sign-in link unmarked', async () => {
    const { sent, dispatch } = harness();
    await dispatch('login');
    expect(sent[0].url).not.toContain('p=verify');
  });
});
