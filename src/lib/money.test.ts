import { describe, expect, it } from "vitest";
import { formatCents, parseAmount, parsePercent } from "./money";

describe("parseAmount", () => {
  it("parses plain amounts to cents with string math", () => {
    expect(parseAmount("45.50")).toEqual({ ok: true, cents: 4550, normalized: false });
    expect(parseAmount("100")).toEqual({ ok: true, cents: 10000, normalized: false });
    expect(parseAmount("0.01")).toEqual({ ok: true, cents: 1, normalized: false });
    expect(parseAmount("19.9")).toEqual({ ok: true, cents: 1990, normalized: false });
  });

  it("normalizes currency symbol and strict thousands grouping (A3)", () => {
    expect(parseAmount("$45.50")).toEqual({ ok: true, cents: 4550, normalized: true });
    expect(parseAmount("$1,200.50")).toEqual({ ok: true, cents: 120050, normalized: true });
    expect(parseAmount("1,200")).toEqual({ ok: true, cents: 120000, normalized: true });
    expect(parseAmount(" 45.50 ")).toEqual({ ok: true, cents: 4550, normalized: true });
  });

  it("rejects ambiguous or malformed amounts (A3)", () => {
    for (const bad of ["abc", "1.2.3", "12,50", "1,23.45", "45.50abc", "", "4 5"]) {
      expect(parseAmount(bad), bad).toEqual({ ok: false, code: "INVALID_AMOUNT" });
    }
  });

  it("rejects sub-cent precision instead of rounding (A4)", () => {
    expect(parseAmount("33.333")).toEqual({ ok: false, code: "EXCESS_PRECISION" });
  });

  it("rejects negative and zero (A5, A6)", () => {
    expect(parseAmount("-25.00")).toEqual({ ok: false, code: "NEGATIVE_AMOUNT" });
    expect(parseAmount("$-25.00")).toEqual({ ok: false, code: "NEGATIVE_AMOUNT" });
    expect(parseAmount("0")).toEqual({ ok: false, code: "ZERO_AMOUNT" });
    expect(parseAmount("0.00")).toEqual({ ok: false, code: "ZERO_AMOUNT" });
  });

  it("detects foreign currency instead of importing the bare number (A18)", () => {
    for (const bad of ["€50", "50 EUR", "£12.00", "₹500"]) {
      expect(parseAmount(bad), bad).toEqual({ ok: false, code: "CURRENCY_MISMATCH" });
    }
  });

  it("never uses parseFloat semantics", () => {
    // parseFloat("45.50abc") === 45.5 — that must NOT happen here.
    expect(parseAmount("45.50abc").ok).toBe(false);
  });
});

describe("formatCents", () => {
  it("formats cents for display", () => {
    expect(formatCents(4550)).toBe("$45.50");
    expect(formatCents(120050)).toBe("$1,200.50");
    expect(formatCents(-305)).toBe("-$3.05");
    expect(formatCents(0)).toBe("$0.00");
  });
});

describe("parsePercent", () => {
  it("parses to basis points", () => {
    expect(parsePercent("33.33")).toEqual({ ok: true, bp: 3333 });
    expect(parsePercent("50%")).toEqual({ ok: true, bp: 5000 });
    expect(parsePercent("100")).toEqual({ ok: true, bp: 10000 });
  });
  it("rejects more than 2 decimals or garbage", () => {
    expect(parsePercent("33.333").ok).toBe(false);
    expect(parsePercent("abc").ok).toBe(false);
  });
});
