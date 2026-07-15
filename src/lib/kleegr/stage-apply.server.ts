import { FIELDS } from "./field-map";
import { normalizeRecordProperties, requestObject } from "./object-config.server";
import { normalizeStagePayload } from "./webhook-payload.server";

/**
 * Shared stage-change application logic.
 * Used by both the opportunity-stage webhook and the unit-associated replay webhook.
 *
 * Two application targets:
 *   1. Unit    — default. Applies availability/stage to the Unit + rolls up
 *                totals to parent Building & Project.
 *   2. Building — for "whole building" sales (villa/house sold as a single
 *                unit at the Building level). Applies status directly to the
 *                Building record; no rollup, since the Building IS the unit.
 *
 * Stage classification (see classifyStage):
 *   - reserved / under_contract / closed  → lock the unit to that state
 *   - release_stage_names[] (or legacy stage_release_name) → free the unit back
 *     to Available. This covers a deal moving BACKWARD (e.g. contract fell
 *     through → back to Meeting / Showing) as well as Lost / Not Interested.
 *   - anything else → stage_not_mapped, unit keeps its current state. This is
 *     deliberate: mid-contract stages such as Payment Tracking or Attorney /
 *     Title must HOLD Under Contract, not release it.
 *
 * Ownership rules:
 *   - Closed/Sold is terminal. Only a human can undo it.
 *   - While a unit is locked, unit_state.held_by_opportunity_id records WHICH
 *     opportunity holds it. The holding opportunity may move freely in either
 *     direction (Reserved <-> Under Contract, or back out to Available).
 *     A DIFFERENT opportunity cannot touch the unit until it is released.
 */
export interface StageChangeInput {
  pipelineId: string | null;
  stageId: string | null;
  pipelineName?: string | null;
  stageName?: string | null;
  opportunityId: string | null;
  unitCrmIdHint: string | null;
  unitExternalId: string | null;
  buildingCrmIdHint?: string | null;
  buildingExternalId?: string | null;
  /** When true and no unit/building reference is provided, look them up via the GHL API using opportunityId. */
  autoFetchAssociations?: boolean;
}

export interface StageChangeOutcome {
  outcome: string;
  unitCrmId?: string;
  buildingCrmId?: string;
  message?: string;
}


export async function processStageChange(params: StageChangeInput): Promise<StageChangeOutcome> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const cfg = await supabaseAdmin.from("crm_config").select("*").eq("id", 1).maybeSingle();
  if (!cfg.data) return { outcome: "no_config" };

  // Resolve Unit reference (preferred)
  let unitCrmId = params.unitCrmIdHint ?? null;
  if (!unitCrmId && params.unitExternalId) {
    const map = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id")
      .eq("scope", "unit")
      .eq("external_import_id", params.unitExternalId)
      .maybeSingle();
    unitCrmId = map.data?.crm_record_id ?? null;
  }

  // Resolve Building reference (fallback: whole-building sale)
  let buildingCrmId = params.buildingCrmIdHint ?? null;
  if (!unitCrmId && !buildingCrmId && params.buildingExternalId) {
    const map = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id")
      .eq("scope", "building")
      .eq("external_import_id", params.buildingExternalId)
      .maybeSingle();
    buildingCrmId = map.data?.crm_record_id ?? null;
  }

  // AUTO-FETCH: if we still have no unit/building reference but we do have an
  // opportunity ID, ask GHL for the opportunity's associations. This lets the
  // salesperson simply move the stage in GHL — the app figures out the linked
  // unit itself, no custom field / no manual paste required.
  if (!unitCrmId && !buildingCrmId && params.opportunityId && params.autoFetchAssociations !== false) {
    try {
      const { createCrmClient } = await import("./client.server");
      const { fetchOpportunityAssociations } = await import("./opportunities.server");
      const found = await fetchOpportunityAssociations(await createCrmClient(), params.opportunityId);
      unitCrmId = found.unitCrmId;
      buildingCrmId = found.buildingCrmId;
    } catch (err) {
      console.warn("Auto-fetch of opportunity associations failed:", err instanceof Error ? err.message : err);
    }
  }

  if (!unitCrmId && !buildingCrmId) return { outcome: "no_unit_reference" };

  // Resolve stage mapping (shared between Unit and Building paths)
  const stageMapping = await resolveStageMapping(supabaseAdmin, params.pipelineId, params.pipelineName ?? null, cfg.data);
  const target = classifyStage(params.stageId, params.stageName ?? null, stageMapping);
  if (!target) {
    return {
      outcome: "stage_not_mapped",
      unitCrmId: unitCrmId ?? undefined,
      buildingCrmId: buildingCrmId ?? undefined,
      message: `Stage "${params.stageName ?? params.stageId ?? "unknown"}" in pipeline "${params.pipelineName ?? params.pipelineId ?? "unknown"}" is not mapped in Settings.`,
    };
  }

  // Building-level sale: apply directly to Building record, no rollup.
  if (!unitCrmId && buildingCrmId) {
    return applyBuildingStage(buildingCrmId, target, params);
  }

  // Unit path (default) — unitCrmId is guaranteed non-null here.
  const unitId = unitCrmId!;
  const { availability, stage, inventoryDeducted } = target;
  const incomingOpportunityId = params.opportunityId ?? null;

  // Cached state: who holds this unit, and its parents (for rollups).
  // Read BEFORE any write so the ownership guards can use it.
  const { data: cachedState } = await supabaseAdmin
    .from("unit_state")
    .select("building_crm_id, project_crm_id, held_by_opportunity_id")
    .eq("unit_crm_id", unitId)
    .maybeSingle();
  const heldBy = cachedState?.held_by_opportunity_id ?? null;

  const { createCrmClient } = await import("./client.server");
  const { readRecord } = await import("./objects.server");
  let currentStage = "";
  let currentAvailability = "";
  try {
    const cur = await readRecord(await createCrmClient(), "unit", unitId);
    const props = extractProps(cur);
    currentStage = normalizeUnitStage(props?.["stages"]);
    currentAvailability = normalizeAvailability(props?.[FIELDS.unit.availability]);
  } catch (err) {
    return { outcome: "read_failed", unitCrmId: unitId, message: err instanceof Error ? err.message : String(err) };
  }

  // ---- Guard 1: Closed/Sold is terminal. Nothing automated reverses a sale.
  if (currentStage === "Closed/Sold" && stage !== "Closed/Sold") {
    return {
      outcome: "blocked_sold_reversal",
      unitCrmId: unitId,
      message: "Unit is Sold. Releasing a sold unit must be done manually.",
    };
  }

  // ---- Guard 2: a DIFFERENT opportunity is holding this unit.
  // The holder may move freely (forward, backward, or release). Anyone else is
  // locked out until the holder gives it up.
  const isLocked = currentAvailability === "Not Available" && currentStage !== "";
  if (isLocked && heldBy && incomingOpportunityId && heldBy !== incomingOpportunityId) {
    return {
      outcome: "blocked_held_by_other_opportunity",
      unitCrmId: unitId,
      message: `Unit is ${currentStage} under opportunity ${heldBy}. Release it there first.`,
    };
  }

  // ---- Guard 3: legacy fallback. No holder on record (state came from an
  // import or a CRM sync rather than a webhook), so we cannot prove the
  // incoming opportunity owns the lock. Refuse a fresh reservation on a unit
  // that is already locked in a different state.
  if (
    !heldBy
    && stage === "Reserved/Locked"
    && currentAvailability === "Not Available"
    && currentStage
    && currentStage !== "Reserved/Locked"
  ) {
    return {
      outcome: "blocked_double_reservation",
      unitCrmId: unitId,
      message: `Unit is currently ${currentStage}.`,
    };
  }

  const client = await createCrmClient();
  const properties = await normalizeRecordProperties(client, "unit", {
    [FIELDS.unit.availability]: availability,
    [FIELDS.unit.stage]: stage,
    [FIELDS.unit.inventory_deducted]: inventoryDeducted,
    [FIELDS.unit.locked_date]: stage === "Reserved/Locked" ? new Date().toISOString().slice(0, 10) : "",
  });
  await requestObject(client, "PUT", "unit", `/records/${unitId}`, {
    body: {
      properties,
    },
  });

  // Locking records the holder; releasing clears it.
  const nextHeldBy = stage ? (incomingOpportunityId ?? heldBy) : null;
  await supabaseAdmin.from("unit_state").upsert(
    {
      unit_crm_id: unitId,
      availability: availability ?? "",
      stage: stage ?? "",
      held_by_opportunity_id: nextHeldBy,
    },
    { onConflict: "unit_crm_id" },
  );

  const buildingId = cachedState?.building_crm_id ?? null;
  const projectId = cachedState?.project_crm_id ?? null;

  if (buildingId || projectId) {
    const { summarize, writeBuildingRollup, writeProjectRollup } = await import("./rollups.server");
    if (buildingId) {
      const { data: siblings } = await supabaseAdmin
        .from("unit_state").select("availability, stage").eq("building_crm_id", buildingId);
      try {
        await writeBuildingRollup(client, buildingId, summarize((siblings ?? []).map((r) => ({ availability: r.availability ?? "", stage: r.stage ?? "" }))));
      } catch (err) { console.error("Building rollup failed:", err); }
    }
    if (projectId) {
      const { data: siblings } = await supabaseAdmin
        .from("unit_state").select("availability, stage").eq("project_crm_id", projectId);
      try {
        await writeProjectRollup(client, projectId, summarize((siblings ?? []).map((r) => ({ availability: r.availability ?? "", stage: r.stage ?? "" }))));
      } catch (err) { console.error("Project rollup failed:", err); }
    }
  }

  await supabaseAdmin.from("audit_events").insert({
    kind: "opportunity_stage_change",
    entity_scope: "unit",
    entity_crm_id: unitId,
    previous: { availability: currentAvailability, stage: currentStage, held_by: heldBy } as never,
    next: { availability, stage, held_by: nextHeldBy } as never,
    reason: `Opportunity ${incomingOpportunityId ?? ""} moved to stage ${params.stageName ?? params.stageId ?? ""}`,
  });

  return { outcome: `applied:${stage || "available"}`, unitCrmId: unitId };
}

// ============================================================================
// Helpers (shared by Unit and Building code paths)
// ============================================================================

interface StageMapping {
  stage_reserved_id: string | null;
  stage_under_contract_id: string | null;
  stage_closed_id: string | null;
  stage_release_id: string | null;
  stage_reserved_name?: string | null;
  stage_under_contract_name?: string | null;
  stage_closed_name?: string | null;
  stage_release_name?: string | null;
  /**
   * Every stage that should FREE the unit back to Available.
   * Typically the early/browsing stages (New Inquiry … Meeting / Showing) plus
   * any explicit Lost / Released stage. A deal moving backward into one of
   * these means the hold is over.
   */
  release_stage_names?: string[] | null;
}

interface StageTarget {
  availability: string;
  stage: string;
  inventoryDeducted: string;
}

const RESERVED: StageTarget = { availability: "Not Available", stage: "Reserved/Locked", inventoryDeducted: "Yes" };
const UNDER_CONTRACT: StageTarget = { availability: "Not Available", stage: "Under Contract", inventoryDeducted: "Yes" };
const SOLD: StageTarget = { availability: "Not Available", stage: "Closed/Sold", inventoryDeducted: "Yes" };
const RELEASED: StageTarget = { availability: "Available", stage: "", inventoryDeducted: "No" };

async function resolveStageMapping(
  supabaseAdmin: Awaited<ReturnType<typeof importAdmin>>,
  pipelineId: string | null,
  pipelineName: string | null,
  cfg: StageMapping,
): Promise<StageMapping> {
  const cols = "stage_reserved_id, stage_under_contract_id, stage_closed_id, stage_release_id, stage_reserved_name, stage_under_contract_name, stage_closed_name, stage_release_name, release_stage_names";
  if (pipelineId) {
    const pl = await supabaseAdmin.from("crm_pipelines").select(cols).eq("pipeline_id", pipelineId).maybeSingle();
    if (pl.data) return pl.data as StageMapping;
  }
  if (pipelineName) {
    const pl = await supabaseAdmin.from("crm_pipelines").select(cols).eq("pipeline_name", pipelineName).maybeSingle();
    if (pl.data) return pl.data as StageMapping;
  }
  return cfg;
}

function classifyStage(stageId: string | null, stageName: string | null, m: StageMapping): StageTarget | null {
  // Match by ID first (exact), then by name (case-insensitive)
  const idMatch = matchById(stageId, m);
  if (idMatch) return idMatch;
  return matchByName(stageName, m);
}

function matchById(stageId: string | null, m: StageMapping): StageTarget | null {
  if (!stageId) return null;
  if (stageId === m.stage_reserved_id) return RESERVED;
  if (stageId === m.stage_under_contract_id) return UNDER_CONTRACT;
  if (stageId === m.stage_closed_id) return SOLD;
  if (stageId === m.stage_release_id) return RELEASED;
  return null;
}

function matchByName(stageName: string | null, m: StageMapping): StageTarget | null {
  if (!stageName) return null;
  const s = normalizeStageName(stageName);
  if (!s) return null;
  const eq = (v?: string | null) => Boolean(v) && normalizeStageName(String(v)) === s;

  if (eq(m.stage_reserved_name)) return RESERVED;
  if (eq(m.stage_under_contract_name)) return UNDER_CONTRACT;
  if (eq(m.stage_closed_name)) return SOLD;
  if (eq(m.stage_release_name)) return RELEASED;

  // Any listed release stage frees the unit — this is what makes a deal moving
  // BACKWARD (e.g. back to Meeting / Showing) put the unit back on the market.
  const releaseList = m.release_stage_names ?? [];
  if (Array.isArray(releaseList) && releaseList.some((n) => Boolean(n) && normalizeStageName(String(n)) === s)) {
    return RELEASED;
  }

  return null;
}

/** Case/space-insensitive stage name comparison. */
function normalizeStageName(value: string): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildingStatusFor(stage: string): string {
  if (stage === "Reserved/Locked") return "Reserved / Locked";
  if (stage === "Under Contract") return "Under Contract";
  if (stage === "Closed/Sold") return "Sold Out";
  return "Active";
}

async function applyBuildingStage(
  buildingCrmId: string,
  target: StageTarget,
  params: StageChangeInput,
): Promise<StageChangeOutcome> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { createCrmClient } = await import("./client.server");
  const { readRecord } = await import("./objects.server");

  const client = await createCrmClient();
  let currentStatus = "";
  try {
    const cur = await readRecord(client, "building", buildingCrmId);
    const props = extractProps(cur);
    currentStatus = String(props?.["building_status"] ?? "");
  } catch (err) {
    return {
      outcome: "read_failed",
      buildingCrmId,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const nextStatus = buildingStatusFor(target.stage);
  if (currentStatus === "Sold Out" && nextStatus !== "Sold Out") {
    return { outcome: "blocked_sold_reversal", buildingCrmId };
  }

  await requestObject(client, "PUT", "building", `/records/${buildingCrmId}`, {
    body: { properties: await normalizeRecordProperties(client, "building", { [FIELDS.building.status]: nextStatus }) },
  });

  await supabaseAdmin.from("audit_events").insert({
    kind: "opportunity_stage_change",
    entity_scope: "building",
    entity_crm_id: buildingCrmId,
    previous: { building_status: currentStatus } as never,
    next: { building_status: nextStatus } as never,
    reason: `Opportunity ${params.opportunityId ?? ""} moved to stage ${params.stageName ?? params.stageId ?? ""} (whole-building sale)`,
  });

  return { outcome: `applied_building:${nextStatus}`, buildingCrmId };
}

async function importAdmin() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  return supabaseAdmin;
}


/**
 * Replay pending stage-change events for a given opportunity, now that a unit is known.
 * Called by the unit-associated webhook and the reprocess endpoint.
 */
export async function replayPendingForOpportunity(
  opportunityId: string,
  unitCrmId: string,
): Promise<{ replayed: number; outcomes: string[] }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: pending } = await supabaseAdmin
    .from("webhook_events")
    .select("id, pipeline_id, stage_id, opportunity_id, raw")
    .eq("opportunity_id", opportunityId)
    .eq("outcome", "pending_no_unit")
    .is("processed_at", null)
    .order("received_at", { ascending: true });

  const outcomes: string[] = [];
  for (const ev of pending ?? []) {
    const normalized = normalizeStagePayload((ev.raw ?? {}) as Record<string, unknown>);
    const res = await processStageChange({
      pipelineId: ev.pipeline_id ?? normalized.pipelineId,
      stageId: ev.stage_id ?? normalized.stageId,
      pipelineName: normalized.pipelineName,
      stageName: normalized.stageName,
      opportunityId: ev.opportunity_id ?? normalized.opportunityId,
      unitCrmIdHint: unitCrmId,
      unitExternalId: null,
    });
    outcomes.push(res.outcome);
    const shouldRemainPending = res.outcome === "no_unit_reference" || res.outcome === "read_failed";
    await supabaseAdmin
      .from("webhook_events")
      .update({
        processed_at: shouldRemainPending ? null : new Date().toISOString(),
        outcome: shouldRemainPending ? "pending_no_unit" : res.outcome,
        unit_crm_id: res.unitCrmId ?? unitCrmId,
        pipeline_id: ev.pipeline_id ?? normalized.pipelineId,
        stage_id: ev.stage_id ?? normalized.stageId,
        opportunity_id: ev.opportunity_id ?? normalized.opportunityId,
      })
      .eq("id", ev.id);
  }
  return { replayed: pending?.length ?? 0, outcomes };
}

function extractProps(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.properties && typeof d.properties === "object") return d.properties as Record<string, unknown>;
  const rec = d.record as Record<string, unknown> | undefined;
  if (rec?.properties && typeof rec.properties === "object") return rec.properties as Record<string, unknown>;
  return null;
}

function normalizeUnitStage(value: unknown): string {
  const raw = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
  const key = raw.trim().toLowerCase().replace(/[\s_/-]+/g, "");
  if (key === "reservedlocked") return "Reserved/Locked";
  if (key === "undercontract") return "Under Contract";
  if (key === "closedsold") return "Closed/Sold";
  return raw.trim();
}

function normalizeAvailability(value: unknown): string {
  const raw = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
  const key = raw.trim().toLowerCase().replace(/[\s_/-]+/g, "");
  if (key === "available") return "Available";
  if (key === "notavailable") return "Not Available";
  return raw.trim();
}
