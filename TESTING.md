# Testing — Demo Users

All users below are seeded by `pnpm --filter api db:seed` (dev only).

## Signing in

Sign in at `/app/auth/login` with **either** an email or a phone number — both
land in the same session. Email sends a magic link; phone sends a 6-digit OTP
you enter on the page.

**Outbound notifications are off by default** (`OUTBOUND_NOTIFICATIONS=off`), so
nothing is delivered anywhere. Instead, the login response carries the code
back to you and the page displays it — that is the normal dev flow. To exercise
real delivery, set `OUTBOUND_NOTIFICATIONS=on`; email then goes to **Mailpit** at
`http://localhost:8025` while `MAIL_TRANSPORT=smtp`.

## Organization: Demo Org (`demo-org`)

| Email | Phone | Name | Permissions |
|---|---|---|---|
| `admin@example.com` | `+15550100000` | Super Admin | All permissions + `isSuperAdmin` |
| `swap-reporter@example.com` | `+15550101001` | Swap Reporter | `ski_swap:report` |
| `swap-manager@example.com` | `+15550101002` | Swap Manager | `ski_swap:report`, `ski_swap:manage` |
| `swap-admin@example.com` | `+15550101003` | Swap Admin | `ski_swap:report`, `ski_swap:manage`, `ski_swap:admin` |
| `time-reporter@example.com` | `+15550201001` | Time Reporter | `time_tracking:report` |
| `time-manager@example.com` | `+15550201002` | Time Manager | `time_tracking:report`, `time_tracking:manage` |
| `time-admin@example.com` | `+15550201003` | Time Admin | `time_tracking:report`, `time_tracking:manage`, `time_tracking:admin` |

## Demo roster (Time Tracking)

Six patrollers, deliberately varied so contact-matching and onboarding can be
exercised. NSP IDs are **globally** unique — one per human — so they double as a
matching key on import.

| NSP ID | Name | Level | Contact |
|---|---|---|---|
| 100001 | Jane Doe | Senior | email + phone |
| 100002 | John Smith | Basic | email only |
| 100003 | Maria Garcia | Certified | phone only |
| 100004 | Chen Wei | Candidate | email + phone |
| 100005 | Aisha Patel | Senior | email only |
| 100006 | Tom Anderson | Basic | **none** — the permitted contactless case |

Tom cannot log in or be paid, and bulk onboarding will skip him. That is the
intended behaviour, not a seeding gap.

## Notes

- All fixture contacts are unroutable by design: `@example.com` is reserved by
  RFC 2606 and `+1555xxxxxxx` is the reserved fictional range, so even a
  mistakenly-enabled switch cannot reach a real person.
- `SEED_SUPERADMIN_EMAIL` in `.env` controls which email is promoted to super
  admin on seed. Defaults to `admin@example.com`.
- **Ski Swap** and **Time Tracking** are enabled for Demo Org by default in dev.
- Square credentials are **not** seeded — a `ski_swap:admin` user must configure
  them via the Square Config tab before creating swaps.
- A person is one `User` row across every org and every role. Adding a seeded
  patroller as a seller by their email reuses that person rather than creating a
  second record.
