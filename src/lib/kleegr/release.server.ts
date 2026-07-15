/**
 * Unit release engine — the single place a locked/reserved unit returns to
 * Available. Used by:
 *
 *   - the self-healing reconcile sweep (runs on every dashboard view, throttled)
 *   - the opportunity-deleted webhook
 *   - the unit-associated webhook (SELECTED_UNIT_CHANGED)
 *   - the manual release-units admin endpoint
 *
 * Every release updates BOTH sides (the GHL Unit record and the unit_state
 * mirror the dashboard reads), clears the holder, recomputes parent rollups,
 * and writes an audit event carrying a machine-readable reason code.
 *
 * Safety rules, in order:
 *   1. Closed/Sold never auto-releases. Only MANUAL_UNIT_RELEASE may free it.
 *   2. Releasing an already-Available unit is a successful no-op (idempotent).
 *   3. Callers that decide WHETHER to release use strict CRM reads. A
 *      transient CRM outage must never look like "the association is gone" —
 *      on any read failure the unit is SKIPPED, never released.
 */
import type { CrmClient } from "./client.server";
import { FIELDS } from "./field-map";
import { normalizeRecordProperties, requestObject } from "./object-config.server";

export type ReleaseReason =
  | "UNIT_ASSOCIATION_REMOVED"   // locked association deleted / switched to suggested
  | "SELECTED_UNIT_CHANGED"      // a different unit was locked for the same opportunity
  | "OPPORTUNITY_DELETED"        // the holding opportunity no longer exists
  | "OPPORTUNITY_LOST"           // the holding opportunity is lost/abandoned
  | "MOVED_TO_RELEASE_STAGE"     // the holding opportunity sits in a release stage
  | "MANUAL_UNIT_RELEASE";       // human-initiated force release

export interface ReleaseResult {
  unitCrmId: string;
  released: boolean;
  outcome: string; // released | already_available | sold_protected | ghl_failed:... | mirror_failed:...
  reason?: ReleaseReason;
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
    return { unitCrmId, released: false, outcome: "sold_protected", reason };
  }

  // Rule 2: idempotent no-op.
  if (row && currentAvailability === "Available" && !currentStage) {
    await clearHolder(unitCrmId);
    return { unitCrmId, released: false, outcome: "already_available", reason };
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
      reason,
    };
  }

  // ---- Mirror side.
  const { error: upErr } = await supabaseAdmin.from("unit_state").upsert(
    { unit_crm_id: unitCrmId, availability: "Available", stage: "" },
    { onConflict: "unit_crm_id" },
  );
  if (upErr) {
    return { unitCrmId, released: false, outcome: `mirror_failed: ${upErr.message}`, reason };
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

  return { unitCrmId, released: true, outcome: "released", reason };
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

function normStage(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------------------
// Pipeline catalog (stage id -> name) + release rules from crm_pipelines
// ---------------------------------------------------------------------------

interface PipelineCatalog {
  stageNameById: Map<string, string>;
  pipelineNameById: Map<string, string>;
}

async function fetchPipelineCatalog(c: CrmClient): Promise<PipelineCatalog | null> {
  const locationId = c.config.location_id;
  if (!locationId) return null;
  try {
    const res = await c.request<{ pipelines?: Array<Record<string, unknown>> }>(
      "GET",
      "/opportunities/pipelines",
      { query: { locationId } },
    );
    const stageNameById = new Map<string, string>();
    const pipelineNameById = new Map<string, string>();
    for (const p of res.data?.pipelines ?? []) {
      const pid = typeof p.id === "string" ? p.id : null;
      if (pid && typeof p.name === "string") pipelineNameById.set(pid, p.name);
      const stages = Array.isArray(p.stages) ? (p.stages as Array<Record<string, unknown>>) : [];
      for (const s of stages) {
        if (typeof s.id === "string" && typeof s.name === "string") stageNameById.set(s.id, s.name);
      }
    }
    return { stageNameById, pipelineNameById };
  } catch (err) {
    console.warn("[release] pipeline catalog fetch failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

interface ReleaseRule {
  releaseNames: Set<string>; // normalized
}

interface ReleaseRules {
  byPipelineId: Map<string, ReleaseRule>;
  byPipelineName: Map<string, ReleaseRule>;
}

async function loadReleaseRules(): Promise<ReleaseRules> {
  const rules: ReleaseRules = { byPipelineId: new Map(), byPipelineName: new Map() };
  const supabaseAdmin = await admin();
  const { data, error } = await supabaseAdmin
    .from("crm_pipelines")
    .select("pipeline_id, pipeline_name, stage_release_name, release_stage_names");
  if (error || !data) return rules;
  for (const row of data as Array<Record<string, unknown>>) {
    const releaseNames = new Set<string>();
    const single = row.stage_release_name;
    if (typeof single === "string" && single.trim()) releaseNames.add(normStage(single));
    const list = row.release_stage_names;
    if (Array.isArray(list)) {
      for (const n of list) if (typeof n === "string" && n.trim()) releaseNames.add(normStage(n));
    }
    if (releaseNames.size === 0) continue;
    const rule: ReleaseRule = { releaseNames };
    if (typeof row.pipeline_id === "string" && row.pipeline_id) rules.byPipelineId.set(row.pipeline_id, rule);
    if (typeof row.pipeline_name === "string" && row.pipeline_name) rules.byPipelineName.set(normStage(row.pipeline_name), rule);
  }
  return rules;
}

interface OppSnapshot {
  exists: boolean;
  status: string | null;
  pipelineId: string | null;
  stageId: string | null;
}

async function fetchOpportunitySnapshot(c: CrmClient, oppId: string): Promise<OppSnapshot | "error"> {
  try {
    const res = await c.request<Record<string, unknown>>("GET", `/opportunities/${oppId}`, {});
    const d = (res.data ?? {}) as Record<string, unknown>;
    const opp = (d.opportunity && typeof d.opportunity === "object" ? d.opportunity : d) as Record<string, unknown>;
    const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
    return {
      exists: true,
      status: (str(opp.status) ?? "").toLowerCase() || null,
      pipelineId: str(opp.pipelineId) ?? str(opp.pipeline_id),
      stageId: str(opp.pipelineStageId) ?? str(opp.stageId) ?? str(opp.pipeline_stage_id),
    };
  } catch (err) {
    if (isNotFound(err)) return { exists: false, status: null, pipelineId: null, stageId: null };
    return "error";
  }
}

/**
 * Self-healing reconcile: for every unit whose lock was placed by an
 * opportunity, verify against the LIVE CRM that the hold is still justified.
 * Release when:
 *   - the opportunity no longer exists / is deleted   -> OPPORTUNITY_DELETED
 *   - the opportunity is lost or abandoned            -> OPPORTUNITY_LOST
 *   - the opportunity sits in a configured release    -> MOVED_TO_RELEASE_STAGE
 *     stage (covers GHL workflows that never fired)
 *   - the Locked/Reserved association is gone         -> UNIT_ASSOCIATION_REMOVED
 *
 * Never touches: Closed/Sold units, units with no recorded holder
 * (import-owned state), or anything whose CRM read failed.
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
  for (const row of (held ?? []) as Array<Record<string, unknown>>) {
    const opp = typeof row.held_by_opportunity_id === "string" ? row.held_by_opportunity_id : null;
    const unitCrmId = typeof row.unit_crm_id === "string" ? row.unit_crm_id : null;
    if (!opp || !unitCrmId) continue;
    const stage = String(row.stage ?? "").trim();
    if (stage === "Closed/Sold") continue; // terminal — rule 1
    const arr = byOpp.get(opp) ?? [];
    arr.push({ unitCrmId, stage });
    byOpp.set(opp, arr);
  }

  if (byOpp.size === 0) return result;

  const [catalog, rules] = await Promise.all([fetchPipelineCatalog(c), loadReleaseRules()]);
  const { fetchUnitAssociationSets } = await import("./opportunities.server");

  for (const [oppId, units] of byOpp) {
    result.checked += units.length;

    // 1) Does the opportunity still exist, and in what state?
    const snap = await fetchOpportunitySnapshot(c, oppId);
    if (snap === "error") {
      result.skipped.push({ opportunityId: oppId, reason: "opportunity read failed (transient) — not releasing on a guess" });
      continue;
    }

    if (!snap.exists || snap.status === "deleted") {
      for (const u of units) {
        result.released.push(await releaseUnit(c, u.unitCrmId, "OPPORTUNITY_DELETED", oppId));
      }
      continue;
    }

    if (snap.status === "lost" || snap.status === "abandoned") {
      for (const u of units) {
        result.released.push(await releaseUnit(c, u.unitCrmId, "OPPORTUNITY_LOST", oppId));
      }
      continue;
    }

    // 2) Is the opportunity sitting in a release stage? (Covers GHL workflows
    //    that never fired for backward moves.)
    if (snap.pipelineId && snap.stageId && catalog) {
      const stageName = catalog.stageNameById.get(snap.stageId) ?? null;
      const pipelineName = catalog.pipelineNameById.get(snap.pipelineId) ?? null;
      const rule = rules.byPipelineId.get(snap.pipelineId)
        ?? (pipelineName ? rules.byPipelineName.get(normStage(pipelineName)) : undefined);
      if (rule && stageName && rule.releaseNames.has(normStage(stageName))) {
        for (const u of units) {
          result.released.push(await releaseUnit(c, u.unitCrmId, "MOVED_TO_RELEASE_STAGE", oppId));
        }
        continue;
      }
    }

    // 3) Does it still hold each unit via a Locked/Reserved association?
    let lockedIds: Set<string>;
    try {
      const sets = await fetchUnitAssociationSets(c, oppId);
      if (!sets.lockedAssociationDefined) {
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
