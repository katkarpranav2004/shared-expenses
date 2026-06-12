import { describe, expect, it } from "vitest";
import { validateCsv } from "./validate";
import type { MemberCtx, ValidationCtx } from "./types";

const member = (
  userId: string,
  name: string,
  joined = "2024-01-01",
  left: string | null = null,
): MemberCtx => ({
  userId,
  name,
  email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
  joinedAt: new Date(`${joined}T00:00:00Z`),
  leftAt: left ? new Date(`${left}T00:00:00Z`) : null,
});

const baseCtx = (): ValidationCtx => ({
  members: [
    member("u1", "Alice"),
    member("u2", "Bob"),
    member("u3", "Carol"),
    member("u4", "Sarah", "2024-01-01", "2024-03-01"), // left
  ],
  existingHashes: new Set(),
  existingNearKeys: new Set(),
  today: new Date("2026-06-13T00:00:00Z"),
});

const HEADER = "date,description,amount,paid_by,split_type,participants,splits";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");

const run = (text: string, ctx = baseCtx()) => validateCsv(text, ctx);

describe("validateCsv — happy path", () => {
  it("imports a clean equal split with exact cents", () => {
    const res = run(csv("2024-02-10,Dinner,100.00,Alice,EQUAL,Alice;Bob;Carol,"));
    expect(res.ok).toBe(true);
    const row = res.rows[0];
    expect(row.outcome).toBe("IMPORTED");
    expect(row.expense!.amountCents).toBe(10000);
    const shares = row.expense!.splits.map((s) => s.shareCents);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10000);
    expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
  });

  it("imports EXACT and PERCENTAGE splits", () => {
    const res = run(
      csv(
        "2024-02-10,Taxi,30.00,Bob,EXACT,Alice;Bob,Alice=10.00;Bob=20.00",
        "2024-02-11,Hotel,200.00,Carol,PERCENTAGE,Alice;Carol,Alice=25;Carol=75",
      ),
    );
    expect(res.rows[0].outcome).toBe("IMPORTED");
    expect(res.rows[1].outcome).toBe("IMPORTED");
    expect(res.rows[1].expense!.splits.find((s) => s.userId === "u1")!.shareCents).toBe(5000);
  });
});

describe("validateCsv — anomalies", () => {
  it("A1 malformed row (wrong column count)", () => {
    const res = run(csv("2024-02-10,Dinner,100.00"));
    expect(res.rows[0].outcome).toBe("REJECTED");
    expect(res.rows[0].reasons).toContain("MALFORMED_ROW");
  });

  it("A2 missing required field", () => {
    const res = run(csv("2024-02-10,Dinner,,Alice,EQUAL,Alice;Bob,"));
    expect(res.rows[0].outcome).toBe("REJECTED");
    expect(res.rows[0].reasons).toContain("MISSING_REQUIRED_FIELD");
  });

  it("A3 invalid amount rejected; $-grouping normalized with note", () => {
    const bad = run(csv("2024-02-10,Dinner,1.2.3,Alice,EQUAL,Alice;Bob,"));
    expect(bad.rows[0].reasons).toContain("INVALID_AMOUNT");
    const ok = run(csv('2024-02-10,Dinner,"$1,200.50",Alice,EQUAL,Alice;Bob,'));
    expect(ok.rows[0].outcome).toBe("IMPORTED");
    expect(ok.rows[0].reasons).toContain("AMOUNT_NORMALIZED");
    expect(ok.rows[0].expense!.amountCents).toBe(120050);
  });

  it("A4 excess precision, A5 negative, A6 zero — all rejected", () => {
    const res = run(
      csv(
        "2024-02-10,Gas,33.333,Alice,EQUAL,Alice;Bob,",
        "2024-02-10,Refund,-25.00,Alice,EQUAL,Alice;Bob,",
        "2024-02-10,Nothing,0.00,Alice,EQUAL,Alice;Bob,",
      ),
    );
    expect(res.rows[0].reasons).toContain("EXCESS_PRECISION");
    expect(res.rows[1].reasons).toContain("NEGATIVE_AMOUNT");
    expect(res.rows[2].reasons).toContain("ZERO_AMOUNT");
    expect(res.summary.rejected).toBe(3);
  });

  it("A7 impossible date rejected — JS Date must not roll Feb 30 to Mar 1", () => {
    const res = run(csv("2024-02-30,Dinner,50.00,Alice,EQUAL,Alice;Bob,"));
    expect(res.rows[0].outcome).toBe("REJECTED");
    expect(res.rows[0].reasons).toContain("INVALID_DATE");
  });

  it("A8 future date imported but flagged", () => {
    const res = run(csv("2027-01-05,Advance booking,50.00,Alice,EQUAL,Alice;Bob,"));
    expect(res.rows[0].outcome).toBe("FLAGGED");
    expect(res.rows[0].reasons).toContain("FUTURE_DATE");
  });

  it("A9 unknown user rejected with closest-match hint", () => {
    const res = run(csv("2024-02-10,Dinner,50.00,Alise,EQUAL,Alise;Bob,"));
    expect(res.rows[0].outcome).toBe("REJECTED");
    expect(res.rows[0].reasons).toContain("UNKNOWN_USER");
    expect(res.rows[0].messages.join(" ")).toMatch(/Closest match/);
  });

  it("A11 exact duplicates within file and across batches are skipped", () => {
    const line = "2024-02-10,Dinner,100.00,Alice,EQUAL,Alice;Bob;Carol,";
    const first = run(csv(line, line));
    expect(first.rows[0].outcome).toBe("IMPORTED");
    expect(first.rows[1].outcome).toBe("DUPLICATE");

    const ctx = baseCtx();
    ctx.existingHashes = new Set([first.rows[0].hash]);
    const second = run(csv(line), ctx);
    expect(second.rows[0].outcome).toBe("DUPLICATE");
    expect(second.summary.imported).toBe(0); // idempotency
  });

  it("A12 near-duplicate (same payer/amount/date, different description) flagged not skipped", () => {
    const res = run(
      csv(
        "2024-02-10,Dinner,40.00,Alice,EQUAL,Alice;Bob,",
        "2024-02-10,Diner,40.00,Alice,EQUAL,Alice;Bob,",
      ),
    );
    expect(res.rows[0].outcome).toBe("IMPORTED");
    expect(res.rows[1].outcome).toBe("FLAGGED");
    expect(res.rows[1].reasons).toContain("NEAR_DUPLICATE");
  });

  it("A13 membership timing: expense after member left is rejected", () => {
    const res = run(csv("2024-03-15,Gas,60.00,Sarah,EQUAL,Sarah;Bob,"));
    expect(res.rows[0].outcome).toBe("REJECTED");
    expect(res.rows[0].reasons).toContain("MEMBERSHIP_TIMING");
    expect(res.rows[0].messages.join(" ")).toMatch(/left the group/);
  });

  it("A13 membership timing: expense while member was active imports fine", () => {
    const res = run(csv("2024-02-15,Gas,60.00,Sarah,EQUAL,Sarah;Bob,"));
    expect(res.rows[0].outcome).toBe("IMPORTED");
  });

  it("A14 exact splits must sum to total", () => {
    const res = run(csv("2024-02-10,Taxi,100.00,Bob,EXACT,Alice;Bob,Alice=40.00;Bob=55.00"));
    expect(res.rows[0].outcome).toBe("REJECTED");
    expect(res.rows[0].reasons).toContain("SPLIT_SUM_MISMATCH");
  });

  it("A15 percentages must sum to 100 (±0.01 tolerance)", () => {
    const bad = run(csv("2024-02-10,Hotel,100.00,Bob,PERCENTAGE,Alice;Bob,Alice=50;Bob=40"));
    expect(bad.rows[0].reasons).toContain("PERCENT_SUM_MISMATCH");
    const thirds = run(
      csv("2024-02-10,Hotel,100.00,Bob,PERCENTAGE,Alice;Bob;Carol,Alice=33.33;Bob=33.33;Carol=33.34"),
    );
    expect(thirds.rows[0].outcome).toBe("IMPORTED");
    const sum = thirds.rows[0].expense!.splits.reduce((a, s) => a + s.shareCents, 0);
    expect(sum).toBe(10000);
  });

  it("A16 unknown split type rejected; aliases normalized", () => {
    const bad = run(csv("2024-02-10,Dinner,50.00,Alice,shares,Alice;Bob,"));
    expect(bad.rows[0].reasons).toContain("INVALID_SPLIT_TYPE");
    const alias = run(csv("2024-02-10,Dinner,50.00,Alice,equally,Alice;Bob,"));
    expect(alias.rows[0].outcome).toBe("IMPORTED");
    expect(alias.rows[0].reasons).toContain("SPLIT_TYPE_NORMALIZED");
  });

  it("A17 self-only expense imported but flagged, contributes zero net", () => {
    const res = run(csv("2024-02-10,Souvenir,20.00,Alice,EQUAL,Alice,"));
    expect(res.rows[0].outcome).toBe("FLAGGED");
    expect(res.rows[0].reasons).toContain("SELF_ONLY_EXPENSE");
    expect(res.rows[0].expense!.splits).toEqual([{ userId: "u1", shareCents: 2000 }]);
  });

  it("A18 foreign currency rejected, never converted", () => {
    const res = run(csv("2024-02-10,Dinner,€50,Alice,EQUAL,Alice;Bob,"));
    expect(res.rows[0].outcome).toBe("REJECTED");
    expect(res.rows[0].reasons).toContain("CURRENCY_MISMATCH");
  });

  it("A19 whitespace/case noise is normalized, not fatal", () => {
    const res = run(csv("2024-02-10,Dinner,50.00,  alice  ,EQUAL, ALICE ;bob,"));
    expect(res.rows[0].outcome).toBe("IMPORTED");
    expect(res.summary.normalizedWhitespace).toBe(1);
  });

  it("A20 empty rows counted, not rejected", () => {
    const res = run(csv("2024-02-10,Dinner,50.00,Alice,EQUAL,Alice;Bob,", ",,,,,,", ""));
    expect(res.summary.empty).toBeGreaterThanOrEqual(1);
    expect(res.summary.rejected).toBe(0);
  });

  it("file-level: missing required header columns", () => {
    const res = validateCsv("date,amount\n2024-01-01,5", baseCtx());
    expect(res.ok).toBe(false);
    expect(res.fileError).toMatch(/missing required column/i);
  });

  it("every row is accounted for (SCOPE.md §5.5)", () => {
    const res = run(
      csv(
        "2024-02-10,Dinner,100.00,Alice,EQUAL,Alice;Bob;Carol,",
        "2024-02-10,Dinner,100.00,Alice,EQUAL,Alice;Bob;Carol,", // dup
        "2024-02-30,Bad date,50.00,Alice,EQUAL,Alice;Bob,", // rejected
        "2027-01-05,Future,50.00,Alice,EQUAL,Alice;Bob,", // flagged
        ",,,,,,", // empty
      ),
    );
    const s = res.summary;
    expect(s.imported + s.flagged + s.rejected + s.duplicate + s.empty).toBe(s.total);
    expect(s.total).toBe(5);
  });
});
