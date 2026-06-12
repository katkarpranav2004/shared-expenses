import { describe, expect, it } from "vitest";
import { equalShares, percentShares, validateExactShares } from "./split";

describe("equalShares (largest remainder, deterministic)", () => {
  it("splits $100 three ways: 3334 + 3333 + 3333", () => {
    expect(equalShares(10000, 3)).toEqual([3334, 3333, 3333]);
  });

  it("is exact and even when divisible", () => {
    expect(equalShares(9000, 3)).toEqual([3000, 3000, 3000]);
  });

  it("property: sums exactly, spread <= 1 cent, deterministic (1000 random cases)", () => {
    let seed = 42;
    const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    for (let t = 0; t < 1000; t++) {
      const amount = 1 + Math.floor(rand() * 1_000_000);
      const n = 1 + Math.floor(rand() * 12);
      const shares = equalShares(amount, n);
      expect(shares.reduce((a, b) => a + b, 0)).toBe(amount);
      expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1);
      expect(shares).toEqual(equalShares(amount, n)); // same input, same output
    }
  });
});

describe("percentShares", () => {
  it("handles 33.33/33.33/33.34 on $100", () => {
    const shares = percentShares(10000, [3333, 3333, 3334]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(10000);
  });

  it("handles 60/40", () => {
    expect(percentShares(10000, [6000, 4000])).toEqual([6000, 4000]);
  });

  it("throws when percentages do not sum to 100 (defensive recheck)", () => {
    expect(() => percentShares(10000, [5000, 4000])).toThrow();
  });

  it("property: sums exactly for awkward thirds", () => {
    // $0.05 at 33.33/33.33/33.34 — base floors are 1+1+1, remainder 2 cents.
    const shares = percentShares(5, [3333, 3333, 3334]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(5);
  });
});

describe("validateExactShares", () => {
  it("accepts only non-negative integers summing to the total", () => {
    expect(validateExactShares(10000, [6000, 4000])).toBe(true);
    expect(validateExactShares(10000, [6000, 3999])).toBe(false);
    expect(validateExactShares(10000, [10001, -1])).toBe(false);
    expect(validateExactShares(10000, [5000.5, 4999.5])).toBe(false);
  });
});
