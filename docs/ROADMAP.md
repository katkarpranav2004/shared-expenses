# ROADMAP.md — Commit-by-Commit Implementation Plan

Each commit is a coherent, reviewable unit that leaves the app working. The sequence is
deliberately **domain-logic-first**: the balance engine and CSV validator exist (with
tests) before most of the UI, because that's where the grading risk is.

> Interview-safety rule: never commit code you can't explain. If an AI-generated chunk
> isn't fully understood, it gets rewritten or studied before commit — and incidents go
> in AI_USAGE.md.

| # | Commit | Contents | Definition of done |
|---|---|---|---|
| 1 | `chore: scaffold Next.js + Tailwind + Prisma` | create-next-app (TS, App Router), Tailwind, shadcn/ui init, Prisma init, README skeleton, .env.example | `npm run dev` shows styled landing page |
| 2 | `feat: database schema + migrations` | full Prisma schema (DESIGN.md §4), raw-SQL migration for CHECK constraints, seed script (2 users, 1 group, 3 expenses) | `prisma migrate dev` + seed runs clean; can walk the ERD from memory |
| 3 | `feat: auth (register, login, session)` | NextAuth credentials, bcrypt, register route + zod, login/register pages, route protection middleware | new user can register, log in, land on empty dashboard; wrong password gets generic error |
| 4 | `feat: groups + dynamic membership` | group CRUD, add-member-by-email, leave flow (settle-first check **stubbed true** with TODO), dashboard group list | two seeded users share a group; member list shows joined dates |
| 5 | `feat: balance engine (pure, tested)` | `lib/balances.ts` — net, pairwise, largest-remainder split math, `Σ net == 0` assert; Vitest suite incl. `100/3`, settlements, member-left cases | tests green; **no UI in this commit** — pure functions only |
| 6 | `feat: expenses with EQUAL split` | expense create form + route (server recomputes splits, txn), expense feed | add $100 dinner for 3 → DB shows 3334/3333/3333 |
| 7 | `feat: EXACT + PERCENTAGE splits` | split-type switcher UI with live remainder display, server validation (sum==total, pct==100±0.01), edit/delete | tampered payload (client splits ≠ total) rejected with `SPLIT_SUM_MISMATCH` |
| 8 | `feat: balances UI + settlements` | balances tab (net + pairwise), settle-up flow, simplify-debts toggle (display-only), un-stub leave check from commit 4 | settle full debt → pair shows zero; leave now truly blocked when unsettled |
| 9 | `feat: CSV validator (pure, tested)` | `lib/import/validate.ts` — RFC-4180 parse, normalization pass, every SCOPE.md anomaly code, row hashing; fixture CSVs incl. a kitchen-sink anomalies file | one test per anomaly code A1–A21; validator has zero framework imports |
| 10 | `feat: import pipeline + report` | upload route → validate → preview screen → confirm route (txn) → `import_batches`/`import_rows` persisted → report page + CSV/JSON download | kitchen-sink fixture: every row accounted for; re-upload imports 0 (idempotent) |
| 11 | `test: integration + edge-case hardening` | authz tests (foreign-group 403s), membership-timing import cases, near-duplicate flagging, empty-file/headers-only/10k-row import | suite green; this commit's diff is mostly `*.test.ts` |
| 12 | `docs: SCOPE, DECISIONS, AI_USAGE finalized` | reconcile docs against real CSV findings (update SCOPE.md §3 banner!), fill real AI incidents, README usage + screenshots | docs match shipped behavior exactly — graders diff these |
| 13 | `chore: production deployment` | Neon DB, Vercel project, env vars, `prisma migrate deploy` in build, seed demo data, demo credentials in README | public URL: register → group → expense → import → report works end-to-end |
| 14 | `fix: post-deploy polish` | whatever production surfaces (cold-start, cookie domain, serverless function size) | clean run-through recorded; final README pass |

## Time-boxing (suggested)

- **Day 1:** commits 1–4 (plumbing — go fast, this isn't graded hard)
- **Day 2:** commits 5–8 (the money core — go slow, hand-verify arithmetic)
- **Day 3:** commits 9–10 (the import core — the assignment's centerpiece)
- **Day 4:** commits 11–14 (hardening, docs honesty pass, deploy, dry-run the demo)

## Demo script (rehearse before submitting)

1. Register fresh user → create group → add demo member.
2. Add one expense per split type; show the 1-cent remainder landing deterministically.
3. Show balances; record a settlement; show it zero out.
4. Import the anomalies CSV → walk the preview → confirm → open the report → download it.
5. Re-upload the same file → show 0 imported (idempotency) — **this is the mic-drop step**.
6. Try to leave the group while owing money → blocked → settle → leave succeeds.
