import { describe, expect, it } from "vitest";
import { parseCsv } from "./parseCsv";

describe("parseCsv (RFC 4180)", () => {
  it("parses simple rows", () => {
    const rows = parseCsv("a,b,c\n1,2,3");
    expect(rows.map((r) => r.fields)).toEqual([
      ["a", "b", "c"],
      ["1", "2", "3"],
    ]);
  });

  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = parseCsv('desc,amount\n"Dinner, drinks ""after""",45.50');
    expect(rows[1].fields).toEqual(['Dinner, drinks "after"', "45.50"]);
  });

  it("handles CRLF and missing trailing newline", () => {
    const rows = parseCsv("a,b\r\n1,2\r\n3,4");
    expect(rows).toHaveLength(3);
    expect(rows[2].fields).toEqual(["3", "4"]);
  });

  it("strips a UTF-8 BOM (A19)", () => {
    const rows = parseCsv("﻿date,amount\n2024-01-01,5");
    expect(rows[0].fields[0]).toBe("date");
  });

  it("preserves the raw line verbatim for the report", () => {
    const rows = parseCsv('a,b\n"x,y",2');
    expect(rows[1].raw).toBe('"x,y",2');
  });

  it("keeps newlines inside quoted fields in one record", () => {
    const rows = parseCsv('a,b\n"line1\nline2",2');
    expect(rows).toHaveLength(2);
    expect(rows[1].fields[0]).toBe("line1\nline2");
  });
});
