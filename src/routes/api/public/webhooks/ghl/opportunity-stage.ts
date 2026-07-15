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
 *
 * DEDUPE — read this before changing it:
 * GHL workflows typically build event_id as "{{opportunity.id}}-{{stage}}", so
 * the id is NOT unique per event: a deal that returns to a stage it already
 * visited (Reserved -> Under Contract -> back to Reserved) reuses the same id.
 * Some workflows are worse — if the stage merge tag resolves to empty, EVERY
 * event for that opportunity carries the identical id. So an id we have seen
 * before cannot be treated as a duplicate outright; that silently drops real
 * moves and strands units as permanently Reserved.
 * What a duplicate actually means here is a RETRY: GHL re-delivers a failed
 * webhook within a couple of minutes. Hence a short time window, rather than
 * "seen before, ever".
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

/** A repeat inside this window is a GHL retry; outside it, a genuine move. */
const DEDUPE_WINDOW_MS = 2 * 60 * 1000;

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

        const { normalizeStagePayload } = await import("@/lib/kleegr/webhook-payload.server");
        const {
          eventId,
          opportunityId,
          pipelineId,
          stageId,
          pipelineName,
          stageName,
          unitCrmIdHint,
          unitExternalId,
          buildingCrmIdHint,
          buildingExternalId,
        } = normalizeStagePayload(payload);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        // Dedupe retries only — see the note at the top of this file.
        const since = new Date(Date.now() - DEDUPE_WINDOW_MS).toISOString();
        const { data: recent } = await supabaseAdmin
          .from("webhook_events")
          .select("id, outcome")
          .eq("provider_event_id", eventId)
          .not("processed_at", "is", null)
          .gte("received_at", since)
          .order("received_at", { ascending: false })
          .limit(1);
        if (recent && recent.length > 0) {
          return json({ ok: true, deduped: true, outcome: recent[0].outcome });
        }

        const { data: inserted, error: insertError } = await supabaseAdmin
          .from("webhook_events")
          .insert({
            provider_event_id: eventId,
            pipeline_id: pipelineId,
            stage_id: stageId,
            opportunity_id: opportunityId,
            raw: payload as never,
          })
          .select("id")
          .maybeSingle();

        // Logging must never sink the event itself. Previously this blind-inserted
        // and then dereferenced the result, so a unique-constraint collision on
        // provider_event_id threw and the stage change was lost with no trace.
        if (insertError) {
          console.error("[webhook] could not log event:", insertError.message);
        }
        const eventRowId = inserted?.id ?? null;

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
          if (eventRowId) {
            await supabaseAdmin
              .from("webhook_events")
              .update({ outcome: "pending_no_unit" }) // leave processed_at null
              .eq("id", eventRowId);
          }
          return json({
            ok: true,
            pending: true,
            message: "No unit associated yet. Event queued — will apply automatically once a unit is added to this opportunity.",
          });
        }

        if (eventRowId) {
          await supabaseAdmin
            .from("webhook_events")
            .update({
              processed_at: new Date().toISOString(),
              outcome: outcome.outcome,
              unit_crm_id: outcome.unitCrmId ?? null,
            })
            .eq("id", eventRowId);
        }

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

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
