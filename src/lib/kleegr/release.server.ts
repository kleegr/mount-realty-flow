/**
 * Unit status engine — the single place a unit's state is written, plus the
 * shared self-heal entry point both pages call.
 *
 * TWO RULES GOVERN EVERYTHING HERE (both owner-confirmed):
 *
 * 1. THE LOCKED/RESERVED LABEL IS THE ON SWITCH.
 *    Only a unit associated to an opportunity via "Locked/Reserved Units"
 *    is driven by this engine. "Suggested Units" is browsing: a suggested
 *    unit stays Available no matter what stage the deal sits in, no matter
 *    how many deals suggest it. Losing the locked label (detached, or
 *    switched to Suggested) releases the unit.
 *
 * 2. THE CARD'S CURRENT STAGE IS ABSOLUTE TRUTH.
 *    For units that pass rule 1, direction of movement and history do not
 *    matter. Every stage in both pipelines maps to exactly one status via the
 *    crm_pipelines lists:
 *      reserved_stage_names[]       -> Reserved
 *      under_contract_stage_names[] -> Under Contract
 *      sold_stage_names[]           -> Closed/Sold
 *      release_stage_names[]        -> Available (includes Lost / Not Interested)
 *    Dragging a deal backward — even out of Closing — re-applies the mapped
 *    status, including un-selling.
 *
 * Sold guard: a Sold unit may only change via an explicit card POSITION
 * (MOVED_TO_RELEASE_STAGE / position sync) or a MANUAL release. Deleting or
 * losing a deal does NOT quietly un-sell a unit.
 *
 * Strict reads: a transient CRM outage must never look like "the association
 * is gone" — on any read failure the unit is SKIPPED, never changed.
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

export type CanonicalStatus = "available" | "reserved" | "under_contract" | "sold";

const STATUS_TARGETS: Record<CanonicalStatus, { availability: string; stage: string; deducted: string }> = {
  available: { availability: "Available", stage: "", deducted: "No" },
  reserved: { availability: "Not Available", stage: "Reserved/Locked", deducted: "Yes" },
  under_contract: { availability: "Not Available", stage: "Under Contract", deducted: "Yes" },
  sold: { availability: "Not Available", stage: "Closed/Sold", deducted: "Yes" },
};

export interface ReleaseResult {
  unitCrmId: string;
  released: boolean;
  outcome: string; // released | already_available | sold_protected | ghl_failed:... | mirror_failed:...
  reason?: ReleaseReason;
}

export interface ReconcileResult {
  checked: number;
  released: ReleaseResult[];
  adjusted: Array<{ unitCrmId: string; to: CanonicalStatus; outcome: string }>;
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

  // Sold guard: only an explicit card position or a human may free a sold unit.
  if (
    currentStage === "Closed/Sold"
    && reason !== "MANUAL_UNIT_RELEASE"
    && reason !== "MOVED_TO_RELEASE_STAGE"
  ) {
    return { unitCrmId, released: false, outcome: "sold_protected", reason };
  }

  // Idempotent no-op.
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

/**
 * Write a non-available canonical status to a unit — the "position is truth"
 * apply path used when a deal's card sits in a Reserved / Under Contract /
 * Sold stage. Both directions are legal, including sold -> under_contract when
 * a card is dragged back from Closing.
 *
 * Callers MUST have already established that the unit is Locked/Reserved to
 * this opportunity. This function does not check associations.
 */
export async function applyUnitStatus(
  client: CrmClient,
  unitCrmId: string,
  status: Exclude<CanonicalStatus, "available">,
  opportunityId: string | null,
): Promise<{ unitCrmId: string; outcome: string }> {
  const supabaseAdmin = await admin();
  const target = STATUS_TARGETS[status];

  const { data: row } = await supabaseAdmin
    .from("unit_state")
    .select("availability, stage, building_crm_id, project_crm_id, held_by_opportunity_id")
    .eq("unit_crm_id", unitCrmId)
    .maybeSingle();

  const currentStage = (row?.stage ?? "").trim();
  const currentAvailability = (row?.availability ?? "").trim();

  if (currentStage === target.stage && currentAvailability === target.availability) {
    // Already correct — just make sure the holder is recorded.
    if (opportunityId && row?.held_by_opportunity_id !== opportunityId) {
      await supabaseAdmin
        .from("unit_state")
        .update({ held_by_opportunity_id: opportunityId })
        .eq("unit_crm_id", unitCrmId)
        .then(() => undefined, () => undefined);
    }
    return { unitCrmId, outcome: "already_in_state" };
  }

  const setProps = await normalizeRecordProperties(client, "unit", {
    [FIELDS.unit.availability]: target.availability,
    [FIELDS.unit.inventory_deducted]: target.deducted,
    [FIELDS.unit.stage]: target.stage,
    ...(status === "reserved"
      ? { [FIELDS.unit.locked_date]: new Date().toISOString().slice(0, 10) }
      : {}),
  }, { forUpdate: true });

  try {
    await requestObject(client, "PUT", "unit", `/records/${unitCrmId}`, {
      body: { properties: setProps },
    });
  } catch (err) {
    return { unitCrmId, outcome: `ghl_failed: ${err instanceof Error ? err.message : String(err)}` };
  }

  const { error: upErr } = await supabaseAdmin.from("unit_state").upsert(
    {
      unit_crm_id: unitCrmId,
      availability: target.availability,
      stage: target.stage,
      held_by_opportunity_id: opportunityId,
    },
    { onConflict: "unit_crm_id" },
  );
  if (upErr) return { unitCrmId, outcome: `mirror_failed: ${upErr.message}` };

  await recomputeParents(client, row?.building_crm_id ?? null, row?.project_crm_id ?? null);

  await supabaseAdmin.from("audit_events").insert({
    kind: "unit_status_sync",
    entity_scope: "unit",
    entity_crm_id: unitCrmId,
    previous: { availability: currentAvailability || null, stage: currentStage || null } as never,
    next: { availability: target.availability, stage: target.stage } as never,
    reason: `POSITION_SYNC:${status}${opportunityId ? ` (opportunity ${opportunityId})` : ""}`,
  });

  return { unitCrmId, outcome: `applied:${target.stage}` };
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
// Pipeline catalog (stage id -> name) + the full stage->status table
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

type StatusRuleMap = Map<string, CanonicalStatus>; // normalized stage name -> status

interface StageRules {
  byPipelineId: Map<string, StatusRuleMap>;
  byPipelineName: Map<string, StatusRuleMap>;
}

async function loadStageRules(): Promise<StageRules> {
  const rules: StageRules = { byPipelineId: new Map(), byPipelineName: new Map() };
  const supabaseAdmin = await admin();
  const { data, error } = await supabaseAdmin
    .from("crm_pipelines")
    .select("pipeline_id, pipeline_name, stage_reserved_name, stage_under_contract_name, stage_closed_name, stage_release_name, release_stage_names, reserved_stage_names, under_contract_stage_names, sold_stage_names");
  if (error || !data) return rules;
  for (const row of data as Array<Record<string, unknown>>) {
    const map: StatusRuleMap = new Map();
    const put = (name: unknown, status: CanonicalStatus) => {
      if (typeof name === "string" && name.trim()) map.set(normStage(name), status);
    };
    const putAll = (list: unknown, status: CanonicalStatus) => {
      if (Array.isArray(list)) for (const n of list) put(n, status);
    };
    // Broad lists first, explicit singles last so legacy singles win ties.
    putAll(row.release_stage_names, "available");
    putAll(row.reserved_stage_names, "reserved");
    putAll(row.under_contract_stage_names, "under_contract");
    putAll(row.sold_stage_names, "sold");
    put(row.stage_release_name, "available");
    put(row.stage_reserved_name, "reserved");
    put(row.stage_under_contract_name, "under_contract");
    put(row.stage_closed_name, "sold");
    if (map.size === 0) continue;
    if (typeof row.pipeline_id === "string" && row.pipeline_id) rules.byPipelineId.set(row.pipeline_id, map);
    if (typeof row.pipeline_name === "string" && row.pipeline_name) rules.byPipelineName.set(normStage(row.pipeline_name), map);
  }
  return rules;
}

function ruleFor(rules: StageRules, pipelineId: string | null, pipelineName: string | null): StatusRuleMap | undefined {
  return (pipelineId ? rules.byPipelineId.get(pipelineId) : undefined)
    ?? (pipelineName ? rules.byPipelineName.get(normStage(pipelineName)) : undefined);
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

/** Map an opportunity snapshot's current stage to a canonical status. */
async function statusForSnapshot(c: CrmClient, snap: OppSnapshot): Promise<CanonicalStatus | null> {
  if (!snap.pipelineId || !snap.stageId) return null;
  const [catalog, rules] = await Promise.all([fetchPipelineCatalog(c), loadStageRules()]);
  if (!catalog) return null;
  const stageName = catalog.stageNameById.get(snap.stageId) ?? null;
  const pipelineName = catalog.pipelineNameById.get(snap.pipelineId) ?? null;
  const rule = ruleFor(rules, snap.pipelineId, pipelineName);
  if (!rule || !stageName) return null;
  return rule.get(normStage(stageName)) ?? null;
}

export interface HoldCheck {
  verdict: "held" | "free" | "unknown";
  reason?: ReleaseReason;
  detail?: string;
}

/**
 * Is this opportunity's hold on this unit still justified, per the LIVE CRM?
 * Used by the stage webhook when a unit carries a stale holder — instead of
 * blocking blindly, the webhook verifies the holder and frees the unit when
 * the hold is no longer real.
 *
 * Order matters: the ASSOCIATION is checked before the stage, because the
 * Locked/Reserved label is the on switch. A unit whose label was removed (or
 * switched to Suggested) is free even if the deal sits in Contract Negotiation.
 *
 * "unknown" (read failure) must be treated as held.
 */
export async function checkOpportunityHold(
  c: CrmClient,
  opportunityId: string,
  unitCrmId: string,
): Promise<HoldCheck> {
  const snap = await fetchOpportunitySnapshot(c, opportunityId);
  if (snap === "error") return { verdict: "unknown", detail: "opportunity read failed" };
  if (!snap.exists || snap.status === "deleted") return { verdict: "free", reason: "OPPORTUNITY_DELETED" };
  if (snap.status === "lost" || snap.status === "abandoned") return { verdict: "free", reason: "OPPORTUNITY_LOST" };

  // Rule 1 — the label is the on switch.
  try {
    const { classifyUnitForOpportunity } = await import("./opportunities.server");
    const kind = await classifyUnitForOpportunity(c, opportunityId, unitCrmId);
    if (kind !== "locked") return { verdict: "free", reason: "UNIT_ASSOCIATION_REMOVED" };
  } catch (err) {
    return { verdict: "unknown", detail: err instanceof Error ? err.message : String(err) };
  }

  // Rule 2 — the card's position.
  const mapped = await statusForSnapshot(c, snap);
  if (mapped === "available") return { verdict: "free", reason: "MOVED_TO_RELEASE_STAGE" };
  return { verdict: "held" };
}

/**
 * A unit was just Locked/Reserved to an opportunity — apply that deal's
 * CURRENT stage to it immediately. This is what makes attaching the label
 * "work the full everything" even when the deal was already sitting in a
 * locking stage before the unit was chosen.
 *
 * The caller MUST have verified the association is Locked/Reserved.
 */
export async function applyOpportunityStageToUnit(
  client: CrmClient,
  opportunityId: string,
  unitCrmId: string,
): Promise<{ outcome: string }> {
  const snap = await fetchOpportunitySnapshot(client, opportunityId);
  if (snap === "error") return { outcome: "opportunity_read_failed" };
  if (!snap.exists || snap.status === "deleted") {
    const r = await releaseUnit(client, unitCrmId, "OPPORTUNITY_DELETED", opportunityId);
    return { outcome: `deleted:${r.outcome}` };
  }
  if (snap.status === "lost" || snap.status === "abandoned") {
    const r = await releaseUnit(client, unitCrmId, "OPPORTUNITY_LOST", opportunityId);
    return { outcome: `lost:${r.outcome}` };
  }

  const mapped = await statusForSnapshot(client, snap);
  if (!mapped) return { outcome: "stage_not_mapped" };
  if (mapped === "available") {
    const r = await releaseUnit(client, unitCrmId, "MOVED_TO_RELEASE_STAGE", opportunityId);
    return { outcome: `release_stage:${r.outcome}` };
  }
  const r = await applyUnitStatus(client, unitCrmId, mapped, opportunityId);
  return { outcome: r.outcome };
}

/**
 * Self-healing reconcile. For every unit an opportunity is holding, enforce
 * both rules against the LIVE CRM:
 *
 *   1. opportunity deleted / lost           -> release
 *   2. unit no longer Locked/Reserved       -> release (UNIT_ASSOCIATION_REMOVED)
 *      (covers "switched to Suggested" and "detached")
 *   3. otherwise the card's stage decides   -> Available / Reserved / UC / Sold
 *
 * The association gate runs BEFORE the stage map — without that order, a unit
 * downgraded from Locked to Suggested while its deal sat in a locking stage
 * would be held forever.
 *
 * Units with no recorded holder get one recovered from webhook history; units
 * with no webhook history (pure CSV imports) are never touched.
 */
export async function reconcileHeldUnits(client?: CrmClient): Promise<ReconcileResult> {
  const result: ReconcileResult = { checked: 0, released: [], adjusted: [], keptHeld: 0, skipped: [] };

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
    const arr = byOpp.get(opp) ?? [];
    arr.push({ unitCrmId, stage });
    byOpp.set(opp, arr);
  }

  // Backfill: locked units with NO recorded holder (locks that predate holder
  // tracking). Recover the holder from webhook history — the "applied:*"
  // event that locked the unit names the opportunity that did it. Units with
  // no webhook history (pure CSV imports) stay untouched.
  const { data: orphanRows } = await supabaseAdmin
    .from("unit_state")
    .select("unit_crm_id, stage, held_by_opportunity_id")
    .is("held_by_opportunity_id", null);
  for (const row of (orphanRows ?? []) as Array<Record<string, unknown>>) {
    const unitCrmId = typeof row.unit_crm_id === "string" ? row.unit_crm_id : null;
    if (!unitCrmId) continue;
    const stage = String(row.stage ?? "").trim();
    if (!stage) continue;
    const { data: ev } = await supabaseAdmin
      .from("webhook_events")
      .select("opportunity_id")
      .eq("unit_crm_id", unitCrmId)
      .like("outcome", "applied:%")
      .not("opportunity_id", "is", null)
      .order("received_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const opp = ev?.opportunity_id;
    if (typeof opp !== "string" || !opp) continue;
    const arr = byOpp.get(opp) ?? [];
    if (!arr.some((u) => u.unitCrmId === unitCrmId)) arr.push({ unitCrmId, stage });
    byOpp.set(opp, arr);
  }

  if (byOpp.size === 0) return result;

  const [catalog, rules] = await Promise.all([fetchPipelineCatalog(c), loadStageRules()]);
  const { fetchUnitAssociationSets } = await import("./opportunities.server");

  for (const [oppId, units] of byOpp) {
    result.checked += units.length;

    // 1) Does the opportunity still exist, and in what state?
    const snap = await fetchOpportunitySnapshot(c, oppId);
    if (snap === "error") {
      result.skipped.push({ opportunityId: oppId, reason: "opportunity read failed (transient) — not changing on a guess" });
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

    // 2) RULE 1 — the Locked/Reserved label is the on switch. Strict read: a
    //    failed call must never look like "the label is gone".
    let lockedIds: Set<string> | null = null;
    try {
      const sets = await fetchUnitAssociationSets(c, oppId);
      // null = this location defines no Locked/Reserved association at all, so
      // there is nothing to gate on (legacy behaviour).
      lockedIds = sets.lockedAssociationDefined ? new Set(sets.lockedUnitIds) : null;
    } catch (err) {
      result.skipped.push({ opportunityId: oppId, reason: `associations read failed: ${err instanceof Error ? err.message : String(err)}` });
      continue;
    }

    // 3) RULE 2 — the card's current stage decides, both directions.
    let mapped: CanonicalStatus | undefined;
    if (snap.pipelineId && snap.stageId && catalog) {
      const stageName = catalog.stageNameById.get(snap.stageId) ?? null;
      const pipelineName = catalog.pipelineNameById.get(snap.pipelineId) ?? null;
      const rule = ruleFor(rules, snap.pipelineId, pipelineName);
      mapped = rule && stageName ? rule.get(normStage(stageName)) : undefined;
    }

    for (const u of units) {
      // Lost the label (detached, or switched to Suggested) -> free it.
      if (lockedIds && !lockedIds.has(u.unitCrmId)) {
        result.released.push(await releaseUnit(c, u.unitCrmId, "UNIT_ASSOCIATION_REMOVED", oppId));
        continue;
      }
      if (mapped === "available") {
        result.released.push(await releaseUnit(c, u.unitCrmId, "MOVED_TO_RELEASE_STAGE", oppId));
        continue;
      }
      if (mapped) {
        const res = await applyUnitStatus(c, u.unitCrmId, mapped, oppId);
        if (res.outcome === "already_in_state") result.keptHeld++;
        else result.adjusted.push({ unitCrmId: u.unitCrmId, to: mapped, outcome: res.outcome });
        continue;
      }
      // Stage isn't in the table (typo / brand-new stage): hold current state.
      result.keptHeld++;
    }
  }

  return result;
}

/**
 * Shared self-heal entry point. Called by BOTH the Dashboard and the Unit
 * Report server functions on every view (both pages poll every 30s), and
 * throttled here to one real run per 2 minutes via a marker row.
 *
 * Runs, in order:
 *   1. prune local mappings for records deleted in the CRM
 *   2. mirror every Unit's ACTUAL availability/stage from the CRM
 *   3. the reconcile sweep (enforces both rules in both directions)
 */
export async function selfHealCrmState(force: boolean): Promise<void> {
  const supabaseAdmin = await admin();

  if (!force) {
    const { data: last } = await supabaseAdmin
      .from("audit_events")
      .select("created_at")
      .eq("kind", "reconcile_run")
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (last?.created_at && Date.now() - new Date(last.created_at).getTime() < 2 * 60 * 1000) {
      return; // healed recently — skip
    }
  }

  // Marker first, so concurrent page loads don't stampede the CRM.
  await supabaseAdmin
    .from("audit_events")
    .insert({ kind: "reconcile_run", reason: force ? "manual sync" : "auto (page view)" })
    .then(() => undefined, () => undefined);

  try {
    const { reconcileScopes, syncUnitStatesFromCrm } = await import("./live-records.server");
    await reconcileScopes(["project", "building", "unit"]);
    const res = await syncUnitStatesFromCrm();
    if (res.skipped) console.warn("[heal] unit mirror skipped:", res.skipped);
  } catch (err) {
    console.warn("[heal] mirror failed:", err instanceof Error ? err.message : err);
  }

  try {
    const rec = await reconcileHeldUnits();
    if (rec.released.length > 0 || rec.adjusted.length > 0 || rec.skipped.length > 0) {
      console.info(
        `[heal] reconcile: checked ${rec.checked}, released ${rec.released.length}, adjusted ${rec.adjusted.length}, kept ${rec.keptHeld}, skipped ${rec.skipped.length}`,
      );
    }
  } catch (err) {
    console.warn("[heal] held-unit reconcile failed:", err instanceof Error ? err.message : err);
  }
}
