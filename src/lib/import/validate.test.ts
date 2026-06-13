import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { validateCsv } from "./validate";
import type { MemberCtx, RowResult, ValidationCtx } from "./types";

const member = (
  userId: string,
  name: string,
  joined = "2026-02-01",
  left: string | null = null,
): MemberCtx => ({
  userId,
  name,
  email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
  joinedAt: new Date(`${joined}T00:00:00Z`),
  leftAt: left ? new Date(`${left}T00:00:00Z`) : null,
});

// Mirrors the seeded "Flat 4B" membership timeline.
const flatmates = (): MemberCtx[] => [
  member("aisha", "Aisha"),
  member("rohan", "Rohan"),
  member("priya", "Priya"),
  member("meera", "Meera", "2026-02-01", "2026-03-31"),
  member("dev", "Dev"),
  member("sam", "Sam", "2026-04-08"),
];

const ctx = (over: Partial<ValidationCtx> = {}): ValidationCtx => ({
  members: flatmates(),
  baseCurrency: "INR",
  existingHashes: new Set(),
  today: new Date("2026-06-13T00:00:00Z"),
  ...over,
});

const HEADER =
  "date,description,paid_by,amount,currency,split_type,split_with,split_details,notes";
const csv = (...rows: string[]) => [HEADER, ...rows].join("\n");
const run = (text: string, c = ctx()) => validateCsv(text, c);
const reasons = (r: RowResult) => r.reasons;

describe("real-format basics", () => {
  it("imports a clean equal INR row with exact paise", () => {
    const res = run(csv("01-02-2026,February rent,Aisha,48000,INR,equal,Aisha;Rohan;Priya;Meera,,"));
    const row = res.rows[0];
    expect(row.outcome).toBe("IMPORTED");
    expect(row.expense!.amountCents).toBe(4_800_000); // ₹48,000 = 4.8M paise
    const sum = row.expense!.splits.reduce((a, s) => a + s.shareCents, 0);
    expect(sum).toBe(4_800_000);
  });
});

describe("dates (DD-MM-YYYY)", () => {
  it("parses DD-MM-YYYY", () => {
    expect(run(csv("03-02-2026,X,Aisha,100,INR,equal,Aisha;Rohan,,")).rows[0].expense!.date).toBe("2026-02-03");
  });
  it("flags Mon-DD with inferred year", () => {
    const r = run(csv("Mar-14,Airport cab,Aisha,1100,INR,equal,Aisha;Rohan,,")).rows[0];
    expect(r.outcome).toBe("FLAGGED");
    expect(reasons(r)).toContain("DATE_AMBIGUOUS");
    expect(r.expense!.date).toBe("2026-03-14");
  });
  it("flags an out-of-sequence date spike (04-05 between March and April)", () => {
    const res = run(
      csv(
        "28-03-2026,Farewell,Aisha,4800,INR,equal,Aisha;Rohan;Priya,,",
        "04-05-2026,Deep cleaning,Rohan,2500,INR,equal,Aisha;Rohan;Priya,,",
        "01-04-2026,April rent,Aisha,4800,INR,equal,Aisha;Rohan;Priya,,",
      ),
    );
    const spike = res.rows[1];
    expect(spike.expense!.date).toBe("2026-05-04");
    expect(reasons(spike)).toContain("DATE_AMBIGUOUS");
  });
});

describe("amounts", () => {
  it("normalizes thousands separator", () => {
    const r = run(csv('10-02-2026,Electricity,Aisha,"1,200",INR,equal,Aisha;Rohan,,')).rows[0];
    expect(r.expense!.originalAmountCents).toBe(120000);
    expect(reasons(r)).toContain("AMOUNT_NORMALIZED");
  });
  it("rejects sub-unit precision (899.995)", () => {
    const r = run(csv("15-02-2026,Cylinder,Rohan,899.995,INR,equal,Aisha;Rohan,,")).rows[0];
    expect(r.outcome).toBe("REJECTED");
    expect(reasons(r)).toContain("EXCESS_PRECISION");
  });
  it("rejects zero", () => {
    const r = run(csv("22-03-2026,Swiggy,Priya,0,INR,equal,Aisha;Priya,,")).rows[0];
    expect(r.outcome).toBe("REJECTED");
    expect(reasons(r)).toContain("ZERO_AMOUNT");
  });
  it("treats a negative amount as a refund (flag), not a reject", () => {
    const r = run(csv("12-03-2026,Parasailing refund,Dev,-30,USD,equal,Aisha;Rohan;Priya;Dev,,")).rows[0];
    expect(r.outcome).toBe("FLAGGED");
    expect(reasons(r)).toContain("NEGATIVE_AMOUNT");
    expect(r.expense!.isRefund).toBe(true);
  });
});

describe("currency", () => {
  it("converts USD to INR at the documented rate (1 USD = ₹83) and keeps the original", () => {
    const r = run(csv("09-03-2026,Goa villa,Dev,540,USD,equal,Aisha;Rohan;Priya;Dev,,")).rows[0];
    expect(r.outcome).toBe("FLAGGED");
    expect(reasons(r)).toContain("FOREIGN_CURRENCY");
    expect(r.expense!.currency).toBe("USD");
    expect(r.expense!.originalAmountCents).toBe(54000); // $540.00
    expect(r.expense!.amountCents).toBe(4_482_000); // ₹44,820.00
  });
  it("defaults missing currency to base and flags it", () => {
    const r = run(csv("15-03-2026,Groceries,Priya,2105,,equal,Aisha;Rohan;Priya,,")).rows[0];
    expect(reasons(r)).toContain("MISSING_CURRENCY");
    expect(r.expense!.currency).toBe("INR");
  });
});

describe("split types", () => {
  it("treats 'unequal' as EXACT and validates the sum", () => {
    const r = run(csv("20-02-2026,Cake,Rohan,1500,INR,unequal,Rohan;Priya;Meera,Rohan 700; Priya 400; Meera 400,")).rows[0];
    expect(r.outcome).not.toBe("REJECTED");
    expect(reasons(r)).toContain("SPLIT_TYPE_NORMALIZED");
    const shares = Object.fromEntries(r.expense!.splits.map((s) => [s.userId, s.shareCents]));
    expect(shares.rohan).toBe(70000);
  });
  it("supports SHARE (ratio) splits", () => {
    const r = run(csv("10-03-2026,Scooters,Priya,3600,INR,share,Aisha;Rohan;Priya;Dev,Aisha 1; Rohan 2; Priya 1; Dev 2,")).rows[0];
    expect(r.outcome).toBe("IMPORTED");
    const shares = Object.fromEntries(r.expense!.splits.map((s) => [s.userId, s.shareCents]));
    // 3600 over ratio 1:2:1:2 (=6 parts, ₹600/part) → 600/1200/600/1200
    expect(shares.aisha).toBe(60000);
    expect(shares.rohan).toBe(120000);
    expect(shares.dev).toBe(120000);
    expect(r.expense!.splits.reduce((a, s) => a + s.shareCents, 0)).toBe(360000);
  });
  it("rejects percentages that don't sum to 100 (110%)", () => {
    const r = run(csv("28-02-2026,Pizza,Aisha,1440,INR,percentage,Aisha;Rohan;Priya;Meera,Aisha 30%; Rohan 30%; Priya 30%; Meera 20%,")).rows[0];
    expect(r.outcome).toBe("REJECTED");
    expect(reasons(r)).toContain("PERCENT_SUM_MISMATCH");
  });
  it("flags split_type=equal with stray split_details, honoring EQUAL", () => {
    const r = run(csv("18-04-2026,Furniture,Aisha,12000,INR,equal,Aisha;Rohan;Priya;Sam,Aisha 1; Rohan 1; Priya 1; Sam 1,")).rows[0];
    expect(reasons(r)).toContain("SPLIT_TYPE_DETAIL_CONFLICT");
    expect(r.expense!.splitType).toBe("EQUAL");
  });
});

describe("identity & membership", () => {
  it("attributes 'Priya S' to Priya and flags it", () => {
    const r = run(csv("18-02-2026,Groceries,Priya S,1875,INR,equal,Aisha;Rohan;Priya,,")).rows[0];
    expect(reasons(r)).toContain("AMBIGUOUS_IDENTITY");
    expect(r.expense!.paidById).toBe("priya");
  });
  it("rejects an unknown guest (Kabir) with no close match", () => {
    const r = run(csv("11-03-2026,Parasailing,Dev,150,USD,equal,Aisha;Rohan;Priya;Dev;Dev's friend Kabir,,")).rows[0];
    expect(r.outcome).toBe("REJECTED");
    expect(reasons(r)).toContain("UNKNOWN_USER");
  });
  it("flags an expense dated after a member left", () => {
    const r = run(csv("02-04-2026,Groceries,Priya,2640,INR,equal,Aisha;Rohan;Priya;Meera,,")).rows[0];
    expect(reasons(r)).toContain("MEMBERSHIP_TIMING");
  });
});

describe("settlements, duplicates, conflicts", () => {
  it("reclassifies a settlement-as-expense (empty split_type, single counterpart)", () => {
    const res = run(csv("25-02-2026,Rohan paid Aisha back,Rohan,5000,INR,,Aisha,,"));
    const r = res.rows[0];
    expect(r.outcome).toBe("RECLASSIFIED");
    expect(reasons(r)).toContain("SETTLEMENT_AS_EXPENSE");
    expect(r.settlement!.fromUserId).toBe("rohan");
    expect(r.settlement!.toUserId).toBe("aisha");
    expect(r.settlement!.amountCents).toBe(500000);
  });
  it("skips an exact duplicate (same date/payer/amount, cosmetically different description)", () => {
    const res = run(
      csv(
        "08-02-2026,Dinner at Marina Bites,Dev,3200,INR,equal,Aisha;Rohan;Priya;Dev,,",
        "08-02-2026,dinner - marina bites,Dev,3200,INR,equal,Aisha;Rohan;Priya;Dev,,",
      ),
    );
    expect(res.rows[0].outcome).toBe("IMPORTED");
    expect(res.rows[1].outcome).toBe("DUPLICATE");
  });
  it("flags BOTH conflicting duplicates (same day+description, different payer/amount)", () => {
    const res = run(
      csv(
        "11-03-2026,Dinner at Thalassa,Aisha,2400,INR,equal,Aisha;Rohan;Priya;Dev,,",
        "11-03-2026,Thalassa dinner,Rohan,2450,INR,equal,Aisha;Rohan;Priya;Dev,,",
      ),
    );
    expect(res.rows[0].reasons).toContain("CONFLICTING_DUPLICATE");
    expect(res.rows[1].reasons).toContain("CONFLICTING_DUPLICATE");
    expect(res.rows.every((r) => r.outcome === "FLAGGED")).toBe(true);
  });
  it("is idempotent: re-running with prior hashes imports nothing", () => {
    const line = "01-02-2026,February rent,Aisha,48000,INR,equal,Aisha;Rohan;Priya;Meera,,";
    const first = run(csv(line));
    const again = run(csv(line), ctx({ existingHashes: new Set([first.rows[0].hash]) }));
    expect(again.rows[0].outcome).toBe("DUPLICATE");
  });

  it("is idempotent for reclassified settlements too", () => {
    const line = "25-02-2026,Rohan paid Aisha back,Rohan,5000,INR,,Aisha,,";
    const first = run(csv(line));
    expect(first.rows[0].outcome).toBe("RECLASSIFIED");
    const again = run(csv(line), ctx({ existingHashes: new Set([first.rows[0].hash]) }));
    expect(again.rows[0].outcome).toBe("DUPLICATE");
  });
});

describe("the real expenses_export.csv", () => {
  const text = readFileSync(resolve(process.cwd(), "public/expenses_export.csv"), "utf8");
  const res = run(text);

  it("ingests the file and accounts for every row", () => {
    expect(res.ok).toBe(true);
    const s = res.summary;
    expect(s.imported + s.flagged + s.rejected + s.duplicate + s.reclassified + s.empty).toBe(s.total);
  });

  it("detects the headline anomalies", () => {
    const s = res.summary;
    expect(s.reclassified).toBeGreaterThanOrEqual(1); // Rohan paid Aisha back
    expect(s.duplicate).toBeGreaterThanOrEqual(1); // Marina Bites
    expect(s.rejected).toBeGreaterThanOrEqual(3); // 899.995, 0, 110%, missing payer...
    expect(s.convertedCurrency).toBeGreaterThanOrEqual(3); // USD rows
    expect(s.flagged).toBeGreaterThanOrEqual(5);
  });

  it("never imports a split whose shares don't sum to the (base) amount", () => {
    for (const row of res.rows) {
      if ((row.outcome === "IMPORTED" || row.outcome === "FLAGGED") && row.expense) {
        const sum = row.expense.splits.reduce((a, x) => a + x.shareCents, 0);
        expect(sum, `row ${row.rowNumber}`).toBe(row.expense.amountCents);
      }
    }
  });
});
