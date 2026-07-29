# Testing — Demo Users

All users below are seeded by `pnpm --filter api prisma db seed` (dev only).
Sign in via the magic-link flow at `/app/auth/login`. In local dev, the link is delivered to **Mailpit** at `http://localhost:8025`.

## Organization: Demo Org (`demo-org`)

| Email | Name | Permissions |
|---|---|---|
| `admin@example.com` | Super Admin | All permissions + `isSuperAdmin` |
| `swap-reporter@example.com` | Swap Reporter | `ski_swap:report` |
| `swap-manager@example.com` | Swap Manager | `ski_swap:report`, `ski_swap:manage` |
| `swap-admin@example.com` | Swap Admin | `ski_swap:report`, `ski_swap:manage`, `ski_swap:admin` |

## Notes

- `SEED_SUPERADMIN_EMAIL` in `.env` controls which email is promoted to super admin on seed. Defaults to `admin@example.com`.
- The **Ski Swap** module is enabled for Demo Org by default in dev.
- Square credentials are **not** seeded — a `ski_swap:admin` user must configure them via the Square Config tab before creating swaps.
