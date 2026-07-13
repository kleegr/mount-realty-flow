/**
 * Rollup counts: recalc Building + Project totals FROM UNIT records.
 * Units are the source of truth per spec §9.
 */
import type { CrmClient } from "./client.server";
import { FIELDS } from "./field-map";
import { normalizeRecordProperties, objectKey } from "./object-config.server";

export interface UnitStateSummary {
  total: number;
  available: number;
  reserved: number;
  underContract: number;
  sold: number;
  unclassified: number;
}

export function classifyUnit(unit: { availability?: string; stage?: string }): keyof Omit<UnitStateSummary, "total"> {
  const stage = (unit.stage ?? "").trim();
  const avail = (unit.availability ?? "").trim().toLowerCase();
  if (stage === "Closed/Sold") return "sold";
  if (stage === "Under Contract") return "underContract";
  if (stage === "Reserved/Locked") return "reserved";
  if (!stage && avail === "available") return "available";
  return "unclassified";
}

export function summarize(units: Array<{ availability?: string; stage?: string }>): UnitStateSummary {
  const summary: UnitStateSummary = { total: units.length, available: 0, reserved: 0, underContract: 0, sold: 0, unclassified: 0 };
  for (const u of units) summary[classifyUnit(u)]++;
  return summary;
}

export async function writeBuildingRollup(
  client: CrmClient,
  buildingCrmId: string,
  summary: UnitStateSummary,
) {
  const properties = await normalizeRecordProperties(client, "building", {
    [FIELDS.building.total_units]: summary.total,
    [FIELDS.building.available_units]: summary.available,
    [FIELDS.building.reserved_locked_units]: summary.reserved,
    [FIELDS.building.under_contract_units]: summary.underContract,
    [FIELDS.building.sold_units]: summary.sold,
    [FIELDS.building.recalc_requested]: "No",
  });
  await client.request("PUT", `/objects/${objectKey(client, "building")}/records/${buildingCrmId}`, {
    body: {
      properties,
    },
  });
}

export async function writeProjectRollup(
  client: CrmClient,
  projectCrmId: string,
  summary: UnitStateSummary,
) {
  const properties = await normalizeRecordProperties(client, "project", {
    [FIELDS.project.total_units]: summary.total,
    [FIELDS.project.available_units]: summary.available,
    [FIELDS.project.reserved_locked_units]: summary.reserved,
    [FIELDS.project.under_contract_units]: summary.underContract,
    [FIELDS.project.sold_units]: summary.sold,
    [FIELDS.project.recalc_requested]: "No",
  });
  await client.request("PUT", `/objects/${objectKey(client, "project")}/records/${projectCrmId}`, {
    body: {
      properties,
    },
  });
}
