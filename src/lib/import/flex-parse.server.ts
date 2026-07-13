/**
 * Flexible parser: returns rows keyed by ORIGINAL header text plus header list.
 * Server-only. Uses SheetJS.
 */
import * as XLSX from "xlsx";

export interface RawParsed {
  filename: string;
  fileHash: string;
  headers: string[];
  rows: Record<string, unknown>[];
}

export async function parseRawFile(file: { name: string; bytes: ArrayBuffer }): Promise<RawParsed> {
  const filename = file.name;
  const fileHash = await sha256Hex(file.bytes);
  const workbook = XLSX.read(file.bytes, { type: "array", cellDates: true, raw: false });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) return { filename, fileHash, headers: [], rows: [] };
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
    blankrows: false,
  });
  const headers = rows.length > 0 ? Object.keys(rows[0]) : [];
  return { filename, fileHash, headers, rows };
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function toCsv(headers: string[], rows: Array<Record<string, unknown>>): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.map(esc).join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}
