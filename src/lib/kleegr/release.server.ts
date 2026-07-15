/**
 * Unit release engine — the single place a locked/reserved unit returns to
 * Available. Used by:
 *
 *   - the reconcile sweep (orphaned locks: association removed, opp deleted)
 *   - the opportunity-deleted webhook
 *   - the unit-associated webhook (SELECTED_UNIT_CHANGED: new unit locked,
 *     previous unit freed)
 *
 * Every release updates BOTH sides (the GHL Unit record and the unit_state
 * mirror the dashboard reads), clears the holder, recomputes parent rollups,
 * and writes an audit event carrying a machine-readable reason code.
 *
 * Safety rules, in order:
 *   1. Closed/Sold never auto-releases. Only MANUAL_UNIT_RELEASE may free it.
 *   2. Releasing an already-Available unit is a successful no-op (idempotent —
 *      GHL redelivers webhooks).
 *   3. Callers that decide WHETHER to release must use strict CRM reads that
 *      throw on failure (see fetchUnitAssociationSets). A transient CRM outage
 *      must never look like "the association is gone".
 */
import type { CrmClient } from "./client.server";
import { FIELDS } from "./field-map";
import { normalizeRecordProperties, requestObject } from "./object-config.server";

export type ReleaseReason =
  | "UNIT_ASSOCIATION_REMOVED"   // locked association deleted / moved back to suggested
  | "SELECTED_UNIT_CHANGED"      // a different unit was locked for the same opportunity
  | "OPPORTUNITY_DELETED"        // the holding opportunity no longer exists
  | "MOVED_TO_RELEASE_STAGE"     // (stage webhook path — logged for completeness)
  | "MANUAL_UNIT_RELEASE";       // human-initiated force release

export interface ReleaseResult {
  unitCrmId: string;
  released: boolean;
  outcome: string; // released | already_available | sold_protected | ghl_failed:... | mirror_failed:...
}

export interface ReconcileResult {
  checked: number;
  released: ReleaseResult[];
  keptHeld: number;
  skipped: Array<{ opportunityId: string; reason: string }>;
}

async function admin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}

/**
 * Release one unit back to Available on both sides.
 */
export async function releaseUnit(
  client: CrmClient,
  unitCrmId: string,
  reason: ReleaseReason,
  opportunityId?: string | null,
): Promise<ReleaseResult> {
  const supabaseAdmin = await admin();

  const { data: row } = await supabaseAdmin
    .from("unit_state")
    .select("availability, stage, building_crm_id, project_crm_id")
    .eq("unit_crm_id", unitCrmId)
    .maybeSingle();

  const currentStage = (row?.stage ?? "").trim();
  const currentAvailability = (row?.availability ?? "").trim();

  // Rule 1: a sale is terminal for every automated path.
  if (currentStage === "Closed/Sold" && reason !== "MANUAL_UNIT_RELEASE") {
    return { unitCrmId, released: false, outcome: "sold_protected" };
  }

  // Rule 2: idempotent no-op.
  if (row && currentAvailability === "Available" && !currentStage) {
    await clearHolder(unitCrmId);
    return { unitCrmId, released: false, outcome: "already_available" };
  }

  // ---- GHL side. Empty strings are stripped by normalizeRecordProperties,
  // so cleared fields are appended as explicit nulls (verified accepted).
  const setProps = await normalizeRecordProperties(client, "unit", {
    [FIELDS.unit.availability]: "Available",
    [FIELDS.unit.inventory_deducted]: "No",
  }, { forUpdate: true });
  const clearProps = {
    ...setProps,
    [FIELDS.unit.stage]: null,
    [FIELDS.unit.locked_date]: null,
  };

  try {
    await requestObject(client, "PUT", "unit", `/records/${unitCrmId}`, {
      body: { properties: clearProps },
    });
  } catch (err) {
    return {
      unitCrmId,
      released: false,
      outcome: `ghl_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ---- Mirror side.
  const { error: upErr } = await supabaseAdmin.from("unit_state").upsert(
    { unit_crm_id: unitCrmId, availability: "Available", stage: "" },
    { onConflict: "unit_crm_id" },
  );
  if (upErr) {
    return { unitCrmId, released: false, outcome: `mirror_failed: ${upErr.message}` };
  }
  await clearHolder(unitCrmId);

  // ---- Rollups for the parents we know about.
  await recomputeParents(client, row?.building_crm_id ?? null, row?.project_crm_id ?? null);

  // ---- Log.
  await supabaseAdmin.from("audit_events").insert({
    kind: "unit_release",
    entity_scope: "unit",
    entity_crm_id: unitCrmId,
    previous: { availability: currentAvailability || null, stage: currentStage || null } as never,
    next: { availability: "Available", stage: "" } as never,
    reason: `${reason}${opportunityId ? ` (opportunity ${opportunityId})` : ""}`,
  });

  return { unitCrmId, released: true, outcome: "released" };
}

async function clearHolder(unitCrmId: string): Promise<void> {
  const supabaseAdmin = await admin();
  // Best-effort: tolerate the ownership migration not having run.
  await supabaseAdmin
    .from("unit_state")
    .update({ held_by_opportunity_id: null })
    .eq("unit_crm_id", unitCrmId)
    .then(() => undefined, () => undefined);
}

async function recomputeParents(
  client: CrmClient,
  buildingId: string | null,
  projectId: string | null,
): Promise<void> {
  if (!buildingId && !projectId) return;
  const supabaseAdmin = await admin();
  const { summarize, writeBuildingRollup, writeProjectRollup } = await import("./rollups.server");
  if (buildingId) {
    try {
      const { data: siblings } = await supabaseAdmin
        .from("unit_state").select("availability, stage").eq("building_crm_id", buildingId);
      await writeBuildingRollup(client, buildingId, summarize((siblings ?? []).map((r) => ({ availability: r.availability ?? "", stage: r.stage ?? "" }))));
    } catch (err) { console.error("[release] building rollup failed:", err); }
  }
  if (projectId) {
    try {
      const { data: siblings } = await supabaseAdmin
        .from("unit_state").select("availability, stage").eq("project_crm_id", projectId);
      await writeProjectRollup(client, projectId, summarize((siblings ?? []).map((r) => ({ availability: r.availability ?? "", stage: r.stage ?? "" }))));
    } catch (err) { console.error("[release] project rollup failed:", err); }
  }
}

/**
 * Release every unit currently held by an opportunity (deletion handling).
 */
export async function releaseUnitsHeldBy(
  client: CrmClient,
  opportunityId: string,
  reason: ReleaseReason,
  exceptUnitCrmId?: string | null,
): Promise<ReleaseResult[]> {
  const supabaseAdmin = await admin();
  const { data: held, error } = await supabaseAdmin
    .from("unit_state")
    .select("unit_crm_id")
    .eq("held_by_opportunity_id", opportunityId);
  if (error) {
    // Column missing (migration not run) or query failure — nothing safe to do.
    console.warn("[release] held-by lookup failed:", error.message);
    return [];
  }
  const results: ReleaseResult[] = [];
  for (const row of held ?? []) {
    if (exceptUnitCrmId && row.unit_crm_id === exceptUnitCrmId) continue;
    results.push(await releaseUnit(client, row.unit_crm_id, reason, opportunityId));
  }
  return results;
}

function isNotFound(err: unknown): boolean {
  const status = (err as { status?: unknown })?.status;
  return status === 404 || status === 400;
}

/**
 * Reconcile sweep: for every unit whose lock was placed by an opportunity,
 * verify the opportunity still exists AND still holds the unit via a
 * Locked/Reserved association. Otherwise release it.
 *
 * Covers the events GHL fires no webhook for:
 *   - the unit was detached from the lead          -> UNIT_ASSOCIATION_REMOVED
 *   - the association was switched to Suggested    -> UNIT_ASSOCIATION_REMOVED
 *   - the opportunity was deleted from the pipeline-> OPPORTUNITY_DELETED
 *
 * Never touches:
 *   - Closed/Sold units (terminal)
 *   - units with no recorded holder (import-owned state)
 *   - anything when the CRM read fails (strict fetches; skip, don't guess)
 */
export async function reconcileHeldUnits(client?: CrmClient): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, released: [], keptHeld: 0, skipped: [] };

  let c: CrmClient;
  try {
    const { createCrmClient } = await import("./client.server");
    c = client ?? (await createCrmClient());
  } catch (err) {
    result.skipped.push({ opportunityId: "*", reason: `CRM not configured: ${err instanceof Error ? err.message : String(err)}` });
    return result;
  }

  const supabaseAdmin = await admin();
  const { data: held, error } = await supabaseAdmin
    .from("unit_state")
    .select("unit_crm_id, stage, held_by_opportunity_id")
    .not("held_by_opportunity_id", "is", null);
  if (error) {
    result.skipped.push({ opportunityId: "*", reason: `held-by lookup failed: ${error.message}` });
    return result;
  }

  // Group units by holding opportunity so each opp is fetched once.
  const byOpp = new Map<string, Array<{ unitCrmId: string; stage: string }>>();
  for (const row of held ?? []) {
    const opp = row.held_by_opportunity_id as string;
    const stage = (row.stage ?? "").trim();
    if (stage === "Closed/Sold") continue; // terminal — rule 1
    const arr = byOpp.get(opp) ?? [];
    arr.push({ unitCrmId: row.unit_crm_id, stage });
    byOpp.set(opp, arr);
  }

  const { fetchUnitAssociationSets } = await import("./opportunities.server");

  for (const [oppId, units] of byOpp) {
    result.checked += units.length;

    // 1) Does the opportunity still exist?
    let oppExists = true;
    try {
      await c.request("GET", `/opportunities/${oppId}`, {});
    } catch (err) {
      if (isNotFound(err)) {
        oppExists = false;
      } else {
        // Transient failure — do NOT release on a guess.
        result.skipped.push({ opportunityId: oppId, reason: `opportunity read failed: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
    }

    if (!oppExists) {
      for (const u of units) {
        result.released.push(await releaseUnit(c, u.unitCrmId, "OPPORTUNITY_DELETED", oppId));
      }
      continue;
    }

    // 2) Does it still hold each unit via a Locked/Reserved association?
    let lockedIds: Set<string>;
    try {
      const sets = await fetchUnitAssociationSets(c, oppId);
      if (!sets.lockedAssociationDefined) {
        // Nothing to filter on — cannot distinguish held from suggested. Skip.
        result.skipped.push({ opportunityId: oppId, reason: "no Locked/Reserved association defined; cannot verify" });
        continue;
      }
      lockedIds = new Set(sets.lockedUnitIds);
    } catch (err) {
      result.skipped.push({ opportunityId: oppId, reason: `associations read failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    for (const u of units) {
      if (lockedIds.has(u.unitCrmId)) {
        result.keptHeld++;
      } else {
        result.released.push(await releaseUnit(c, u.unitCrmId, "UNIT_ASSOCIATION_REMOVED", oppId));
      }
    }
  }

  return result;
}
