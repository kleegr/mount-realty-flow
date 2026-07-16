import { FIELDS } from "./field-map";
import { normalizeRecordProperties, requestObject } from "./object-config.server";
import { normalizeStagePayload } from "./webhook-payload.server";

/**
 * Shared stage-change application logic.
 * Used by both the opportunity-stage webhook and the unit-associated replay webhook.
 *
 * RULE 1 — THE LOCKED/RESERVED LABEL IS THE ON SWITCH.
 * Only a unit associated to the opportunity via "Locked/Reserved Units" is
 * driven by stage changes. "Suggested Units" is browsing: a suggested unit is
 * never reserved, never released, never touched — whatever stage the deal is
 * in. When an opportunity's only units are Suggested, a stage change is not an
 * inventory event at all (outcome `ignored_suggested_only`) — it must NOT sit
 * in Pending Stage Events waiting for a human, because there is nothing to fix.
 *
 * RULE 2 — THE CARD'S CURRENT STAGE IS ABSOLUTE TRUTH.
 * Every stage in both pipelines maps to exactly one status via the
 * crm_pipelines lists:
 *   reserved_stage_names[]        -> Reserved/Locked
 *   under_contract_stage_names[]  -> Under Contract   (incl. Payment Tracking,
 *                                    Attorney/Title stages)
 *   sold_stage_names[]            -> Closed/Sold      (Closing, Closing Gift)
 *   release_stage_names[]         -> Available        (everything early + Lost)
 * Direction of movement does not matter — dragging a card back out of Closing
 * un-sells the unit. There is no terminal state.
 *
 * Ownership: unit_state.held_by_opportunity_id records WHICH opportunity holds
 * a locked unit. The holder moves freely in either direction. A DIFFERENT
 * opportunity is normally locked out — BUT a recorded holder can be STALE (its
 * deal deleted / lost / moved back / label removed). So before blocking, the
 * holder is verified against the live CRM; an unjustified hold is
 * auto-released and the incoming change proceeds.
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
  /**
   * True for units named by an UNTRUSTED source (a GHL workflow payload): the
   * unit is checked against the live CRM and ignored unless it carries the
   * Locked/Reserved label. Left false for units chosen by a human in Pending
   * Stage Events, or already verified by the unit-associated webhook —
   * re-deriving those would defeat the manual override.
   */
  verifyUnitHint?: boolean;
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

  // ---- Association lookup / verification.
  // Runs when we have nothing to work with (auto-fetch), and also whenever a
  // payload-named unit must be proven Locked/Reserved before it can move
  // inventory.
  const verifyHint = params.verifyUnitHint === true;
  let suggestedOnly = false;
  if (
    params.opportunityId
    && params.autoFetchAssociations !== false
    && (verifyHint || (!unitCrmId && !buildingCrmId))
  ) {
    try {
      const { createCrmClient } = await import("./client.server");
      const { fetchOpportunityAssociations } = await import("./opportunities.server");
      const found = await fetchOpportunityAssociations(await createCrmClient(), params.opportunityId);

      // RULE 1 gate for untrusted, payload-named units.
      if (
        verifyHint
        && unitCrmId
        && found.lockedAssociationDefined
        && !found.lockedUnitCrmIds.includes(unitCrmId)
      ) {
        if (found.suggestedUnitCrmIds.includes(unitCrmId)) {
          return {
            outcome: "ignored_suggested_unit",
            unitCrmId,
            message: "Unit is only Suggested on this opportunity. Suggested Units never affect inventory.",
          };
        }
        // Named unit isn't the locked one — defer to the actual locked unit.
        unitCrmId = found.unitCrmId;
      }

      if (!unitCrmId && !buildingCrmId) {
        unitCrmId = found.unitCrmId;
        buildingCrmId = found.buildingCrmId;
      }

      // Nothing locked, but units ARE shortlisted: deliberate no-op, not a gap.
      suggestedOnly = !unitCrmId && !buildingCrmId && found.suggestedUnitCrmIds.length > 0;
    } catch (err) {
      console.warn("Auto-fetch of opportunity associations failed:", err instanceof Error ? err.message : err);
    }
  }

  if (!unitCrmId && !buildingCrmId) {
    if (suggestedOnly) {
      return {
        outcome: "ignored_suggested_only",
        message: "This opportunity has Suggested Units only. Suggested Units are browsing-only, so no inventory change applies.",
      };
    }
    return { outcome: "no_unit_reference" };
  }

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
  const isRelease = stage === "";

  // Cached state: who holds this unit, and its parents (for rollups).
  const { data: cachedState } = await supabaseAdmin
    .from("unit_state")
    .select("building_crm_id, project_crm_id, held_by_opportunity_id")
    .eq("unit_crm_id", unitId)
    .maybeSingle();
  let heldBy = cachedState?.held_by_opportunity_id ?? null;

  const { createCrmClient } = await import("./client.server");
  const { readRecord } = await import("./objects.server");
  const client = await createCrmClient();

  let currentStage = "";
  let currentAvailability = "";
  try {
    const cur = await readRecord(client, "unit", unitId);
    const props = extractProps(cur);
    currentStage = normalizeUnitStage(props?.["stages"]);
    currentAvailability = normalizeAvailability(props?.[FIELDS.unit.availability]);
  } catch (err) {
    return { outcome: "read_failed", unitCrmId: unitId, message: err instanceof Error ? err.message : String(err) };
  }

  // NOTE: there is deliberately NO sold-reversal guard here. The card's
  // position is absolute truth — dragging a deal back out of Closing must
  // un-sell the unit (owner-confirmed rule).

  // ---- Guard: a DIFFERENT opportunity is recorded as holding this unit.
  // Verify that hold against the live CRM before blocking: recorded holders go
  // stale when their deal is deleted, lost, dragged back, or when the
  // Locked/Reserved label is removed — blocking on a stale holder deadlocks
  // the unit for every future deal.
  let effectiveStage = currentStage;
  let effectiveAvailability = currentAvailability;
  const isLocked = currentAvailability === "Not Available" && currentStage !== "";
  if (isLocked && heldBy && incomingOpportunityId && heldBy !== incomingOpportunityId) {
    let verdict: "held" | "free" | "unknown" = "unknown";
    let freeReason: "UNIT_ASSOCIATION_REMOVED" | "OPPORTUNITY_DELETED" | "OPPORTUNITY_LOST" | "MOVED_TO_RELEASE_STAGE" = "UNIT_ASSOCIATION_REMOVED";
    try {
      const { checkOpportunityHold, releaseUnit } = await import("./release.server");
      const check = await checkOpportunityHold(client, heldBy, unitId);
      verdict = check.verdict;
      if (check.verdict === "free") {
        freeReason = (check.reason ?? "UNIT_ASSOCIATION_REMOVED") as typeof freeReason;
        await releaseUnit(client, unitId, freeReason, heldBy);
        heldBy = null;
        effectiveStage = "";
        effectiveAvailability = "Available";
      }
    } catch (err) {
      console.warn("[stage-apply] holder verification failed:", err instanceof Error ? err.message : err);
    }
    if (verdict !== "free") {
      return {
        outcome: "blocked_held_by_other_opportunity",
        unitCrmId: unitId,
        message: `Unit is ${currentStage} under opportunity ${heldBy}. Release it there first.`,
      };
    }
    // Holder was stale and has been released — the incoming change proceeds.
    if (isRelease) {
      // Incoming change IS a release; the stale-holder release already did it.
      return { outcome: "applied:available", unitCrmId: unitId };
    }
  }

  // ---- Guard: legacy fallback. No holder on record (state came from an
  // import or a CRM sync rather than a webhook), so we cannot prove the
  // incoming opportunity owns the lock. Refuse a fresh reservation on a unit
  // that is already locked in a different state.
  if (
    !heldBy
    && stage === "Reserved/Locked"
    && effectiveAvailability === "Not Available"
    && effectiveStage
    && effectiveStage !== "Reserved/Locked"
  ) {
    return {
      outcome: "blocked_double_reservation",
      unitCrmId: unitId,
      message: `Unit is currently ${effectiveStage}.`,
    };
  }

  // Only non-empty values survive normalizeRecordProperties() — its stripEmpty()
  // drops ""/null. So fields we need to CLEAR are appended afterwards as
  // explicit nulls, which GHL accepts (verified against the live API).
  const setProps = await normalizeRecordProperties(client, "unit", {
    [FIELDS.unit.availability]: availability,
    [FIELDS.unit.inventory_deducted]: inventoryDeducted,
    ...(stage ? { [FIELDS.unit.stage]: stage } : {}),
    ...(stage === "Reserved/Locked"
      ? { [FIELDS.unit.locked_date]: new Date().toISOString().slice(0, 10) }
      : {}),
  }, { forUpdate: true });
  const properties: Record<string, unknown> = isRelease
    ? { ...setProps, [FIELDS.unit.stage]: null, [FIELDS.unit.locked_date]: null }
    : setProps;

  await requestObject(client, "PUT", "unit", `/records/${unitId}`, {
    body: {
      properties,
    },
  });

  // Locking records the holder; releasing clears it.
  const nextHeldBy = isRelease ? null : (incomingOpportunityId ?? heldBy);
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
    previous: { availability: currentAvailability, stage: currentStage, held_by: cachedState?.held_by_opportunity_id ?? null } as never,
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
  /** Full stage->status table — every stage lands in exactly one list. */
  reserved_stage_names?: string[] | null;
  under_contract_stage_names?: string[] | null;
  sold_stage_names?: string[] | null;
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
  const cols = "stage_reserved_id, stage_under_contract_id, stage_closed_id, stage_release_id, stage_reserved_name, stage_under_contract_name, stage_closed_name, stage_release_name, reserved_stage_names, under_contract_stage_names, sold_stage_names, release_stage_names";
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
  const inList = (list?: string[] | null) =>
    Array.isArray(list) && list.some((n) => Boolean(n) && normalizeStageName(String(n)) === s);

  // Full table first — every stage of both pipelines lands in one of these.
  if (inList(m.sold_stage_names)) return SOLD;
  if (inList(m.under_contract_stage_names)) return UNDER_CONTRACT;
  if (inList(m.reserved_stage_names)) return RESERVED;
  if (inList(m.release_stage_names)) return RELEASED;

  // Legacy single-name columns (kept for backwards compatibility).
  if (eq(m.stage_reserved_name)) return RESERVED;
  if (eq(m.stage_under_contract_name)) return UNDER_CONTRACT;
  if (eq(m.stage_closed_name)) return SOLD;
  if (eq(m.stage_release_name)) return RELEASED;

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

  // Position is truth for buildings too — no sold-out block.
  const nextStatus = buildingStatusFor(target.stage);

  await requestObject(client, "PUT", "building", `/records/${buildingCrmId}`, {
    body: { properties: await normalizeRecordProperties(client, "building", { [FIELDS.building.status]: nextStatus }, { forUpdate: true }) },
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
 * Called by the unit-associated webhook (unit already verified as
 * Locked/Reserved) and by the manual "Apply" tool in Pending Stage Events
 * (a human explicitly chose the unit). Both are trusted, so the unit is used
 * as given rather than re-derived from associations.
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
