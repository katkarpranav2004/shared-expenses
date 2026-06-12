// Minimal RFC 4180 CSV parser: quoted fields, escaped quotes (""), CRLF/LF,
// BOM stripping. Hand-rolled deliberately — the parsing rules are part of the
// anomaly story (A1, A19, A20) and must be explainable line by line.

export type CsvRow = {
  line: number; // 1-based line number in the source file
  raw: string; // original text of the line(s) for this record, verbatim
  fields: string[];
};

export function parseCsv(text: string): CsvRow[] {
  // Strip UTF-8 BOM (A19) — Excel exports start with ﻿.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  const rows: CsvRow[] = [];
  let fields: string[] = [];
  let field = "";
  let raw = "";
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;

  const pushField = () => {
    fields.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push({ line: recordStartLine, raw, fields });
    fields = [];
    raw = "";
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          raw += '""';
          i++; // escaped quote
        } else {
          inQuotes = false;
          raw += c;
        }
      } else {
        if (c === "\n") line++;
        field += c;
        raw += c;
      }
      continue;
    }

    if (c === '"' && field === "") {
      inQuotes = true;
      raw += c;
    } else if (c === ",") {
      pushField();
      raw += c;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++; // CRLF
      pushRow();
      line++;
      recordStartLine = line;
    } else {
      field += c;
      raw += c;
    }
  }
  // Final record without trailing newline.
  if (field !== "" || fields.length > 0 || raw !== "") pushRow();

  return rows;
}
