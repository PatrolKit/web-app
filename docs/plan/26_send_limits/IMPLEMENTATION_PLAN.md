# Plan 26 — Limits that fit a venue

Two requirements, and they pull against each other: **no limit may be the only
thing between an attacker and something that matters**, and **no limit may be
hit by a real swap**. The per-IP limits we have today fail both. They are the
only guard on several things that matter, and at a venue they are shared by
everybody in the building.

This plan moves each protection to the key that actually bounds the attack — the
person being sent to, the code being guessed, the account making the request —
so that per-IP limits stop carrying security weight and can be sized for a
crowd. The sizing comes from measured traffic, with the assumptions written down
and a load test that proves them. A Server health tab then records how close
real traffic comes to every limit, so the assumptions keep being checked.

Scope is the server and two web changes: the check-in code screen (§9) and the
Server health tab (§11). The iPad reads two new error codes on staff
verification — `TOO_MANY_CODES` and `CANNOT_TEXT` — and should already honor
`Retry-After`.

---

## 1. Decisions

| | |
|---|---|
| **Codes to one person** | Limited per destination: 5 per 15 minutes, 10 per day. §5 |
| **Guessing a code** | Bounded per person by §5 × 5 attempts: 25 per 15 minutes, 50 a day, from any number of addresses. §4 |
| **A refused login** | Silent — the same decoy an unknown contact gets. Never an oracle. §5 |
| **Receipts a seller sends themselves** | Limited per destination: 3 per hour. §6 |
| **Where SMS can go** | +1 numbers only. §7 |
| **SMS spend** | A site-wide ceiling of 6,000 an hour, plus an AWS spend limit. §7 |
| **Authenticated requests** | Limited per account or device, 600 a minute. §8 |
| **Unauthenticated requests** | Limited per IP, sized at 3× a modeled rush. §8 |
| **Knowing before we hit one** | Every key logs a warning at half its limit. §10 |
| **Seeing it over time** | A Server health tab in Platform Admin: every limit, its peak, where, and when. Hourly, kept 90 days. §11 |

---

## 2. What is there today

Every code sent to a person goes through `ContactChallengeService.issue()`
(`auth/contact-challenge.service.ts`), from five callers: sign-in, self check-in
registration, staff-initiated verification in ski swap and in time clock, and
business-seller invitations. It sends every time it is asked. Nothing counts how
many have gone to one destination.

Confirming a code allows `MAX_ATTEMPTS = 5` wrong guesses per challenge, and
issuing a new challenge starts a new count. So the only bound on guessing a
person's code is how fast new codes can be issued — today, the per-IP limit.

Receipts are the other path that sends. A seller's own
`POST /seller/me/receipts/send` is limited to 3 per hour per IP.

`normalizePhone` accepts any `+` number, and `SmsService` sends to whatever it
is given. SMS is suppressed everywhere today because no origination number is
registered. **Everything SMS-related below becomes live the day the toll-free
registration is approved.**

Every limit is per IP, and since `1d879ae` the IP is the client's real address —
which at a swap is the venue's, shared by every phone and iPad on its wifi. The
throttle is held in memory; production runs one process.

---

## 3. What a swap actually sends

Measured on 2026-09-23 by driving one complete self check-in through the web
app — sign-up, code, name, address, payout, three items, finish — and counting
every request in the API log.

| Bucket | Requests | Grows with |
|---|---|---|
| register | 1 | +1 per code re-sent |
| confirm | 1 | +1 per mistyped code |
| check-in page (public) | 1 | +1 per page reload |
| refresh | 3 | about constant under 15 minutes |
| **everything else** | **18** | **+3.3 per item, +1 per photo** |

The 18 break down as: 5 summary refreshes, 3 profile saves, 3 category loads, 3
item creates, 2 `/me`, 1 join, 1 finish. Bridges and scanners are exempt from
throttling and are not counted.

### The model

Deliberately generous at every step, because the requirement is that nobody is
refused:

- **A heavy seller**: 15 items with a photo on each, two codes re-sent, two
  codes mistyped, three page reloads. That is 3 register, 3 confirm, 4 page
  loads, 4 refreshes, and about **72** everything-else requests over roughly
  eight minutes — twenty a minute at the fastest a person can add items.
- **A rush**: **20 sellers arriving per minute**, sustained. A 300-seller swap
  averages about two a minute, so this is a tenfold doors-open queue.
- **Everybody on the venue's wifi.** The worst case for anything keyed by IP.
- **Limits at 3× the rush**, so a rush half again as bad as modeled is still
  nowhere near them.

| Per venue IP, in a rush minute | Load | 3× | Limit |
|---|---|---|---|
| register | 60 | 180 | **200** |
| confirm | 60 | 180 | **200** |
| check-in page | 80 | 240 | **250** |
| refresh | 80 | 240 | **250** |

Authenticated traffic is not in this table, because §8 stops keying it by IP.

---

## 4. Where each protection now comes from

The point of this plan is that the right-hand column no longer mentions IPs.

| Threat | Today, bounded by | After, bounded by |
|---|---|---|
| Guessing a six-digit code | per-IP issue rate × 5 | §5 × 5 attempts: ≤25 per person per 15 minutes, ≤50 a day, however many addresses |
| Flooding one person with codes | per-IP; unbounded with rotation | §5 per destination |
| Flooding one person with receipts | 3/hour per IP | §6 per destination |
| Learning whether an account exists | the login decoy | the decoy, kept intact by §5's silent refusal |
| SMS pumping | per-IP | §7: +1 only, 6,000/hour site-wide, AWS spend limit |
| A runaway or hostile signed-in client | 100/min per venue | §8: 600/min per account or device |
| Forging a token to get a fresh bucket | — | §8: a token that does not verify is keyed by IP |
| Junk accounts from registration | per-IP | per-IP, now 200/min. Unverified accounts grant nothing; see §14 |

Fifty guesses a day against 900,000 codes is about one in eighteen thousand per
person per day, and the person being targeted is receiving the codes and can see
it happening. Email codes are 32 random bytes and cannot be guessed at any rate.

---

## 5. Codes: limited per destination

In `ContactChallengeService.issue()`, before creating a challenge, count those
already created for the same `target`: at most **5 in the last 15 minutes** (the
lifetime of a code) and **10 in the last 24 hours**. Counted across purposes;
superseded challenges count, because they were sent. Stored in the existing
table, with a new `@@index([target, createdAt])`.

**Not hit by a real seller.** The busiest legitimate case is a sign-up, two
re-sends when a text is slow, and staff re-sending a verification at the counter:
four. §9 stops a seller whose texts are not arriving from tapping re-send a
fifth time.

**At the limit:**

- **Login refuses silently**, returning the decoy an unknown contact gets and
  sending nothing. Unknown contacts never create rows, so only a real account
  can be limited, and an honest refusal would announce the account exists.
- **Registration and staff verification refuse openly**: `429`,
  `code: "TOO_MANY_CODES"`, *"Too many codes have been sent to this number
  recently. Try again in a few minutes."* Both always create or resolve a user,
  so the refusal tells an attacker nothing they did not just cause.

Counting then inserting is not atomic, so simultaneous requests can overshoot by
the number arriving together. Accepted: the limit bounds volume, not an exact
count. A silent login refusal costs one count query that a decoy does not — a
few milliseconds, inside network jitter.

---

## 6. Receipts: limited per destination

The same rule in `ReceiptService.send` for the seller's own
`POST /seller/me/receipts/send`: at most **3 per hour to one destination**,
counted from `ReceiptDelivery`, refused with `429 TOO_MANY_RECEIPTS`. A seller
taps it once or twice. Staff sends are not counted.

---

## 7. SMS: where it can go, and how much

**+1 only.** `SmsService.send` suppresses any destination that is not `+1`
followed by ten digits, with the reason *"SMS is only sent to US and Canadian
numbers"*. Enforced at send rather than in `normalizePhone`, so an international
seller's number can still be stored and matched. A toll-free number can only
reach North America anyway; this states it rather than relying on the carrier,
and keeps premium-rate international numbers out regardless.

Registration picks phone first today. It becomes: **phone if it is +1, otherwise
email; if only a non-+1 phone was given, refuse** — `400 CANNOT_TEXT`, *"We can
only text US and Canadian numbers. Use an email address instead."* Staff
verification by phone refuses the same way, at the counter, rather than sending
a code that never arrives.

**A site-wide ceiling: 6,000 texts an hour**, counted from `ContactChallenge`
rows with `channel = 'phone'` plus SMS receipt deliveries. Past it, SMS is
suppressed with the reason *"Texting is paused"*, registration falls back to
email or refuses as above, and an error is logged. The modeled rush sends at
most 60 codes a minute — 3,600 an hour, if every seller re-sent twice — so this
is well clear of a real swap and caps a cost-griefing attack at about $50 an
hour.

**The backstop is an AWS spend limit** (§13). The ceiling limits how fast money
can be spent; the spend limit limits how much.

---

## 8. Requests: keyed by who is asking

A custom `ThrottlerGuard` overriding `getTracker`:

- A bearer token that **verifies** as a user → `user:<id>`.
- One that verifies as a device → `device:<id>`.
- Anything else — no token, an expired one, a forged one → `ip:<address>`.

The throttle runs before the auth guards, so it verifies the token itself. Both
kinds are JWTs checked without a database lookup, so this is cheap. A token that
does not verify gets the IP bucket, so forging one buys nothing.

**Per account or device: 600 a minute, per route.** The throttle counts each
route separately — the library keys a bucket by handler as well as by caller —
so this is 600 for one account on one route, not 600 across everything it does.
The busiest legitimate clients:

| Client | Peak per minute |
|---|---|
| A seller adding items as fast as they can | ~20 |
| An iPad: sync, a verification being polled, staff-assisted check-in | ~50 |
| A staff browser | ~30 |
| An iPad draining an offline queue after reconnecting | a burst of a few hundred |

600 is 12× the busiest steady client, and a drained queue that exceeds it is
slowed by `Retry-After` rather than dropped — the queue retries. It still stops
a client stuck in a tight loop.

**Per IP, for what has no token:**

| Route | Today | After |
|---|---|---|
| `POST /public/checkin/:swapId/register` | 5/min | 200/min |
| `public/checkin/:swapId` (the rest) | 20/min | 250/min |
| `POST /auth/challenges/:id/confirm` | 10/min | 200/min |
| `POST /auth/refresh` | 20/min | 250/min |
| `POST /auth/login` | 5/min | 60/min |
| `public/sellers`, `public/lookup`, public receipt | 20/min | 200/min |
| `POST /auth/device/token` | 20/min | unchanged |
| everything else with no token | 100/min | 300/min |

Confirm can rise to 200 because §5 bounds guesses per person: however many
confirm requests a venue makes, no one person's code gets more than 25 guesses
in its lifetime.

`POST /seller/me/receipts/send` is authenticated, so it moves to the per-account
bucket; §6 carries its real limit.

---

## 9. Web: a way out before the limit

On the check-in code screen, after a second re-send, offer **"Use an email
address instead"** beside re-send. A seller whose texts are not arriving — a
dead zone in the lodge, a carrier delay — gets somewhere to go on the third tap
instead of meeting §5 on the sixth.

---

## 10. Knowing before we hit one

The `ThrottlerGuard` subclass also overrides `handleRequest`: when a key crosses
**half** its limit within a window, it logs one warning naming the route, the
kind of key and the count. Once per key per window, not per request.

The model in §3 is an estimate. This is how the first real swap corrects it:
the numbers arrive in the log at half the limit, long before anyone is refused.

---

## 11. Seeing it: the Server health tab

A tab in Platform Admin, beside Organizations, Users, Device Software and Item
Details, that lists every limit in this plan and shows how close real traffic
has come to each, over time and by where it came from. The half-limit warning
(§10) is the moment; this is the record.

### One list of limits

Every limit lives in one registry — `common/limits/limits.ts` — with its id,
label, value, window, and what it is keyed by. The `@Throttle` decorators, the
per-destination checks (§5, §6) and the SMS ceiling (§7) read their numbers from
it, and the health page lists it. Otherwise the page and the code are two copies
of one table, and they drift the first time a number changes in one of them.

### What is recorded

Counts, never keys. No IP address, user id, device id, phone number or email is
stored.

Per limit, per hour, per org and swap:

| Column | Meaning |
|---|---|
| `peakHits` | the most any single key reached within one window |
| `limitValue` | the limit in force — limits change, and a peak only means something against the number it was measured against. Not `limit`, which MySQL reserves |
| `nearCount` | how many keys crossed half |
| `refusedCount` | how many requests were refused |

**Attribution**, where the request carries one: the `orgId` in the route; for
public check-in routes, the org of the route's `swapId` (cached in memory); a
device token's `orgId`. Anything without one — sign-in, refresh,
`auth/device/token` — is recorded as platform-wide.

Platform-wide is an **empty string, not NULL**. MySQL allows any number of NULLs
in a unique index, which this schema uses on purpose elsewhere (`liveSku`,
`activeSkuPrefix`); here it would let two flushes of the same platform-wide hour
land as two rows instead of one.

### How it is written

The `ThrottlerGuard` subclass (§8, §10) sees the hit count, the limit and the
key on every request; §5, §6 and §7 see theirs at the point they count. Each
feeds an in-memory accumulator keyed by `(limit, hour, org, swap)` that keeps
the maximum and adds the counts.

A flush every minute writes it with
`INSERT … ON DUPLICATE KEY UPDATE peakHits = GREATEST(peakHits, VALUES(peakHits))`,
so a flush can never lower a peak. The server gains `enableShutdownHooks()` so a
`pm2` restart flushes on the way down. A crash loses at most one minute, which
is acceptable for a record of peaks.

Each flush also deletes rows older than 90 days. At a handful of rows per limit
per hour, that is tens of thousands of rows, not millions.

### The API

Behind `SuperAdminGuard`, like the rest of Platform Admin.

- `GET /admin/health/limits?range=24h|7d|30d|90d` — every limit in the
  registry, with its current value, the peak in the range as a percentage of the
  limit that applied, when, where (org and swap by name), how often a key
  crossed half, and how many requests were refused. The unflushed minute is
  merged in, so "right now" is right now.
- `GET /admin/health/limits/:id/series?range=…` — the peak percentage over the
  range, hourly for 24 hours and 7 days, daily beyond, with the orgs and swaps
  that came closest.

### The page

`/dashboard/admin/health`, labeled **Server health**.

- **A range selector**: 24 hours, 7 days, 30 days, 90 days.
- **A table, one row per limit**: name, keyed by, value, peak as a bar colored
  green under 50%, amber to 80%, red above, when and where it happened, crossings
  of half, refusals. Sorted by peak, highest first.
- **Refusals are the loudest thing on the page.** A refusal means somebody real
  was told no; any non-zero count is highlighted, whatever the peak says.
- **A row opens** onto its chart — peak percentage over the range, with lines at
  50% and 100% — and the orgs and swaps that came closest.
- **Empty is said as empty**: *"No traffic recorded in this range"* rather than a
  row of zeroes that reads as "fine".

The chart is a small inline SVG. The web app has no charting library, and one
chart with two reference lines does not justify adding one.

---

## 12. Not in this plan

- **Shared throttle storage.** In memory is correct while production is one
  process. More than one would need Redis.
- **CAPTCHA on registration.** Not in front of somebody holding a pair of skis.
- **Edge rate limiting.** Denial of service by volume belongs in front of the
  application, and was never the throttle's job.
- **The rest of server health.** The tab is named for it so database, memory and
  error rates have somewhere to go, but they are a different plan.

---

## 13. Outside the code

- **An AWS SMS monthly spend limit.** New accounts default to $1 a month, which
  may already be in place. Set it deliberately before SMS goes live.

---

## 14. Later

- **Cleaning up accounts that were never verified.** Registration creates a user
  for any contact, and an unverified user grants nothing, but they accumulate.
  A periodic sweep of unverified users older than a week with nothing attached.

---

## 15. Testing

**Unit**
- `issue()`: the sixth code to one target inside 15 minutes is refused; a second
  target is unaffected; superseded challenges count; the daily limit holds.
- A limited login returns a decoy indistinguishable from an unknown contact's,
  compared against the real decoy rather than a hand-written expectation.
- `SmsService`: a non-+1 number is suppressed; the site-wide ceiling suppresses
  and logs.
- `getTracker`: a valid user token keys by user, a device token by device, an
  expired or forged one by IP.
- The half-limit warning fires once per key per window.
- Every `@Throttle` value and per-destination limit comes from the registry: a
  coverage test fails on a literal limit written anywhere else.
- The accumulator keeps the maximum and adds the counts; a flush cannot lower a
  stored peak; two flushes of the same platform-wide hour produce one row.
- No recorded row contains a key — no IP, id, phone number or email.
- The health endpoints refuse anybody who is not a super admin.

**Smoke** (`smoke-send-limits.mjs`)
- Flood one destination from rotating addresses: the sixth code is refused
  whatever the address.
- A limited login looks exactly like an unknown one.
- Two signed-in clients behind one IP each get their own 600.

**Load** (`load-venue-rush.mjs`) — the test that the model holds

Replays the measured check-in pattern from §3, as heavy sellers, twenty arriving
a minute, all from one forwarded address, for five minutes. **Asserts zero
429s.** Then doubles the arrival rate and reports where the first refusal lands,
so the headroom is a number we have seen rather than one we computed.

Finally it reads `GET /admin/health/limits` and asserts the rush is there, at
roughly the percentage §3 predicts and attributed to the test swap — so the page
is proved to show what happened, not merely to render.

---

## 16. Order

1. §5, §6 and §9 — per-destination limits, and the way out on the code screen.
   The limit registry (§11) starts here, so no step writes a literal limit.
2. §7 — +1 only and the SMS ceiling.
3. §13 — the AWS spend limit, by hand.
4. §8, §10 and the rest of §11 — keyed by who is asking, the half-limit warning,
   and the Server health tab. The tab goes in with the guard it reads from, so
   the raised numbers in step 5 are watched from the moment they land.
5. §8's per-IP numbers — raised.

1–3 before SMS goes live. Step 5 is the only one unsafe without what comes
before it. The load test runs against step 5 before the first swap.

