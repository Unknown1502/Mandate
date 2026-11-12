/**
 * Strict RFC 4180 CSV parser. Hand-written on purpose: ~100 auditable lines, no dependency, hard limits, and it REJECTS anything
 * ambiguous (stray quotes, ragged rows, duplicate/empty headers, NUL) instead of guessing. The input is untrusted DATA: it is only
 * ever split into strings. Nothing here evaluates, executes, shells out, builds SQL, or touches the filesystem.
 */
export const PARSER_VERSION = "csv-strict-1";

export interface CsvLimits {
  maxRows: number;
  maxColumns: number;
  maxFieldLength: number;
}
export const DEFAULT_LIMITS: CsvLimits = { maxRows: 10_000, maxColumns: 100, maxFieldLength: 10_000 };

export type CsvErrorCode =
  | "EMPTY"
  | "TOO_MANY_ROWS"
  | "TOO_MANY_COLUMNS"
  | "FIELD_TOO_LONG"
  | "UNTERMINATED_QUOTE"
  | "STRAY_QUOTE"
  | "RAGGED_ROW"
  | "DUPLICATE_HEADER"
  | "EMPTY_HEADER"
  | "NUL_CHARACTER"
  | "INVALID_UTF8";

export class CsvError extends Error {
  constructor(
    public readonly code: CsvErrorCode,
    public readonly line?: number,
  ) {
    super(`CSV rejected: ${code}${line ? ` (line ${line})` : ""}`);
    this.name = "CsvError";
  }
}

export interface ParsedCsv {
  headers: string[];
  /** data rows only; rows[i] is data row i+1 */
  rows: string[][];
}

/** Strict UTF-8 decode. A BOM is kept in the string (lossless round trip for hashing) and stripped by the parser. */
export function decodeUtf8Strict(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CsvError("INVALID_UTF8");
  }
}

export function parseCsv(input: string, limits: CsvLimits = DEFAULT_LIMITS): ParsedCsv {
  if (input.includes("\u0000")) throw new CsvError("NUL_CHARACTER");
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const records: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let fieldStarted = false; // saw any char (incl. an opening quote) in this field
  let quotedField = false;
  let line = 1;

  const pushField = () => {
    if (field.length > limits.maxFieldLength) throw new CsvError("FIELD_TOO_LONG", line);
    row.push(field);
    if (row.length > limits.maxColumns) throw new CsvError("TOO_MANY_COLUMNS", line);
    field = "";
    fieldStarted = false;
    quotedField = false;
  };
  const pushRecord = () => {
    // a completely empty physical line (no characters at all) is skipped
    if (row.length === 0 && !fieldStarted) return;
    pushField();
    records.push(row);
    if (records.length > limits.maxRows + 1) throw new CsvError("TOO_MANY_ROWS", line);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (c === "\n") line++;
        field += c;
        if (field.length > limits.maxFieldLength) throw new CsvError("FIELD_TOO_LONG", line);
      }
      continue;
    }
    if (c === '"') {
      if (fieldStarted) throw new CsvError("STRAY_QUOTE", line); // a quote in the middle of an unquoted field, or after a closed quote
      inQuotes = true;
      fieldStarted = true;
      quotedField = true;
    } else if (c === ",") {
      fieldStarted = true;
      pushField();
      fieldStarted = false;
    } else if (c === "\r" || c === "\n") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      pushRecord();
      line++;
    } else {
      if (quotedField) throw new CsvError("STRAY_QUOTE", line); // text after a closing quote
      field += c;
      fieldStarted = true;
      if (field.length > limits.maxFieldLength) throw new CsvError("FIELD_TOO_LONG", line);
    }
  }
  if (inQuotes) throw new CsvError("UNTERMINATED_QUOTE", line);
  if (row.length > 0 || fieldStarted) pushRecord();

  if (records.length === 0) throw new CsvError("EMPTY");
  const [headerRow, ...rows] = records as [string[], ...string[][]];
  const headers = headerRow.map((h) => h.trim());
  if (headers.some((h) => h === "")) throw new CsvError("EMPTY_HEADER", 1);
  if (new Set(headers).size !== headers.length) throw new CsvError("DUPLICATE_HEADER", 1);
  rows.forEach((r, i) => {
    if (r.length !== headers.length) throw new CsvError("RAGGED_ROW", i + 2);
  });
  return { headers, rows };
}

/** Test/inspection helper: RFC 4180 serialisation (always quotes when needed). */
export function toCsv(headers: string[], rows: string[][]): string {
  const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n") + "\n";
}
