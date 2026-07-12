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
 */
export interface StageChangeInput {
  pipelineId: string | null;
  stageId: string | null;
  opportunityId: string | null;
  unitCrmIdHint: string | null;
  unitExternalId: string | null;
  buildingCrmIdHint?: string | null;
  buildingExternalId?: string | null;
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

  if (!unitCrmId && !buildingCrmId) return { outcome: "no_unit_reference" };

  // Resolve stage mapping (shared between Unit and Building paths)
  const stageMapping = await resolveStageMapping(supabaseAdmin, params.pipelineId, cfg.data);
  const target = classifyStage(params.stageId, stageMapping);
  if (!target) {
    return {
      outcome: "stage_not_mapped",
      unitCrmId: unitCrmId ?? undefined,
      buildingCrmId: buildingCrmId ?? undefined,
      message: `Stage ${params.stageId ?? "unknown"} in pipeline ${params.pipelineId ?? "unknown"} is not mapped in Settings.`,
    };
  }

  // Building-level sale: apply directly to Building record, no rollup.
  if (!unitCrmId && buildingCrmId) {
    return applyBuildingStage(buildingCrmId, target, params);
  }

  // Unit path (default) — unitCrmId is guaranteed non-null here.
  const unitId = unitCrmId!;




  // Determine target state — per-pipeline mapping first, then legacy fallback.
  const s = params.stageId;
  const pid = params.pipelineId;

  let mapping: {
    stage_reserved_id: string | null;
    stage_under_contract_id: string | null;
    stage_closed_id: string | null;
    stage_release_id: string | null;
  } | null = null;

  if (pid) {
    const pl = await supabaseAdmin
      .from("crm_pipelines")
      .select("stage_reserved_id, stage_under_contract_id, stage_closed_id, stage_release_id")
      .eq("pipeline_id", pid)
      .maybeSingle();
    if (pl.data) mapping = pl.data;
  }
  if (!mapping) {
    mapping = {
      stage_reserved_id: cfg.data.stage_reserved_id,
      stage_under_contract_id: cfg.data.stage_under_contract_id,
      stage_closed_id: cfg.data.stage_closed_id,
      stage_release_id: cfg.data.stage_release_id,
    };
  }

  let availability: string | null = null;
  let stage: string | null = null;
  let inventoryDeducted: string | null = null;

  if (s && s === mapping.stage_reserved_id) { availability = "Not Available"; stage = "Reserved/Locked"; inventoryDeducted = "Yes"; }
  else if (s && s === mapping.stage_under_contract_id) { availability = "Not Available"; stage = "Under Contract"; inventoryDeducted = "Yes"; }
  else if (s && s === mapping.stage_closed_id) { availability = "Not Available"; stage = "Closed/Sold"; inventoryDeducted = "Yes"; }
  else if (s && s === mapping.stage_release_id) { availability = "Available"; stage = ""; inventoryDeducted = "No"; }
  else return { outcome: "stage_not_mapped", unitCrmId, message: `Stage ${s ?? "unknown"} in pipeline ${pid ?? "unknown"} is not mapped in Settings.` };

  const { createCrmClient } = await import("./client.server");
  const { readRecord } = await import("./objects.server");
  let currentStage = "";
  let currentAvailability = "";
  try {
    const cur = await readRecord(await createCrmClient(), "unit", unitCrmId);
    const props = extractProps(cur);
    currentStage = String(props?.["stages"] ?? "");
    currentAvailability = String(props?.["availablenot_available"] ?? "");
  } catch (err) {
    return { outcome: "read_failed", unitCrmId, message: err instanceof Error ? err.message : String(err) };
  }

  if (currentStage === "Closed/Sold" && stage !== "Closed/Sold") {
    return { outcome: "blocked_sold_reversal", unitCrmId };
  }
  if (stage === "Reserved/Locked" && currentAvailability === "Not Available" && currentStage && currentStage !== "Reserved/Locked") {
    return { outcome: "blocked_double_reservation", unitCrmId, message: `Unit is currently ${currentStage}.` };
  }

  const client = await createCrmClient();
  await client.request("PUT", `/objects/${client.config.unit_object_key}/records/${unitCrmId}`, {
    body: {
      properties: {
        availablenot_available: availability,
        stages: stage,
        inventory_deducted: inventoryDeducted,
        locked_date: stage === "Reserved/Locked" ? new Date().toISOString().slice(0, 10) : "",
      },
    },
  });

  await supabaseAdmin.from("unit_state").upsert(
    { unit_crm_id: unitCrmId, availability: availability ?? "", stage: stage ?? "" },
    { onConflict: "unit_crm_id" },
  );
  const { data: cached } = await supabaseAdmin
    .from("unit_state")
    .select("building_crm_id, project_crm_id")
    .eq("unit_crm_id", unitCrmId)
    .maybeSingle();
  const buildingId = cached?.building_crm_id ?? null;
  const projectId = cached?.project_crm_id ?? null;

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
    entity_crm_id: unitCrmId,
    previous: { availability: currentAvailability, stage: currentStage } as never,
    next: { availability, stage } as never,
    reason: `Opportunity ${params.opportunityId ?? ""} moved to stage ${s ?? ""}`,
  });

  return { outcome: `applied:${stage || "available"}`, unitCrmId };
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
    .select("id, pipeline_id, stage_id, opportunity_id")
    .eq("opportunity_id", opportunityId)
    .eq("outcome", "pending_no_unit")
    .is("processed_at", null)
    .order("received_at", { ascending: true });

  const outcomes: string[] = [];
  for (const ev of pending ?? []) {
    const res = await processStageChange({
      pipelineId: ev.pipeline_id,
      stageId: ev.stage_id,
      opportunityId: ev.opportunity_id,
      unitCrmIdHint: unitCrmId,
      unitExternalId: null,
    });
    outcomes.push(res.outcome);
    await supabaseAdmin
      .from("webhook_events")
      .update({
        processed_at: new Date().toISOString(),
        outcome: res.outcome,
        unit_crm_id: res.unitCrmId ?? unitCrmId,
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
