/**
 * Validate parsed rows into a preview plan.
 * Produces:
 *  - blocking errors (prevent Confirm)
 *  - warnings (allow Confirm)
 *  - grouped Project / Building / Unit previews with proposed CRM properties
 */
import type { ImportColumn, ImportMode } from "../kleegr/field-map";
import {
  ALLOWED,
  FIELDS,
  normalizeMode,
  normalizeNumber,
  normalizeString,
  normalizeYesNo,
} from "../kleegr/field-map";

export type Row = Record<ImportColumn, unknown>;

export interface ValidationMessage {
  level: "error" | "warning";
  message: string;
  rowNumber?: number;
}

export interface UnitPlan {
  importRowIds: string[];
  unitImportId: string;
  buildingImportId: string;
  projectImportId: string;
  unitNumber: string;
  unitName: string;
  availability: string;
  stage: string;
  properties: Record<string, unknown>;
  warnings: string[];
  errors: string[];
}

export interface BuildingPlan {
  buildingImportId: string;
  projectImportId: string;
  name: string;
  code: string;
  properties: Record<string, unknown>;
  unitImportIds: string[];
  warnings: string[];
  errors: string[];
}

export interface ProjectPlan {
  projectImportId: string;
  name: string;
  code: string;
  properties: Record<string, unknown>;
  buildingImportIds: string[];
  warnings: string[];
  errors: string[];
}

export interface ValidationResult {
  mode: ImportMode | null;
  totalRows: number;
  skippedRows: number;
  effectiveRows: number;
  errors: ValidationMessage[];
  warnings: ValidationMessage[];
  projects: ProjectPlan[];
  buildings: BuildingPlan[];
  units: UnitPlan[];
}

export function validateRows(rows: Row[]): ValidationResult {
  const errors: ValidationMessage[] = [];
  const warnings: ValidationMessage[] = [];
  const units: UnitPlan[] = [];
  const buildingsMap = new Map<string, BuildingPlan>();
  const projectsMap = new Map<string, ProjectPlan>();

  // detect mode from first non-skipped row with a value
  let mode: ImportMode | null = null;
  for (const r of rows) {
    const m = normalizeMode(r["Import Mode"]);
    if (m) { mode = m; break; }
  }
  if (!mode) errors.push({ level: "error", message: "Import Mode is missing from every row. Set it to one of: Project + Buildings + Units, Building + Units, Units Only." });

  const seenRowIds = new Set<string>();
  const seenUnitIds = new Set<string>();
  const projectIds = new Set<string>();
  const buildingIds = new Set<string>();
  let skipped = 0;

  rows.forEach((row, idx) => {
    const rowNumber = idx + 2; // header is row 1
    const importRowId = normalizeString(row["Import Row ID"]);
    const skip = normalizeYesNo(row["Skip Row?"]);
    if (skip === "Yes") { skipped++; }

    if (!importRowId) errors.push({ level: "error", message: "Import Row ID is required.", rowNumber });
    else if (seenRowIds.has(importRowId)) errors.push({ level: "error", message: `Duplicate Import Row ID "${importRowId}"`, rowNumber });
    else seenRowIds.add(importRowId);

    if (skip === "Yes") return;

    const rowMode = normalizeMode(row["Import Mode"]) ?? mode;
    const projectImportId = normalizeString(row["Project Import ID"]);
    const buildingImportId = normalizeString(row["Building Import ID"]);
    const unitImportId = normalizeString(row["Unit Import ID"]);

    if (projectImportId) projectIds.add(projectImportId);
    if (buildingImportId) buildingIds.add(buildingImportId);

    // Unit is always required
    if (!unitImportId) { errors.push({ level: "error", message: "Unit Import ID is required.", rowNumber }); return; }
    if (seenUnitIds.has(unitImportId)) { errors.push({ level: "error", message: `Duplicate Unit Import ID "${unitImportId}"`, rowNumber }); return; }
    seenUnitIds.add(unitImportId);

    const unitName = normalizeString(row["Unit Name"]);
    const unitNumber = normalizeString(row["Unit Number"]);
    if (!unitName) errors.push({ level: "error", message: "Unit Name is required.", rowNumber });
    if (!unitNumber) errors.push({ level: "error", message: "Unit Number is required.", rowNumber });

    const availability = normalizeString(row["Available / Not Available"]);
    const stage = normalizeString(row["Stage"]);
    const style = normalizeString(row["Style"]);
    const rowErrors: string[] = [];
    const rowWarnings: string[] = [];

    if (availability && !ALLOWED.unitAvailability.includes(availability as (typeof ALLOWED.unitAvailability)[number])) {
      rowErrors.push(`Unit availability "${availability}" is not allowed.`);
    }
    if (stage && !ALLOWED.unitStage.includes(stage as (typeof ALLOWED.unitStage)[number])) {
      rowErrors.push(`Unit stage "${stage}" is not allowed.`);
    }
    if (style && !ALLOWED.unitStyle.includes(style as (typeof ALLOWED.unitStyle)[number])) {
      rowWarnings.push(`Unit style "${style}" is not in the allowed list.`);
    }

    // Availability/stage consistency
    if (stage && availability && availability !== "Not Available") {
      rowErrors.push(`Stage "${stage}" requires availability "Not Available".`);
    }
    if (!stage && availability === "Not Available") {
      rowWarnings.push("Availability is Not Available but Stage is blank.");
    }

    const price = normalizeNumber(row["Asking / Sale Price"]);
    const totalSf = normalizeNumber(row["Total SF"]);
    const pricePerSf = normalizeNumber(row["Price Per SF"]);
    if (price && totalSf && pricePerSf) {
      const derived = price / totalSf;
      if (Math.abs(derived - pricePerSf) / Math.max(pricePerSf, 1) > 0.1) {
        rowWarnings.push(`Price Per SF (${pricePerSf}) differs materially from Price/Total SF (${derived.toFixed(2)}).`);
      }
    }

    for (const w of rowWarnings) warnings.push({ level: "warning", message: w, rowNumber });
    for (const e of rowErrors) errors.push({ level: "error", message: e, rowNumber });

    const unitProps = {
      [FIELDS.unit.name]: unitName,
      [FIELDS.unit.number]: unitNumber,
      [FIELDS.unit.availability]: availability || "Available",
      [FIELDS.unit.stage]: stage,
      [FIELDS.unit.rooms]: normalizeNumber(row["Rooms"]),
      [FIELDS.unit.bedrooms]: normalizeNumber(row["Bedrooms"]),
      [FIELDS.unit.floor]: normalizeNumber(row["Floor"]),
      [FIELDS.unit.style]: style,
      [FIELDS.unit.total_sf]: totalSf,
      [FIELDS.unit.movein_ready]: normalizeYesNo(row["Move-in Ready"]),
      [FIELDS.unit.price]: price,
      [FIELDS.unit.price_per_sf]: pricePerSf,
      [FIELDS.unit.inventory_deducted]: normalizeYesNo(row["Inventory Deducted?"]) || (stage ? "Yes" : "No"),
      [FIELDS.unit.locked_date]: normalizeString(row["Locked Date"]),
    };

    units.push({
      importRowIds: [importRowId],
      unitImportId,
      buildingImportId,
      projectImportId,
      unitName,
      unitNumber,
      availability,
      stage,
      properties: pruneEmpty(unitProps),
      warnings: rowWarnings,
      errors: rowErrors,
    });

    // Building aggregation
    if (buildingImportId) {
      const existing = buildingsMap.get(buildingImportId);
      const buildingProps = {
        [FIELDS.building.name]: normalizeString(row["Building Name"]),
        [FIELDS.building.code]: normalizeString(row["Building Code"]) || buildingImportId,
        [FIELDS.building.address]: normalizeString(row["Building Address"]),
        [FIELDS.building.status]: normalizeString(row["Building Status"]),
      };
      if (buildingProps[FIELDS.building.status] && !ALLOWED.buildingStatus.includes(buildingProps[FIELDS.building.status] as (typeof ALLOWED.buildingStatus)[number])) {
        warnings.push({ level: "warning", message: `Building status "${buildingProps[FIELDS.building.status]}" is not in the allowed list.`, rowNumber });
      }
      if (!existing) {
        buildingsMap.set(buildingImportId, {
          buildingImportId,
          projectImportId,
          name: buildingProps[FIELDS.building.name] as string,
          code: buildingProps[FIELDS.building.code] as string,
          properties: pruneEmpty(buildingProps),
          unitImportIds: [unitImportId],
          warnings: [],
          errors: [],
        });
      } else {
        existing.unitImportIds.push(unitImportId);
        if (existing.projectImportId && projectImportId && existing.projectImportId !== projectImportId) {
          existing.errors.push(`Building "${buildingImportId}" appears under multiple Projects.`);
        }
      }
    }

    // Project aggregation
    if (projectImportId) {
      const existing = projectsMap.get(projectImportId);
      const projectProps = {
        [FIELDS.project.name]: normalizeString(row["Project Name"]),
        [FIELDS.project.code]: normalizeString(row["Project Code"]) || projectImportId,
        [FIELDS.project.status]: normalizeString(row["Project Status"]),
        [FIELDS.project.property_type]: normalizeString(row["Project Property Type"]),
        [FIELDS.project.address]: normalizeString(row["Project Address"]),
      };
      const status = projectProps[FIELDS.project.status] as string;
      if (status && !ALLOWED.projectStatus.includes(status as (typeof ALLOWED.projectStatus)[number])) {
        warnings.push({ level: "warning", message: `Project status "${status}" is not in the allowed list.`, rowNumber });
      }
      const pt = projectProps[FIELDS.project.property_type] as string;
      if (pt && !ALLOWED.projectPropertyType.includes(pt as (typeof ALLOWED.projectPropertyType)[number])) {
        warnings.push({ level: "warning", message: `Project property type "${pt}" is not in the allowed list.`, rowNumber });
      }
      if (!existing) {
        projectsMap.set(projectImportId, {
          projectImportId,
          name: projectProps[FIELDS.project.name] as string,
          code: projectProps[FIELDS.project.code] as string,
          properties: pruneEmpty(projectProps),
          buildingImportIds: buildingImportId ? [buildingImportId] : [],
          warnings: [],
          errors: [],
        });
      } else if (buildingImportId && !existing.buildingImportIds.includes(buildingImportId)) {
        existing.buildingImportIds.push(buildingImportId);
      }
    }
  });

  // Mode-level rules
  if (mode === "Project + Buildings + Units") {
    if (projectIds.size > 1) errors.push({ level: "error", message: `Project mode allows exactly one Project Import ID; found ${projectIds.size}.` });
    if (projectIds.size === 0) errors.push({ level: "error", message: "Project mode requires a Project Import ID." });
    if (buildingIds.size === 0) errors.push({ level: "error", message: "Project mode requires at least one Building." });
    if (units.length === 0) errors.push({ level: "error", message: "Project mode requires at least one Unit." });
  } else if (mode === "Building + Units") {
    if (buildingIds.size > 1) errors.push({ level: "error", message: `Building mode allows exactly one Building Import ID; found ${buildingIds.size}.` });
    if (buildingIds.size === 0) errors.push({ level: "error", message: "Building mode requires a Building Import ID." });
    if (units.length === 0) errors.push({ level: "error", message: "Building mode requires at least one Unit." });
  } else if (mode === "Units Only") {
    if (units.length === 0) errors.push({ level: "error", message: "Units-only mode requires at least one Unit." });
  }

  // Structural: buildings must have units, projects must have buildings-with-units
  for (const b of buildingsMap.values()) {
    if (b.unitImportIds.length === 0) b.errors.push("Building has no Units.");
  }
  for (const p of projectsMap.values()) {
    if (p.buildingImportIds.length === 0) p.errors.push("Project has no Buildings.");
  }
  for (const b of buildingsMap.values()) errors.push(...b.errors.map((message) => ({ level: "error" as const, message: `[Building ${b.buildingImportId}] ${message}` })));
  for (const p of projectsMap.values()) errors.push(...p.errors.map((message) => ({ level: "error" as const, message: `[Project ${p.projectImportId}] ${message}` })));

  return {
    mode,
    totalRows: rows.length,
    skippedRows: skipped,
    effectiveRows: rows.length - skipped,
    errors,
    warnings,
    projects: [...projectsMap.values()],
    buildings: [...buildingsMap.values()],
    units,
  };
}

function pruneEmpty<T extends Record<string, unknown>>(o: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v === "") continue;
    out[k] = v;
  }
  return out as T;
}
