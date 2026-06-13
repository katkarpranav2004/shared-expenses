// Balance engine. Pure functions over plain data — no Prisma, no Next.js —
// so the money math is unit-testable in isolation (DECISIONS.md #1, #3).
//
// Sign convention: positive net = the group owes this user.

export type ExpenseEntry = {
  paidById: string;
  amountCents: number;
  splits: { userId: string; shareCents: number }[];
  // A refund reverses a normal expense: the payer is debited and participants
  // are credited. Modelled by flipping the sign; Σ net stays 0.
  isRefund?: boolean;
};

export type SettlementEntry = {
  fromUserId: string; // who paid
  toUserId: string; // who received
  amountCents: number;
};

export type Transfer = { fromUserId: string; toUserId: string; amountCents: number };

export function computeNets(
  expenses: ExpenseEntry[],
  settlements: SettlementEntry[],
): Map<string, number> {
  const nets = new Map<string, number>();
  const add = (userId: string, delta: number) =>
    nets.set(userId, (nets.get(userId) ?? 0) + delta);

  for (const e of expenses) {
    const sign = e.isRefund ? -1 : 1;
    add(e.paidById, sign * e.amountCents);
    for (const s of e.splits) add(s.userId, -sign * s.shareCents);
  }
  for (const p of settlements) {
    // Paying a settlement clears your debt (raises net); receiving one
    // consumes what you were owed (lowers net).
    add(p.fromUserId, p.amountCents);
    add(p.toUserId, -p.amountCents);
  }

  assertZeroSum(nets);
  return nets;
}

// INVARIANT: each expense contributes +amount to the payer and shares summing
// to exactly -amount; each settlement is +x/-x. Total must be 0. A violation
// means corrupted data — fail loudly rather than render wrong money.
export function assertZeroSum(nets: Map<string, number>): void {
  let sum = 0;
  for (const v of nets.values()) sum += v;
  if (sum !== 0) {
    throw new Error(`Balance integrity violation: group nets sum to ${sum} cents, expected 0`);
  }
}

// Raw pairwise debts: who owes whom, from the actual expenses/settlements
// (not simplified). For each expense, each non-payer participant owes the
// payer their share; settlements reduce the payer pair.
export function pairwiseDebts(
  expenses: ExpenseEntry[],
  settlements: SettlementEntry[],
): Transfer[] {
  // ledger key "a|b" with a < b lexicographically; value = cents b owes a.
  const ledger = new Map<string, number>();
  const owe = (debtor: string, creditor: string, cents: number) => {
    if (debtor === creditor || cents === 0) return;
    const [a, b] = debtor < creditor ? [debtor, creditor] : [creditor, debtor];
    const signed = debtor === b ? cents : -cents;
    const key = `${a}|${b}`;
    ledger.set(key, (ledger.get(key) ?? 0) + signed);
  };

  for (const e of expenses) {
    // Normal: each participant owes the payer their share.
    // Refund: reversed — the payer owes each participant their share back.
    for (const s of e.splits) {
      if (e.isRefund) owe(e.paidById, s.userId, s.shareCents);
      else owe(s.userId, e.paidById, s.shareCents);
    }
  }
  // A settlement payment from X to Y reduces X's debt to Y.
  for (const p of settlements) owe(p.toUserId, p.fromUserId, p.amountCents);

  const out: Transfer[] = [];
  for (const [key, signed] of ledger) {
    if (signed === 0) continue;
    const [a, b] = key.split("|");
    if (signed > 0) out.push({ fromUserId: b, toUserId: a, amountCents: signed });
    else out.push({ fromUserId: a, toUserId: b, amountCents: -signed });
  }
  return out.sort(
    (x, y) =>
      x.fromUserId.localeCompare(y.fromUserId) || x.toUserId.localeCompare(y.toUserId),
  );
}

// Greedy min-cash-flow simplification (display-only — never persisted).
// Repeatedly match the largest debtor with the largest creditor.
// Terminates in <= n-1 transfers; minimizes total money moved.
export function simplifyDebts(nets: Map<string, number>): Transfer[] {
  const debtors: { id: string; amt: number }[] = [];
  const creditors: { id: string; amt: number }[] = [];
  for (const [id, v] of nets) {
    if (v < 0) debtors.push({ id, amt: -v });
    else if (v > 0) creditors.push({ id, amt: v });
  }
  // Deterministic: sort by amount desc, then id, so equal inputs give equal output.
  const byAmt = (a: { id: string; amt: number }, b: { id: string; amt: number }) =>
    b.amt - a.amt || a.id.localeCompare(b.id);
  debtors.sort(byAmt);
  creditors.sort(byAmt);

  const transfers: Transfer[] = [];
  let di = 0;
  let ci = 0;
  while (di < debtors.length && ci < creditors.length) {
    const pay = Math.min(debtors[di].amt, creditors[ci].amt);
    transfers.push({
      fromUserId: debtors[di].id,
      toUserId: creditors[ci].id,
      amountCents: pay,
    });
    debtors[di].amt -= pay;
    creditors[ci].amt -= pay;
    if (debtors[di].amt === 0) di++;
    if (creditors[ci].amt === 0) ci++;
  }
  return transfers;
}
