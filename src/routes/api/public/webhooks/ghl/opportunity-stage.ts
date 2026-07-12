/**
 * Public webhook: CRM Opportunity stage change → update associated Unit.
 * URL: /api/public/webhooks/ghl/opportunity-stage
 * Auth: HMAC signature `x-kleegr-signature: sha256=<hex>` OR shared header `x-kleegr-secret: <secret>`.
 *
 * Expected payload (from a GHL workflow "Custom Webhook"):
 *   {
 *     event_id?: string,           // any unique id to dedupe replay
 *     pipeline_id: string,
 *     stage_id: string,
 *     opportunity_id: string,
 *     unit_crm_id?: string,        // if the workflow can supply it (custom value)
 *     unit_external_import_id?: string,  // fallback: our external id
 *   }
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

export const Route = createFileRoute("/api/public/webhooks/ghl/opportunity-stage")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.KLEEGR_WEBHOOK_SECRET;
        if (!secret) return json({ error: "Webhook secret not configured" }, 500);

        const raw = await request.text();

        // Accept either HMAC signature OR shared-secret header (GHL "Custom Webhook" supports headers)
        const sig = request.headers.get("x-kleegr-signature");
        const sharedHeader = request.headers.get("x-kleegr-secret");
        let authed = false;
        if (sig) {
          const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
          try {
            const a = Buffer.from(sig);
            const b = Buffer.from(expected);
            if (a.length === b.length && timingSafeEqual(a, b)) authed = true;
          } catch { /* fall through */ }
        }
        if (!authed && sharedHeader) {
          try {
            const a = Buffer.from(sharedHeader);
            const b = Buffer.from(secret);
            if (a.length === b.length && timingSafeEqual(a, b)) authed = true;
          } catch { /* fall through */ }
        }
        if (!authed) return json({ error: "Invalid signature" }, 401);

        let payload: Record<string, unknown>;
        try { payload = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }

        const eventId = String(payload.event_id ?? `${payload.opportunity_id ?? "unknown"}-${payload.stage_id ?? "unknown"}-${Date.now()}`);
        const pipelineId = strOrNull(payload.pipeline_id);
        const stageId = strOrNull(payload.stage_id);
        const opportunityId = strOrNull(payload.opportunity_id);
        const unitCrmIdHint = strOrNull(payload.unit_crm_id);
        const unitExternalId = strOrNull(payload.unit_external_import_id);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Dedupe replay
        const existing = await supabaseAdmin
          .from("webhook_events")
          .select("id, processed_at, outcome")
          .eq("provider_event_id", eventId)
          .maybeSingle();
        if (existing.data?.processed_at) {
          return json({ ok: true, deduped: true, outcome: existing.data.outcome });
        }

        const { data: inserted } = await supabaseAdmin
          .from("webhook_events")
          .insert({
            provider_event_id: eventId,
            pipeline_id: pipelineId,
            stage_id: stageId,
            opportunity_id: opportunityId,
            raw: payload as never,
          })
          .select("id")
          .single();

        const outcome = await processStageChange({
          pipelineId, stageId, opportunityId, unitCrmIdHint, unitExternalId,
        });

        await supabaseAdmin
          .from("webhook_events")
          .update({ processed_at: new Date().toISOString(), outcome: outcome.outcome, unit_crm_id: outcome.unitCrmId ?? null })
          .eq("id", inserted!.id);

        return json({ ok: true, ...outcome });
      },

      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});

async function processStageChange(params: {
  stageId: string | null;
  opportunityId: string | null;
  unitCrmIdHint: string | null;
  unitExternalId: string | null;
}): Promise<{ outcome: string; unitCrmId?: string; message?: string }> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  const cfg = await supabaseAdmin.from("crm_config").select("*").eq("id", 1).maybeSingle();
  if (!cfg.data) return { outcome: "no_config" };

  // Determine which Unit to update
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
  if (!unitCrmId) return { outcome: "no_unit_reference" };

  // Determine the target state — look up the mapping for THIS pipeline first,
  // then fall back to the legacy single-pipeline config on crm_config.
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

  // Fetch current Unit state, apply guards
  const { createCrmClient } = await import("@/lib/kleegr/client.server");
  const { readRecord } = await import("@/lib/kleegr/objects.server");
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

  // Sold-reversal protection
  if (currentStage === "Closed/Sold" && stage !== "Closed/Sold") {
    return { outcome: "blocked_sold_reversal", unitCrmId };
  }
  // Double-reservation protection: don't reserve a unit that is already reserved for a different opportunity
  // (We rely on CRM to be the source of truth; here we simply detect state.)
  if (stage === "Reserved/Locked" && currentAvailability === "Not Available" && currentStage && currentStage !== "Reserved/Locked") {
    return { outcome: "blocked_double_reservation", unitCrmId, message: `Unit is currently ${currentStage}.` };
  }

  // Apply
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

  // Update local unit_state cache and recompute Building + Project rollups in real time.
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
    const { summarize, writeBuildingRollup, writeProjectRollup } = await import("@/lib/kleegr/rollups.server");
    if (buildingId) {
      const { data: siblings } = await supabaseAdmin
        .from("unit_state").select("availability, stage").eq("building_crm_id", buildingId);
      try {
        await writeBuildingRollup(client, buildingId, summarize((siblings ?? []).map((s) => ({ availability: s.availability ?? "", stage: s.stage ?? "" }))));
      } catch (err) { console.error("Building rollup failed:", err); }
    }
    if (projectId) {
      const { data: siblings } = await supabaseAdmin
        .from("unit_state").select("availability, stage").eq("project_crm_id", projectId);
      try {
        await writeProjectRollup(client, projectId, summarize((siblings ?? []).map((s) => ({ availability: s.availability ?? "", stage: s.stage ?? "" }))));
      } catch (err) { console.error("Project rollup failed:", err); }
    }
  }

  // Audit
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

function extractProps(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (d.properties && typeof d.properties === "object") return d.properties as Record<string, unknown>;
  const rec = d.record as Record<string, unknown> | undefined;
  if (rec?.properties && typeof rec.properties === "object") return rec.properties as Record<string, unknown>;
  return null;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
