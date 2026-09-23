// Rate limiting keys on the client, not on the proxy in front of us.
//
//   PORT=4001 node apps/api/dist/src/main.js &
//   node apps/api/scripts/smoke-throttle.mjs
//
// Caddy forwards every request from loopback, so without `trust proxy` the
// throttle saw one address for the whole site: a hundred requests a minute
// for everybody combined, and five sign-in requests a minute for the entire
// world. One busy check-in table would have locked out every other.
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

const fromA = [];
for (let i = 0; i < 7; i++) fromA.push((await signIn(A)).status);

ok('one client is allowed its five sign-in attempts',
  fromA.slice(0, 5).every((s) => s < 400), fromA.join(' '));
ok('...and refused the sixth', fromA[5] === 429, fromA.join(' '));

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
