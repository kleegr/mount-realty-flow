/**
 * Parse XLSX / XLS / CSV → raw row objects keyed by the 30 canonical column names.
 * Server-only. Uses SheetJS.
 */
import * as XLSX from "xlsx";
import { IMPORT_COLUMNS, type ImportColumn } from "../kleegr/field-map";

export interface ParsedFile {
  filename: string;
  fileHash: string;
  rows: Array<Record<ImportColumn, unknown>>;
  headerIssues: string[];
}

export async function parseInventoryFile(file: {
  name: string;
  bytes: ArrayBuffer;
}): Promise<ParsedFile> {
  const filename = file.name;
  const fileHash = await sha256Hex(file.bytes);
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";

  const workbook = XLSX.read(file.bytes, {
    type: "array",
    cellDates: true,
    raw: false,
  });

  // Prefer the "Inventory Import" sheet if present
  const sheetName =
    workbook.SheetNames.find((n) => n.trim().toLowerCase() === "inventory import") ??
    workbook.SheetNames[0];
  if (!sheetName) {
    return { filename, fileHash, rows: [], headerIssues: ["Empty file — no sheets found"] };
  }

  const sheet = workbook.Sheets[sheetName];
  const raw = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
    defval: "",
    raw: false,
    blankrows: false,
  });

  const headerIssues: string[] = [];
  if (raw.length === 0) {
    headerIssues.push("Sheet has no data rows.");
    return { filename, fileHash, rows: [], headerIssues };
  }

  // Verify headers by intersecting with the canonical list; tolerate case/whitespace.
  const firstRowKeys = Object.keys(raw[0]);
  const canonicalByNormalized = new Map(
    IMPORT_COLUMNS.map((c) => [normalize(c), c]),
  );
  const keyMap = new Map<string, ImportColumn>();
  for (const key of firstRowKeys) {
    const norm = normalize(key);
    const canonical = canonicalByNormalized.get(norm);
    if (canonical) keyMap.set(key, canonical);
  }

  const missing = IMPORT_COLUMNS.filter((c) => ![...keyMap.values()].includes(c));
  const required: ImportColumn[] = ["Import Row ID", "Import Mode", "Unit Import ID", "Unit Name", "Unit Number"];
  for (const col of required) {
    if (missing.includes(col)) headerIssues.push(`Missing required column: "${col}"`);
  }

  const rows = raw.map((r) => {
    const out = {} as Record<ImportColumn, unknown>;
    for (const col of IMPORT_COLUMNS) out[col] = "";
    for (const [src, canonical] of keyMap.entries()) {
      out[canonical] = r[src];
    }
    return out;
  });

  return { filename, fileHash, rows, headerIssues };

  function normalize(s: string) {
    return s.toLowerCase().replace(/\s+/g, " ").replace(/\?$/, "").trim();
  }
}

async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// CSV template generator for browser download
export function buildCsvTemplate(): string {
  const header = IMPORT_COLUMNS.map(csvEscape).join(",");
  const sample =
    [
      "R1", "Project + Buildings + Units", "PRJ-001", "BLD-A", "UNIT-A101",
      "Riverside Heights", "PRJ-001", "Active", "Condo", "123 River St, Miami FL",
      "Tower A", "BLD-A", "123 River St, Miami FL", "Active",
      "A101", "101", "Available", "", "4", "2", "1", "Flat",
      "1200", "Yes", "450000", "375", "No", "", "", "No",
    ].map(csvEscape).join(",");
  return header + "\n" + sample + "\n";
}

function csvEscape(v: string): string {
  if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
