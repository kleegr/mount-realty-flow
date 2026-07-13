/**
 * Flexible importer field catalog + column auto-mapping.
 * Client-safe — no server imports.
 */
import { FIELDS, ALLOWED } from "../kleegr/field-map";

export type FlexScope = "project" | "building" | "unit";

export interface FlexField {
  /** Stable field key used in mapping. */
  key: string;
  /** Human label shown in the UI. */
  label: string;
  /** CRM property name (undefined for logical fields like name/id). */
  crmField?: string;
  /** Role — used for identity resolution and parent linking. */
  role?: "record_id" | "external_id" | "name" | "code" | "parent_ref";
  /** Which parent this field refers to (only for role=parent_ref). */
  parentScope?: FlexScope;
  /** Aliases matched case/whitespace-insensitively during auto-map. */
  aliases: string[];
  /** Optional enum for validation. */
  enum?: readonly string[];
  /** Data type for coercion. */
  type?: "string" | "number" | "yesno" | "date";
}

const N = (s: string) => s.toLowerCase().replace(/[\s_\-?.]+/g, " ").replace(/\?$/, "").trim();

export const FIELD_CATALOG: Record<FlexScope, FlexField[]> = {
  project: [
    { key: "record_id", label: "CRM Record ID", role: "record_id",
      aliases: ["record id", "crm record id", "crm id", "id"] },
    { key: "external_id", label: "External / Import ID", role: "external_id", crmField: FIELDS.project.external_import_id,
      aliases: ["external id", "external import id", "import id", "project import id", "external_import_id"] },
    { key: "name", label: "Project Name", role: "name", crmField: FIELDS.project.name,
      aliases: ["project name", "project", "name", "projects"] },
    { key: "code", label: "Project Code", role: "code", crmField: FIELDS.project.code,
      aliases: ["project code", "code"] },
    { key: "status", label: "Project Status", crmField: FIELDS.project.status,
      aliases: ["project status", "status"], enum: ALLOWED.projectStatus },
    { key: "property_type", label: "Property Type", crmField: FIELDS.project.property_type,
      aliases: ["property type", "project property type"], enum: ALLOWED.projectPropertyType },
    { key: "address", label: "Address", crmField: FIELDS.project.address,
      aliases: ["address", "project address"] },
    { key: "total_units", label: "Total Units", crmField: FIELDS.project.total_units, type: "number",
      aliases: ["total units"] },
    { key: "available_units", label: "Available Units", crmField: FIELDS.project.available_units, type: "number",
      aliases: ["available units"] },
    { key: "reserved_locked_units", label: "Reserved / Locked Units", crmField: FIELDS.project.reserved_locked_units, type: "number",
      aliases: ["reserved / locked units", "reserved locked units", "reserved units"] },
    { key: "under_contract_units", label: "Under Contract Units", crmField: FIELDS.project.under_contract_units, type: "number",
      aliases: ["under contract units"] },
    { key: "sold_units", label: "Sold Units", crmField: FIELDS.project.sold_units, type: "number",
      aliases: ["sold units"] },
    { key: "recalc_requested", label: "Recalc Requested", crmField: FIELDS.project.recalc_requested, type: "yesno",
      aliases: ["recalc requested", "recalc"] },
  ],
  building: [
    { key: "record_id", label: "CRM Record ID", role: "record_id",
      aliases: ["record id", "crm record id", "crm id", "id"] },
    { key: "external_id", label: "External / Import ID", role: "external_id", crmField: FIELDS.building.external_import_id,
      aliases: ["external id", "external import id", "import id", "building import id"] },
    { key: "name", label: "Building Name", role: "name", crmField: FIELDS.building.name,
      aliases: ["building name", "name", "building"] },
    { key: "code", label: "Building Code", role: "code", crmField: FIELDS.building.code,
      aliases: ["building code", "code"] },
    { key: "address", label: "Building Address", crmField: FIELDS.building.address,
      aliases: ["building address", "address"] },
    { key: "status", label: "Building Status", crmField: FIELDS.building.status,
      aliases: ["building status", "status"], enum: ALLOWED.buildingStatus },
    { key: "total_units", label: "Total Units", crmField: FIELDS.building.total_units, type: "number",
      aliases: ["total units"] },
    { key: "available_units", label: "Available Units", crmField: FIELDS.building.available_units, type: "number",
      aliases: ["available units"] },
    { key: "reserved_locked_units", label: "Reserved / Locked Units", crmField: FIELDS.building.reserved_locked_units, type: "number",
      aliases: ["reserved / locked units", "reserved locked units", "reserved units"] },
    { key: "under_contract_units", label: "Under Contract Units", crmField: FIELDS.building.under_contract_units, type: "number",
      aliases: ["under contract units"] },
    { key: "sold_units", label: "Sold Units", crmField: FIELDS.building.sold_units, type: "number",
      aliases: ["sold units"] },
    { key: "recalc_requested", label: "Recalc Requested", crmField: FIELDS.building.recalc_requested, type: "yesno",
      aliases: ["recalc requested", "recalc"] },
    { key: "parent_project", label: "Project (name / code / id)", role: "parent_ref", parentScope: "project",
      aliases: ["project", "project name", "project code", "project id", "project import id", "parent project"] },
  ],
  unit: [
    { key: "record_id", label: "CRM Record ID", role: "record_id",
      aliases: ["record id", "crm record id", "crm id", "id"] },
    { key: "external_id", label: "External / Import ID", role: "external_id",
      aliases: ["external id", "external import id", "import id", "unit import id"] },
    { key: "name", label: "Unit Name", role: "name", crmField: FIELDS.unit.name,
      aliases: ["unit name", "name"] },
    { key: "number", label: "Unit Number", crmField: FIELDS.unit.number,
      aliases: ["unit number", "unit #", "number", "unit no"] },
    { key: "availability", label: "Availability", crmField: FIELDS.unit.availability,
      aliases: ["available", "availability", "available / not available", "unit availability"], enum: ALLOWED.unitAvailability },
    { key: "stage", label: "Stage", crmField: FIELDS.unit.stage,
      aliases: ["stage", "unit stage", "stages"], enum: ALLOWED.unitStage },
    { key: "rooms", label: "Rooms", crmField: FIELDS.unit.rooms, type: "number",
      aliases: ["rooms"] },
    { key: "bedrooms", label: "Bedrooms", crmField: FIELDS.unit.bedrooms, type: "number",
      aliases: ["bedrooms", "beds", "br"] },
    { key: "floor", label: "Floor", crmField: FIELDS.unit.floor, type: "number",
      aliases: ["floor", "level"] },
    { key: "style", label: "Style", crmField: FIELDS.unit.style,
      aliases: ["style", "unit style"], enum: ALLOWED.unitStyle },
    { key: "total_sf", label: "Total SF", crmField: FIELDS.unit.total_sf, type: "number",
      aliases: ["total sf", "sqft", "square feet", "sf"] },
    { key: "movein_ready", label: "Move-in Ready", crmField: FIELDS.unit.movein_ready, type: "yesno",
      aliases: ["move in ready", "movein ready"] },
    { key: "price", label: "Asking / Sale Price", crmField: FIELDS.unit.price, type: "number",
      aliases: ["price", "asking price", "sale price", "asking / sale price", "asking sale price"] },
    { key: "price_per_sf", label: "Price Per SF", crmField: FIELDS.unit.price_per_sf, type: "number",
      aliases: ["price per sf", "price/sf", "ppsf"] },
    { key: "inventory_deducted", label: "Inventory Deducted?", crmField: FIELDS.unit.inventory_deducted, type: "yesno",
      aliases: ["inventory deducted", "inventory deducted?"] },
    { key: "locked_date", label: "Locked Date", crmField: FIELDS.unit.locked_date, type: "date",
      aliases: ["locked date", "locked date ( edt )", "locked date edt"] },
    { key: "parent_building", label: "Building (name / code / id)", role: "parent_ref", parentScope: "building",
      aliases: ["building", "building name", "building code", "building id", "building import id"] },
    { key: "parent_project", label: "Project (name / code / id)", role: "parent_ref", parentScope: "project",
      aliases: ["project", "project name", "project code", "project id", "project import id"] },
  ],
};

/** Header → { scope: key } auto-map. Ambiguous headers pick the first scope where they fit. */
export function autoMapHeaders(
  headers: string[],
  scopes: FlexScope[],
): Record<FlexScope, Record<string, string>> {
  const map: Record<FlexScope, Record<string, string>> = { project: {}, building: {}, unit: {} };
  for (const header of headers) {
    const norm = N(header);
    for (const scope of scopes) {
      const match = FIELD_CATALOG[scope].find((f) => f.aliases.some((a) => N(a) === norm));
      if (match && !Object.values(map[scope]).includes(match.key)) {
        map[scope][header] = match.key;
        break;
      }
    }
  }
  return map;
}

/** Score each scope for a given header set. Higher = more likely present. */
export function detectScopes(headers: string[]): FlexScope[] {
  const scores: Record<FlexScope, number> = { project: 0, building: 0, unit: 0 };
  const normHeaders = headers.map(N);
  for (const scope of ["project", "building", "unit"] as FlexScope[]) {
    for (const f of FIELD_CATALOG[scope]) {
      // Only count "distinctive" fields (skip generic name/id/status)
      const distinctive = ["name", "code", "number", "availability", "stage", "property_type",
        "address", "status", "record_id", "price", "total_sf", "movein_ready"].includes(f.key);
      if (!distinctive) continue;
      if (f.aliases.some((a) => normHeaders.includes(N(a)))) scores[scope]++;
    }
  }
  // A scope is "present" if ≥ 2 distinctive matches (or ≥ 1 for units when unit-specific headers appear)
  const detected: FlexScope[] = [];
  if (scores.unit >= 2 || headers.some((h) => ["unit number", "unit name", "asking / sale price", "total sf"].includes(N(h)))) detected.push("unit");
  if (scores.building >= 2 || headers.some((h) => ["building name", "building code", "building status", "building address"].includes(N(h)))) detected.push("building");
  if (scores.project >= 2 || headers.some((h) => ["project name", "project code", "project status", "property type"].includes(N(h)))) detected.push("project");
  return detected.length ? detected : ["unit"];
}

export function coerce(value: unknown, type: FlexField["type"]): unknown {
  if (value === null || value === undefined || value === "") return null;
  const s = String(value).trim();
  if (!s) return null;
  if (type === "number") {
    const n = Number(s.replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  if (type === "yesno") {
    const low = s.toLowerCase();
    if (["yes", "y", "true", "1"].includes(low)) return "Yes";
    if (["no", "n", "false", "0"].includes(low)) return "No";
    return s;
  }
  return s;
}
