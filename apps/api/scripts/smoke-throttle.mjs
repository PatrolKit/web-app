// Rate limiting keys on the client, not on the proxy in front of us.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-throttle.mjs
//
// Caddy forwards every request from loopback, so without `trust proxy` the
// throttle saw one address for the whole site: one sign-in budget for the
// entire world. One busy check-in table would have locked out every other.
//
// This drives the sign-in endpoint from two forwarded addresses and asserts
// that exhausting one leaves the other alone. It sends from loopback with an
// X-Forwarded-For header, which is exactly what Caddy does.
//
// It uses made-up forwarded addresses, so it never spends the budget other
// smoke scripts sign in from — those arrive with no header and get the
// loopback bucket of their own.

const BASE = process.env.SMOKE_BASE ?? 'http://localhost:4001/api/v1';

let failures = 0;
const ok = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? ' — ' + extra : ''}`);
};

// Fresh addresses every run, so a second run inside the minute is not
// reading the first run's leftover bucket.
const rand = () => Math.floor(Math.random() * 250) + 2;
const A = `203.0.113.${rand()}`;
const B = `198.51.100.${rand()}`;

const signIn = (from) =>
  fetch(`${BASE}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': from },
    body: JSON.stringify({ email: 'throttle-smoke@patrolkit.invalid' }),
  });

// The number comes from the server rather than from here, so this does not
// drift when the limit does (Plan 26 keeps them all in one registry).
const fromA = [];
let limit = Infinity;
for (let i = 0; i <= Math.min(limit, 500); i++) {
  const res = await signIn(A);
  fromA.push(res.status);
  if (i === 0) limit = Number(res.headers.get('x-ratelimit-limit'));
  if (res.status === 429) break;
}
const allowed = fromA.filter((s) => s < 400).length;

ok('one client is allowed its full limit of sign-in attempts',
  Number.isFinite(limit) && allowed === limit, `${allowed} allowed of ${limit}`);
ok('...and refused the next', fromA.at(-1) === 429, `last HTTP ${fromA.at(-1)}`);

// The half that was broken. Before the fix this was 429: B had never asked
// for anything, and was locked out because A had.
const fromB = await signIn(B);
ok('a different client is unaffected by the first one\'s limit', fromB.status < 400,
  `HTTP ${fromB.status}`);

const blocked = await signIn(A);
const retryAfter = blocked.headers.get('retry-after');
ok('a refused client is told when to come back', blocked.status === 429 && !!retryAfter,
  `HTTP ${blocked.status}, Retry-After ${retryAfter}`);

console.log(failures ? `\n${failures} failing assertion(s)` : '\nAll assertions passed');
process.exit(failures ? 1 : 0);
