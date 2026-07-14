/**
 * Pending stage-change events dashboard: list, replay with a supplied unit CRM ID,
 * and best-effort auto-rescan (drops rows that have already been resolved).
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function requireImporterOrAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) {
    throw new Error("Forbidden");
  }
}

export const listPendingEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireImporterOrAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // 1. Load pending events (include raw payload so we can retry with the
    //    original pipeline/stage names, not just IDs).
    const { data: pending, error } = await supabaseAdmin
      .from("webhook_events")
      .select("id, opportunity_id, pipeline_id, stage_id, received_at, outcome, raw")
      .is("processed_at", null)
      .or("outcome.is.null,outcome.eq.pending_no_unit")
      .order("received_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);

    // 2. Auto-retry each event: re-run stage change with autoFetchAssociations.
    //    Once the salesperson has linked a Unit/Building to the Opportunity in
    //    the CRM, the association becomes visible and the event applies on its
    //    own — no manual "Apply" click needed.
    const { processStageChange } = await import("@/lib/kleegr/stage-apply.server");
    const { normalizeStagePayload } = await import("@/lib/kleegr/webhook-payload.server");
    const stillPending: Array<{
      id: string;
      opportunity_id: string | null;
      pipeline_id: string | null;
      stage_id: string | null;
      received_at: string;
      outcome: string | null;
    }> = [];
    for (const ev of pending ?? []) {
      const raw = (ev.raw ?? {}) as Record<string, unknown>;
      const normalized = normalizeStagePayload(raw);
      const opportunityId = ev.opportunity_id ?? normalized.opportunityId;
      const pipelineId = ev.pipeline_id ?? normalized.pipelineId;
      const stageId = ev.stage_id ?? normalized.stageId;
      const pipelineName = normalized.pipelineName;
      const stageName = normalized.stageName;
      const evOut = {
        id: ev.id,
        opportunity_id: opportunityId,
        pipeline_id: pipelineId,
        stage_id: stageId,
        received_at: ev.received_at,
        outcome: "pending_no_unit",
      };
      try {
        const res = await processStageChange({
          pipelineId,
          stageId,
          pipelineName,
          stageName,
          opportunityId,
          unitCrmIdHint: normalized.unitCrmIdHint,
          unitExternalId: normalized.unitExternalId,
          buildingCrmIdHint: normalized.buildingCrmIdHint,
          buildingExternalId: normalized.buildingExternalId,
          autoFetchAssociations: true,
        });
        if (res.outcome === "no_unit_reference" || res.outcome === "read_failed") {
          await supabaseAdmin
            .from("webhook_events")
            .update({
              opportunity_id: opportunityId,
              pipeline_id: pipelineId,
              stage_id: stageId,
              outcome: "pending_no_unit",
              unit_crm_id: res.unitCrmId ?? res.buildingCrmId ?? null,
            })
            .eq("id", ev.id);
          stillPending.push(evOut);
        } else {
          await supabaseAdmin
            .from("webhook_events")
            .update({
              processed_at: new Date().toISOString(),
              outcome: res.outcome,
              unit_crm_id: res.unitCrmId ?? null,
              opportunity_id: opportunityId,
              pipeline_id: pipelineId,
              stage_id: stageId,
            })
            .eq("id", ev.id);
        }
      } catch (err) {
        console.warn("[pending-events] auto-retry failed:", err instanceof Error ? err.message : err);
        stillPending.push(evOut);
      }
    }

    return { events: stillPending, scannedAt: new Date().toISOString() };
  });

export const applyPendingWithUnit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      opportunityId: z.string().min(1),
      unitCrmId: z.string().min(1),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporterOrAdmin(context.userId);
    const { replayPendingForOpportunity } = await import("@/lib/kleegr/stage-apply.server");
    const result = await replayPendingForOpportunity(data.opportunityId, data.unitCrmId);
    return { ok: true, ...result };
  });
