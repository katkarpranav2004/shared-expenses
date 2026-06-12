import { describe, expect, it } from "vitest";
import {
  assertZeroSum,
  computeNets,
  pairwiseDebts,
  simplifyDebts,
  type ExpenseEntry,
} from "./balances";

const exp = (
  paidById: string,
  amountCents: number,
  splits: [string, number][],
): ExpenseEntry => ({
  paidById,
  amountCents,
  splits: splits.map(([userId, shareCents]) => ({ userId, shareCents })),
});

describe("computeNets", () => {
  it("hand-checked: A pays $10 split equally with B", () => {
    const nets = computeNets([exp("A", 1000, [["A", 500], ["B", 500]])], []);
    expect(nets.get("A")).toBe(500); // A is owed $5
    expect(nets.get("B")).toBe(-500); // B owes $5
  });

  it("settlement zeroes the pair (the AI_USAGE.md #1 regression case)", () => {
    const nets = computeNets(
      [exp("A", 1000, [["A", 500], ["B", 500]])],
      [{ fromUserId: "B", toUserId: "A", amountCents: 500 }],
    );
    expect(nets.get("A")).toBe(0);
    expect(nets.get("B")).toBe(0);
  });

  it("overpayment flips direction (DECISIONS.md #11)", () => {
    const nets = computeNets(
      [exp("A", 1000, [["A", 500], ["B", 500]])],
      [{ fromUserId: "B", toUserId: "A", amountCents: 800 }],
    );
    expect(nets.get("B")).toBe(300); // B overpaid by $3 — now owed
    expect(nets.get("A")).toBe(-300);
  });

  it("group nets always sum to zero (invariant)", () => {
    const nets = computeNets(
      [
        exp("A", 10000, [["A", 3334], ["B", 3333], ["C", 3333]]),
        exp("B", 4550, [["A", 2275], ["C", 2275]]),
        exp("C", 999, [["C", 999]]), // self-only: net zero
      ],
      [{ fromUserId: "C", toUserId: "A", amountCents: 1000 }],
    );
    let sum = 0;
    for (const v of nets.values()) sum += v;
    expect(sum).toBe(0);
  });

  it("assertZeroSum throws loudly on corrupted data", () => {
    expect(() => assertZeroSum(new Map([["A", 5]]))).toThrow(/integrity/i);
  });
});

describe("pairwiseDebts", () => {
  it("nets opposing debts within a pair", () => {
    const debts = pairwiseDebts(
      [
        exp("A", 1000, [["A", 500], ["B", 500]]), // B owes A 500
        exp("B", 600, [["A", 300], ["B", 300]]), // A owes B 300
      ],
      [],
    );
    expect(debts).toEqual([{ fromUserId: "B", toUserId: "A", amountCents: 200 }]);
  });

  it("settlements reduce the pair ledger", () => {
    const debts = pairwiseDebts(
      [exp("A", 1000, [["A", 500], ["B", 500]])],
      [{ fromUserId: "B", toUserId: "A", amountCents: 500 }],
    );
    expect(debts).toEqual([]);
  });
});

describe("simplifyDebts", () => {
  it("produces <= n-1 transfers that exactly settle all nets", () => {
    const nets = computeNets(
      [
        exp("A", 9000, [["A", 3000], ["B", 3000], ["C", 3000]]),
        exp("B", 3000, [["B", 1000], ["C", 1000], ["A", 1000]]),
      ],
      [],
    );
    const transfers = simplifyDebts(nets);
    expect(transfers.length).toBeLessThanOrEqual(2); // n-1 = 2

    // Applying the transfers must zero every net.
    const after = new Map(nets);
    for (const t of transfers) {
      after.set(t.fromUserId, (after.get(t.fromUserId) ?? 0) + t.amountCents);
      after.set(t.toUserId, (after.get(t.toUserId) ?? 0) - t.amountCents);
    }
    for (const v of after.values()) expect(v).toBe(0);
  });

  it("returns nothing when everyone is settled", () => {
    expect(simplifyDebts(new Map([["A", 0], ["B", 0]]))).toEqual([]);
  });
});
