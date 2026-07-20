/**
 * Field mapping + allowed values for the Kleegr 30-column Inventory Import.
 * SAFE: pure data, no server-only imports — usable in browser previews too.
 */

export const IMPORT_COLUMNS = [
  "Import Row ID",
  "Import Mode",
  "Project Import ID",
  "Building Import ID",
  "Unit Import ID",
  "Project Name",
  "Project Code",
  "Project Status",
  "Project Property Type",
  "Project Address",
  "Building Name",
  "Building Code",
  "Building Address",
  "Building Status",
  "Unit Name",
  "Unit Number",
  "Available / Not Available",
  "Stage",
  "Rooms",
  "Bedrooms",
  "Floor",
  "Style",
  "Total SF",
  "Move-in Ready",
  "Asking / Sale Price",
  "Price Per SF",
  "Inventory Deducted?",
  "Locked Date",
  "Import Notes",
  "Skip Row?",
] as const;

export type ImportColumn = (typeof IMPORT_COLUMNS)[number];

export const IMPORT_MODES = [
  "Project + Buildings + Units",
  "Building + Units",
  "Units Only",
] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export const ALLOWED = {
  projectStatus: ["Active", "Nearly Sold Out", "Sold Out", "Coming Soon", "Inactive", "Data Review Needed"],
  projectPropertyType: ["Condo", "Rental", "Mixed Use"],
  buildingStatus: ["Active", "Coming Soon", "Partially Available", "Reserved / Locked", "Under Contract", "Sold Out", "Inactive"],
  unitAvailability: ["Available", "Not Available"],
  // "Available" is a REAL stage now (owner decision): an available unit shows
  // Stage = Available instead of an empty stage. The option must also exist on
  // the Stages picklist in GHL or writes will be rejected/dropped.
  unitStage: ["Available", "Reserved/Locked", "Under Contract", "Closed/Sold"],
  unitStyle: ["Flat", "L Flat", "Up & Down", "Walk In", "3 Story", "Other", "Unknown"],
  yesNo: ["Yes", "No"],
} as const;

// CRM field keys per Appendix A
export const FIELDS = {
  project: {
    name: "projects",
    code: "project_code",
    status: "project_status",
    property_type: "property_type",
    address: "address",
    external_import_id: "external_import_id",
    total_units: "total_units",
    available_units: "available_units",
    reserved_locked_units: "reserved__locked_units",
    under_contract_units: "under_contract_units",
    sold_units: "sold_units",
    recalc_requested: "recalc_requested",
  },
  building: {
    name: "building_name",
    code: "building_code",
    address: "building_address",
    status: "building_status",
    external_import_id: "external_import_id",
    total_units: "total_units",
    available_units: "available_units",
    reserved_locked_units: "reserved__locked_units",
    under_contract_units: "under_contract_units",
    sold_units: "sold_units",
    recalc_requested: "recalc_requested",
  },
  unit: {
    name: "unit_name",
    number: "unit_number",
    availability: "availablenot_available",
    stage: "stages",
    rooms: "rooms",
    bedrooms: "bedrooms",
    floor: "floor",
    style: "style",
    total_sf: "total_sf",
    movein_ready: "movein_ready",
    price: "asking__sale_price",
    price_per_sf: "price_per_sf",
    inventory_deducted: "inventory_deducted",
    locked_date: "locked_date",
    external_import_id: "external_import_id",
  },
} as const;

export function normalizeString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

export function normalizeNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const cleaned = String(v).replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function normalizeYesNo(v: unknown): "Yes" | "No" | "" {
  const s = normalizeString(v).toLowerCase();
  if (["yes", "y", "true", "1"].includes(s)) return "Yes";
  if (["no", "n", "false", "0"].includes(s)) return "No";
  return "";
}

export function normalizeMode(v: unknown): ImportMode | null {
  const s = normalizeString(v).toLowerCase().replace(/\s+/g, " ");
  if (s.startsWith("project")) return "Project + Buildings + Units";
  if (s.startsWith("building")) return "Building + Units";
  if (s.startsWith("unit")) return "Units Only";
  return null;
}
