# Shared Expenses App

A Splitwise-style shared-expenses tracker built for the Spreetail take-home assignment.
Track group expenses with multiple split types, derive who-owes-whom balances, record
settlements, and import expense history from CSV with full anomaly detection and a
downloadable import report.

**Live demo:** https://web-production-e3ec7.up.railway.app · **Demo credentials:**
`alice@example.com` / `password123` (also `bob@` and `carol@example.com`)

## Features

- 🔐 Email/password auth (NextAuth credentials, bcrypt)
- 👥 Groups with dynamic membership — join/leave with full history (`joined_at`/`left_at`)
- 💸 Expenses with **equal / exact / percentage** splits; server-validated, transactional
- ⚖️ Balances derived on read (never stored): per-member net, pairwise debts, optional
  debt simplification — with a `Σ net == 0` integrity assertion
- 🤝 Settlements as ledger entries; overpayment legitimately flips the debt direction
- 📥 CSV import: validate-everything-first → preview → transactional commit →
  **persisted, downloadable Import Report**; idempotent re-uploads via row hashing
- 🚨 21 anomaly classes detected and policy-handled — see [SCOPE.md](SCOPE.md)

## Stack

Next.js (App Router, TypeScript) · Prisma · PostgreSQL (Railway in production, Prisma
local Postgres in dev) · Tailwind v4 · NextAuth (credentials) · Vitest · deployed on
Railway (app + database in one project, migrations run on every deploy via
`preDeployCommand`). Rationale for every choice: [DECISIONS.md](DECISIONS.md).

## Documentation

| Doc | What's in it |
|---|---|
| [SCOPE.md](SCOPE.md) | in/out of scope + the full anomaly policy catalog (detection, message, action, why, alternatives) |
| [DECISIONS.md](DECISIONS.md) | every major decision with options considered and tradeoffs |
| [AI_USAGE.md](AI_USAGE.md) | AI tools, prompts, and a log of incorrect/risky AI output with corrections |
| [docs/DESIGN.md](docs/DESIGN.md) | user flows, screens, schema, API, auth flow, balance algorithm |
| [docs/ROADMAP.md](docs/ROADMAP.md) | commit-by-commit implementation plan |

## Money-handling guarantees

1. All amounts are **integer cents** end-to-end — no floating point ever touches money.
2. Splits always sum exactly to the expense total (largest-remainder rounding,
   deterministic remainder assignment).
3. Group nets always sum to zero — asserted in code on every balance read.
4. Imports never silently alter an amount or guess an identity; every CSV row is
   accounted for in the report (imported / flagged / rejected / duplicate).

## Local setup

```bash
git clone <repo> && cd splitwise-clone
npm install
cp .env.example .env        # then fill DATABASE_URL + AUTH_SECRET (see below)
npm run db:dev              # local Postgres via Prisma — keep running; paste its
                            # URL into .env (use 127.0.0.1, add &pgbouncer=true)
npx prisma db push          # create schema locally
npx prisma db execute --schema prisma/schema.prisma \
  --file prisma/migrations/20260613000001_add_check_constraints/migration.sql
npm run db:seed             # demo users + group + expenses
npm run dev                 # http://localhost:3000
npm test                    # balance engine + CSV validator suites (55 tests)
node scripts/smoke.mjs      # end-to-end smoke test against the running dev server
```

Demo logins after seeding: `alice@example.com` / `bob@example.com` / `carol@example.com`,
password `password123`. A sample CSV full of anomalies for the import demo:
[public/sample-import.csv](public/sample-import.csv).

> Production uses `prisma migrate deploy` with the committed `prisma/migrations/`;
> `db push` is local-dev-only because the local Prisma Postgres server can't host
> `migrate dev`'s shadow database.

## Import report

Each upload creates an `import_batch`; every source row is persisted with its original
raw line, outcome, and machine-readable reason codes. The report is viewable in-app and
downloadable as CSV/JSON. Re-uploading a file is safe: previously imported rows are
detected by content hash and skipped.
