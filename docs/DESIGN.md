# DESIGN.md — Product & System Design

> Spreetail Shared Expenses App. This document covers user flows, screens, data model,
> API design, and the authentication flow. Every choice here has a corresponding entry
> in [DECISIONS.md](../DECISIONS.md).

---

## 1. Tech Stack

| Layer | Choice | Why (one line — full reasoning in DECISIONS.md) |
|---|---|---|
| Framework | **Next.js 14+ (App Router, TypeScript)** | One repo, one deploy, API routes + SSR pages; fastest path to a professional result |
| UI | **Tailwind CSS + shadcn/ui** | Polished look with near-zero custom CSS |
| ORM | **Prisma** | Type-safe schema-as-code, migrations are reviewable artifacts |
| Database | **PostgreSQL (Neon free tier)** | Relational (required), real constraints, free public hosting |
| Auth | **NextAuth (Credentials provider) + bcrypt** | Session-based auth without rolling our own token crypto |
| Deployment | **Vercel (app) + Neon (DB)** | Public URL in minutes, free tier, zero-ops |
| Testing | **Vitest** | Fast unit tests for the balance engine and CSV validator |

---

## 2. User Flows

### 2.1 Onboarding
1. Visitor lands on `/` → marketing-lite landing with Login / Register.
2. Register: name, email, password → auto-login → redirected to `/dashboard`.
3. Login: email + password → `/dashboard`.

### 2.2 Group lifecycle
1. Dashboard lists "My Groups" with per-group net balance badge.
2. Create group: name (+ optional description) → creator becomes member (role: admin).
3. Add member: by registered email (MVP) — adds a `group_members` row with `joined_at = now()`.
4. Leave group: allowed **only if the member's net balance in the group is 0** — otherwise
   blocked with "Settle up before leaving" (see DECISIONS.md #6). Leaving sets `left_at`,
   never deletes the row — history must survive.

### 2.3 Expense lifecycle
1. Inside a group → "Add expense": description, amount, date, paid-by, split type.
2. Split types:
   - **EQUAL** — among selected participants (default: all current members).
   - **EXACT** — per-participant amounts; client + server validate sum == total.
   - **PERCENTAGE** — per-participant %; validate sum == 100.
3. On save: server recomputes the splits from raw inputs (never trusts client math),
   writes `expenses` + `expense_splits` in one transaction.
4. Edit/delete: allowed; balances are derived, so no compensating writes needed.

### 2.4 Balances & settlement
1. Group → "Balances" tab: per-member net + pairwise "A owes B $x" list.
2. Optional "Simplify debts" toggle (greedy min-cash-flow) — display-only.
3. "Settle up": record a payment from A to B (amount, date, note). It is a ledger
   entry, not a deletion of debt — balances re-derive to (near) zero.

### 2.5 CSV import
1. Group → "Import" → upload CSV → server parses and validates **every row before
   writing anything**.
2. Preview screen: counts of `valid / flagged / rejected` with per-row reasons.
3. Confirm → valid rows committed in one transaction; an **Import Report** is persisted
   (batch + per-row outcome) and downloadable as CSV/JSON.
4. Re-uploading the same file is **idempotent** — duplicate rows are detected by row
   hash against prior batches and skipped, not double-imported.

---

## 3. Screens

| Route | Screen | Key elements |
|---|---|---|
| `/` | Landing | value prop, Login/Register CTAs |
| `/login`, `/register` | Auth | forms, inline validation errors |
| `/dashboard` | Groups list | group cards w/ net balance badge, "you owe / you are owed" |
| `/groups/[id]` | Group home | expense feed (newest first), member list, tabs |
| `/groups/[id]?tab=balances` | Balances | net per member, pairwise debts, simplify toggle, Settle Up |
| `/groups/[id]/expenses/new` | Add expense | split-type switcher, live remainder display |
| `/groups/[id]/import` | CSV import | dropzone → validation preview → confirm → report |
| `/groups/[id]/imports/[batchId]` | Import report | row table filterable by outcome, download button |
| `/settings` | Profile | name, password change |

---

## 4. Database Schema (PostgreSQL via Prisma)

All money columns are **integer cents** (`Int`, range is ample for expenses). All FKs
indexed. `snake_case` table names via `@@map`.

```prisma
model User {
  id            String   @id @default(cuid())
  email         String   @unique
  name          String
  passwordHash  String
  createdAt     DateTime @default(now())
  memberships   GroupMember[]
  expensesPaid  Expense[]      @relation("payer")
  splits        ExpenseSplit[]
  settlementsFrom Settlement[] @relation("from")
  settlementsTo   Settlement[] @relation("to")
}

model Group {
  id          String   @id @default(cuid())
  name        String
  description String?
  createdById String
  createdAt   DateTime @default(now())
  members     GroupMember[]
  expenses    Expense[]
  settlements Settlement[]
  imports     ImportBatch[]
}

model GroupMember {
  id       String    @id @default(cuid())
  groupId  String
  userId   String
  role     Role      @default(MEMBER)   // ADMIN | MEMBER
  joinedAt DateTime  @default(now())
  leftAt   DateTime?                    // null = active. Soft-leave: history survives.
  group    Group @relation(fields: [groupId], references: [id])
  user     User  @relation(fields: [userId], references: [id])
  @@unique([groupId, userId])           // one active membership row per user per group (MVP: no rejoin-row-per-stint)
}

model Expense {
  id          String    @id @default(cuid())
  groupId     String
  paidById    String
  description String
  amountCents Int                       // > 0, enforced by app + DB CHECK
  date        DateTime                  // expense date (user-entered), distinct from createdAt
  splitType   SplitType                 // EQUAL | EXACT | PERCENTAGE
  createdAt   DateTime  @default(now())
  importRowId String?   @unique         // provenance: which CSV row created this, if any
  splits      ExpenseSplit[]
  group       Group @relation(fields: [groupId], references: [id])
  paidBy      User  @relation("payer", fields: [paidById], references: [id])
}

model ExpenseSplit {
  id         String @id @default(cuid())
  expenseId  String
  userId     String
  shareCents Int                        // INVARIANT: SUM(shareCents) == expense.amountCents
  expense    Expense @relation(fields: [expenseId], references: [id], onDelete: Cascade)
  user       User    @relation(fields: [userId], references: [id])
  @@unique([expenseId, userId])
}

model Settlement {
  id          String   @id @default(cuid())
  groupId     String
  fromUserId  String                    // who paid
  toUserId    String                    // who received
  amountCents Int                       // > 0
  date        DateTime
  note        String?
  createdAt   DateTime @default(now())
  group Group @relation(fields: [groupId], references: [id])
  from  User  @relation("from", fields: [fromUserId], references: [id])
  to    User  @relation("to",   fields: [toUserId],  references: [id])
}

model ImportBatch {
  id           String   @id @default(cuid())
  groupId      String
  uploadedById String
  filename     String
  totalRows    Int
  importedRows Int
  flaggedRows  Int
  rejectedRows Int
  createdAt    DateTime @default(now())
  rows         ImportRow[]
  group        Group @relation(fields: [groupId], references: [id])
}

model ImportRow {
  id        String        @id @default(cuid())
  batchId   String
  rowNumber Int                         // 1-based line in source file (header excluded)
  rawData   String                      // original CSV line, verbatim — auditability
  rowHash   String                      // sha256(normalized row) — idempotency key
  outcome   ImportOutcome               // IMPORTED | FLAGGED | REJECTED | DUPLICATE
  reasons   String[]                    // machine-readable anomaly codes, e.g. ["SPLIT_SUM_MISMATCH"]
  batch     ImportBatch @relation(fields: [batchId], references: [id])
  @@index([rowHash])
}
```

**DB-level guards** (raw SQL migration on top of Prisma):
- `CHECK (amount_cents > 0)` on `expenses` and `settlements`
- `CHECK (share_cents >= 0)` on `expense_splits`
- The split-sum invariant is enforced in the **service layer inside a transaction**
  (Postgres CHECKs can't span rows; a deferred trigger is the heavier alternative —
  see DECISIONS.md #4 note).

### Why balances have no table
Balances are **always derived**:
`net(user) = Σ(amounts they paid) − Σ(their shares) + Σ(settlements they paid out) − Σ(settlements they received)`.
Positive net ⇒ the group owes them. (Sanity check the signs: paying a settlement clears
your debt, so it raises your net; receiving one consumes what you were owed, so it lowers it.) No stored balance ⇒ no drift, no reconciliation
job, edits/deletes are trivially consistent. See DECISIONS.md #3.

---

## 5. API Design (Next.js route handlers, JSON)

All routes under `/api`, session-authenticated except auth routes. Authorization rule
checked on every group-scoped route: **caller must be an active member of the group**.

| Method & path | Purpose | Notes |
|---|---|---|
| `POST /api/auth/register` | create account | bcrypt(12) hash; generic error on dup email |
| `POST /api/auth/[...nextauth]` | login/logout/session | NextAuth credentials |
| `GET  /api/groups` | my groups + my net per group | single aggregate query |
| `POST /api/groups` | create group | creator auto-membered as ADMIN |
| `GET  /api/groups/:id` | group detail: members, expense feed | paginated expenses |
| `POST /api/groups/:id/members` | add member by email | 404-safe message, no user enumeration |
| `DELETE /api/groups/:id/members/:userId` | leave / remove | blocked unless net == 0; sets `left_at` |
| `POST /api/groups/:id/expenses` | create expense | server recomputes splits; txn |
| `PUT/DELETE /api/groups/:id/expenses/:eid` | edit / delete | payer or admin only |
| `GET  /api/groups/:id/balances` | nets + pairwise + simplified | computed on read |
| `POST /api/groups/:id/settlements` | record payment | amount > 0; both parties members |
| `POST /api/groups/:id/import` | upload CSV → validation preview | nothing written yet |
| `POST /api/groups/:id/import/:batchId/confirm` | commit valid rows | one transaction |
| `GET  /api/groups/:id/imports/:batchId` | import report | JSON; `?format=csv` for download |

**Error shape** (uniform): `{ "error": { "code": "SPLIT_SUM_MISMATCH", "message": "...", "details": {...} } }` — codes shared with the import anomaly codes in SCOPE.md so the UI and report speak one language.

---

## 6. Authentication Flow

1. **Register**: validate (zod) → `bcrypt.hash(password, 12)` → insert user →
   NextAuth `signIn()` → session cookie (HTTP-only, SameSite=Lax, Secure in prod).
2. **Login**: NextAuth Credentials provider → fetch user by email →
   `bcrypt.compare` → JWT-strategy session cookie (no session table needed; small
   scale, revocation not required for MVP — see DECISIONS.md #9).
3. **Every request**: `auth()` in route handlers; group routes additionally verify
   active membership (`left_at IS NULL`).
4. **Out of scope** (declared in SCOPE.md): OAuth providers, email verification,
   password reset, rate limiting beyond Vercel defaults.

---

## 7. Balance Engine (core algorithm)

```
For a group G:
  net[u]   = 0 for each user ever in G
  for e in expenses(G):       net[e.payer] += e.amount;  for s in e.splits: net[s.user] -= s.share
  for p in settlements(G):    net[p.from]  += p.amount;  net[p.to] -= p.amount
  INVARIANT: Σ net[u] == 0  (asserted in code; a failed assert = data corruption)
```

- **Pairwise view**: derived from per-expense splits ("for each expense, each non-payer
  participant owes the payer their share"), then netted per pair, then settlements applied
  to the pair ledger.
- **Simplified view** (optional toggle): greedy min-cash-flow — repeatedly match the
  largest debtor with the largest creditor. Minimizes number of transactions, not provably
  minimal total flow (it is, actually, for total flow — what it doesn't guarantee is
  globally minimal *edge count* in all theoretical cases; good interview nuance).

### Rounding (EQUAL and PERCENTAGE splits)
Largest-remainder method, deterministic:
1. `base = floor(amount_cents / n)` for each participant (or `floor(pct * amount)` for %).
2. Distribute the remaining `amount_cents − Σ base` cents one each to participants in a
   **stable order (user id ascending)**.
3. Result: Σ shares == total, max spread between shares is 1 cent, same input ⇒ same output.
