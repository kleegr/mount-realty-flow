/**
 * Public webhook: CRM Opportunity stage change → update associated Unit.
 * URL: /api/public/webhooks/ghl/opportunity-stage
 * Auth: HMAC `x-kleegr-signature: sha256=<hex>` OR shared header `x-kleegr-secret: <secret>`.
 *
 * Payload (GHL "Custom Webhook" action):
 *   {
 *     event_id?: string,
 *     pipeline_id: string,
 *     stage_id: string,
 *     opportunity_id: string,
 *     unit_crm_id?: string,               // preferred — comes from Associated Object
 *     unit_external_import_id?: string,   // fallback
 *   }
 *
 * Grace window: if the stage change fires BEFORE a unit is associated to the
 * opportunity, the event is stored as `pending_no_unit`. Once the salesperson
 * associates a unit, the companion `/unit-associated` webhook replays the
 * pending events. A manual reprocess endpoint is also available.
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

        const eventId = String(
          payload.event_id ??
            `${payload.opportunity_id ?? "unknown"}-${payload.stage_id ?? "unknown"}-${Date.now()}`,
        );
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

        const { processStageChange } = await import("@/lib/kleegr/stage-apply.server");
        const outcome = await processStageChange({
          pipelineId, stageId, opportunityId, unitCrmIdHint, unitExternalId,
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
