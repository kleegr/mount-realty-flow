/**
 * Rollup counts: recalc Building + Project totals FROM UNIT records.
 * Units are the source of truth per spec §9.
 *
 * INVARIANT (owner-required): available can NEVER exceed total. More strongly,
 * total is not an independent number at all — it is defined as the count of
 * units actually seen:
 *
 *   total === available + reserved + underContract + sold + unclassified
 *
 * coherent() below enforces that on every write, so no code path — present or
 * future — can emit an impossible set like "Total 4 / Available 7".
 *
 * The other half of that guarantee lives in flex-mapping.ts: these count
 * fields are no longer importable from a spreadsheet. Two writers owning the
 * same numbers is what allowed them to contradict each other.
 */
import type { CrmClient } from "./client.server";
import { FIELDS } from "./field-map";
import { normalizeRecordProperties, requestObject } from "./object-config.server";

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

/**
 * Force the summary into a self-consistent shape before it can be written.
 * Every bucket is a non-negative integer, and total is recomputed as the sum
 * of the buckets — so available > total is arithmetically unreachable.
 */
export function coherent(s: UnitStateSummary): UnitStateSummary {
  const nn = (n: unknown) => Math.max(0, Math.trunc(Number(n) || 0));
  const available = nn(s.available);
  const reserved = nn(s.reserved);
  const underContract = nn(s.underContract);
  const sold = nn(s.sold);
  const unclassified = nn(s.unclassified);
  const total = available + reserved + underContract + sold + unclassified;
  if (nn(s.total) !== total) {
    console.warn(
      `[rollup] incoherent summary (total ${s.total} vs counted ${total}); writing ${total}.`,
    );
  }
  return { total, available, reserved, underContract, sold, unclassified };
}

/**
 * WHY recalc_requested IS NOT WRITTEN HERE.
 *
 * It used to ride along in this payload. On 2026-07-16 that took down every
 * rollup write in the location:
 *
 *   PUT /objects/custom_objects.buildings/records/{id} -> 422
 *   "We couldn't apply updates to Recalc Requested due to an unexpected format."
 *
 * — 71 buildings, all of them, so recalcAllRollups reported "0 buildings" while
 * the counts it had correctly computed were thrown away.
 *
 * The cause is a documented-but-unmeasured assumption in needsArrayWrap():
 * MULTIPLE_OPTIONS was measured to reject arrays on PUT, and CHECKBOX was
 * assumed to accept them. recalc_requested is a checkbox, so it is sent as
 * ["no"] and rejected the same way property_type: ["condo"] was.
 *
 * The fix is NOT to loosen needsArrayWrap on a hunch — the unit writes depend
 * on it and demonstrably work. The fix is that a cosmetic "please recount me"
 * flag must never share a payload with the numbers. Counts are load-bearing;
 * the flag is not. They are now written separately, and only the counts can
 * fail the operation.
 */
async function clearRecalcFlag(client: CrmClient, scope: "building" | "project", crmId: string): Promise<void> {
  try {
    const key = scope === "building" ? FIELDS.building.recalc_requested : FIELDS.project.recalc_requested;
    const properties = await normalizeRecordProperties(client, scope, { [key]: "No" }, { forUpdate: true });
    if (Object.keys(properties).length === 0) return;
    await requestObject(client, "PUT", scope, `/records/${crmId}`, { body: { properties } });
  } catch (err) {
    // Never fatal. The counts are already saved by the time we get here.
    console.warn(
      `[rollup] could not clear recalc_requested on ${scope} ${crmId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

export async function writeBuildingRollup(
  client: CrmClient,
  buildingCrmId: string,
  summary: UnitStateSummary,
  opts?: { clearFlag?: boolean },
) {
  const s = coherent(summary);
  // forUpdate: true — this is a PUT. GHL's update endpoint rejects the
  // MULTIPLE_OPTIONS array shape its create endpoint accepts.
  const properties = await normalizeRecordProperties(client, "building", {
    [FIELDS.building.total_units]: s.total,
    [FIELDS.building.available_units]: s.available,
    [FIELDS.building.reserved_locked_units]: s.reserved,
    [FIELDS.building.under_contract_units]: s.underContract,
    [FIELDS.building.sold_units]: s.sold,
  }, { forUpdate: true });
  await requestObject(client, "PUT", "building", `/records/${buildingCrmId}`, {
    body: {
      properties,
    },
  });
  // Opt-in: doubles the write count, so the bulk recalc leaves it off.
  if (opts?.clearFlag) await clearRecalcFlag(client, "building", buildingCrmId);
}

export async function writeProjectRollup(
  client: CrmClient,
  projectCrmId: string,
  summary: UnitStateSummary,
  opts?: { clearFlag?: boolean },
) {
  const s = coherent(summary);
  const properties = await normalizeRecordProperties(client, "project", {
    [FIELDS.project.total_units]: s.total,
    [FIELDS.project.available_units]: s.available,
    [FIELDS.project.reserved_locked_units]: s.reserved,
    [FIELDS.project.under_contract_units]: s.underContract,
    [FIELDS.project.sold_units]: s.sold,
  }, { forUpdate: true });
  await requestObject(client, "PUT", "project", `/records/${projectCrmId}`, {
    body: {
      properties,
    },
  });
  if (opts?.clearFlag) await clearRecalcFlag(client, "project", projectCrmId);
}

export interface RollupRecalcResult {
  buildings: number;
  projects: number;
  failed: Array<{ scope: "building" | "project"; crmId: string; message: string }>;
  skipped: string | null;
}

/**
 * Recompute EVERY Building and Project rollup from the units mapped to them.
 * This is the repair path for records whose numbers were written by something
 * other than this engine (a spreadsheet column, a hand edit in GHL).
 *
 * Parentage comes from external_id_map (unit.parent_crm_id -> building,
 * building.parent_crm_id -> project), which is the same source the Unit Report
 * renders from. A unit with no mirrored state counts toward `total` as
 * unclassified rather than being dropped — undercounting total is what makes
 * "available > total" possible in the first place.
 *
 * Deliberately NEVER writes a record with zero known units: a building whose
 * units aren't mapped locally would otherwise be zeroed out, which is worse
 * than leaving it alone. Those are reported as untouched.
 *
 * Cost: one PUT per building + per project, so this is called on explicit
 * "Sync now" only, never on the background poll.
 */
export async function recalcAllRollups(client?: CrmClient): Promise<RollupRecalcResult> {
  const result: RollupRecalcResult = { buildings: 0, projects: 0, failed: [], skipped: null };

  let c: CrmClient;
  try {
    const { createCrmClient } = await import("./client.server");
    c = client ?? (await createCrmClient());
  } catch (err) {
    result.skipped = `CRM not configured: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [unitsRes, buildingsRes, statesRes] = await Promise.all([
    supabaseAdmin.from("external_id_map").select("crm_record_id, parent_crm_id").eq("scope", "unit"),
    supabaseAdmin.from("external_id_map").select("crm_record_id, parent_crm_id").eq("scope", "building"),
    supabaseAdmin.from("unit_state").select("unit_crm_id, availability, stage"),
  ]);

  const stateMap = new Map<string, { availability: string; stage: string }>();
  for (const s of statesRes.data ?? []) {
    stateMap.set(s.unit_crm_id, { availability: s.availability ?? "", stage: s.stage ?? "" });
  }

  type U = { availability: string; stage: string };
  const byBuilding = new Map<string, U[]>();
  for (const u of unitsRes.data ?? []) {
    const parent = u.parent_crm_id;
    if (!parent) continue;
    const st = stateMap.get(u.crm_record_id) ?? { availability: "", stage: "" };
    const arr = byBuilding.get(parent) ?? [];
    arr.push(st);
    byBuilding.set(parent, arr);
  }

  const buildingParent = new Map<string, string | null>();
  for (const b of buildingsRes.data ?? []) buildingParent.set(b.crm_record_id, b.parent_crm_id);

  const byProject = new Map<string, U[]>();
  for (const [buildingId, units] of byBuilding) {
    const projectId = buildingParent.get(buildingId);
    if (!projectId) continue;
    const arr = byProject.get(projectId) ?? [];
    arr.push(...units);
    byProject.set(projectId, arr);
  }

  for (const [buildingId, units] of byBuilding) {
    try {
      await writeBuildingRollup(c, buildingId, summarize(units));
      result.buildings++;
    } catch (err) {
      result.failed.push({ scope: "building", crmId: buildingId, message: err instanceof Error ? err.message : String(err) });
    }
  }
  for (const [projectId, units] of byProject) {
    try {
      await writeProjectRollup(c, projectId, summarize(units));
      result.projects++;
    } catch (err) {
      result.failed.push({ scope: "project", crmId: projectId, message: err instanceof Error ? err.message : String(err) });
    }
  }

  return result;
}
