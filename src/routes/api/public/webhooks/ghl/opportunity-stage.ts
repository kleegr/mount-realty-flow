/**
 * Public webhook: CRM Opportunity stage change → update associated Unit.
 * URL: /api/public/webhooks/ghl/opportunity-stage
 * Auth: HMAC `x-kleegr-signature: sha256=<hex>` OR shared header `x-kleegr-secret: <secret>`.
 *
 * Payload (GHL "Custom Webhook" action) — FULLY AUTOMATED shape:
 *   {
 *     event_id?: string,
 *     opportunity_id: string,          // REQUIRED
 *     pipeline_name?: string,          // preferred (from picker: Pipeline Name)
 *     stage_name?: string,             // preferred (from picker: Stage Name)
 *     pipeline_id?: string,            // legacy / fallback
 *     stage_id?: string,               // legacy / fallback
 *     unit_crm_id?: string,            // optional override — normally we auto-fetch
 *     building_crm_id?: string,        // optional — for whole-building sales
 *   }
 *
 * The backend automatically calls the GHL API to find the Unit/Building
 * associated with the opportunity — no manual custom field required.
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
        if (!verifyAuth(request, raw, secret)) return json({ error: "Invalid signature" }, 401);

        let payload: Record<string, unknown>;
        try { payload = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }

        const opportunityId = strOrNull(payload.opportunity_id);
        const pipelineId = strOrNull(payload.pipeline_id);
        const stageId = strOrNull(payload.stage_id);
        const pipelineName = strOrNull(payload.pipeline_name);
        const stageName = strOrNull(payload.stage_name);
        const unitCrmIdHint = strOrNull(payload.unit_crm_id);
        const unitExternalId = strOrNull(payload.unit_external_import_id);
        const buildingCrmIdHint = strOrNull(payload.building_crm_id);
        const buildingExternalId = strOrNull(payload.building_external_import_id);

        const eventId = String(
          payload.event_id ??
            `${opportunityId ?? "unknown"}-${stageId ?? stageName ?? "unknown"}-${Date.now()}`,
        );

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

        const { processStageChange } = await import("@/lib/kleegr/stage-apply.server");
        const outcome = await processStageChange({
          pipelineId, stageId, pipelineName, stageName, opportunityId,
          unitCrmIdHint, unitExternalId,
          buildingCrmIdHint, buildingExternalId,
          autoFetchAssociations: true,
        });

        // Grace window: no unit yet → keep event pending so it can be replayed
        // when the salesperson associates a unit later.
        if (outcome.outcome === "no_unit_reference") {
          await supabaseAdmin
            .from("webhook_events")
            .update({ outcome: "pending_no_unit" }) // leave processed_at null
            .eq("id", inserted!.id);
          return json({
            ok: true,
            pending: true,
            message: "No unit associated yet. Event queued — will apply automatically once a unit is added to this opportunity.",
          });
        }

        await supabaseAdmin
          .from("webhook_events")
          .update({
            processed_at: new Date().toISOString(),
            outcome: outcome.outcome,
            unit_crm_id: outcome.unitCrmId ?? null,
          })
          .eq("id", inserted!.id);

        return json({ ok: true, ...outcome });
      },

      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});

function verifyAuth(request: Request, raw: string, secret: string): boolean {
  const sig = request.headers.get("x-kleegr-signature");
  const sharedHeader = request.headers.get("x-kleegr-secret");
  if (sig) {
    const expected = "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
    try {
      const a = Buffer.from(sig);
      const b = Buffer.from(expected);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch { /* fall through */ }
  }
  if (sharedHeader) {
    try {
      const a = Buffer.from(sharedHeader);
      const b = Buffer.from(secret);
      if (a.length === b.length && timingSafeEqual(a, b)) return true;
    } catch { /* fall through */ }
  }
  return false;
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
