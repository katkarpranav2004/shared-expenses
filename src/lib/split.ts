// Split computation. INVARIANT for every function here: returned shares are
// integer cents and sum EXACTLY to amountCents. Largest-remainder method,
// deterministic (ties broken by array order; callers pass participants sorted
// by user id so the same input always yields the same output).

export type SplitType = "EQUAL" | "EXACT" | "PERCENTAGE";

export function equalShares(amountCents: number, n: number): number[] {
  if (n <= 0) throw new Error("equalShares: need at least one participant");
  const base = Math.floor(amountCents / n);
  const remainder = amountCents - base * n;
  // First `remainder` participants (stable order) carry one extra cent each.
  return Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
}

export function percentShares(amountCents: number, basisPoints: number[]): number[] {
  const totalBp = basisPoints.reduce((a, b) => a + b, 0);
  // Tolerance ±1 bp (= ±0.01%): lets 33.33+33.33+33.34 style inputs through,
  // rejects genuinely wrong totals. Validation happens before this is called;
  // this is a defensive recheck.
  if (Math.abs(totalBp - 10000) > 1) {
    throw new Error(`percentShares: percentages sum to ${totalBp} bp, expected 10000`);
  }
  const exact = basisPoints.map((bp) => (amountCents * bp) / 10000);
  const floors = exact.map(Math.floor);
  let remainder = amountCents - floors.reduce((a, b) => a + b, 0);
  // Hand out leftover cents by largest fractional part; ties -> lower index.
  const order = exact
    .map((v, i) => ({ frac: v - Math.floor(v), i }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  const shares = [...floors];
  for (const { i } of order) {
    if (remainder <= 0) break;
    shares[i] += 1;
    remainder -= 1;
  }
  return shares;
}

export function validateExactShares(amountCents: number, shares: number[]): boolean {
  return (
    shares.every((s) => Number.isInteger(s) && s >= 0) &&
    shares.reduce((a, b) => a + b, 0) === amountCents
  );
}
