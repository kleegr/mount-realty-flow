/**
 * Public webhook: an Opportunity was deleted in the CRM.
 * URL: /api/public/webhooks/ghl/opportunity-deleted
 * Auth: HMAC `x-kleegr-signature: sha256=<hex>` OR shared header `x-kleegr-secret: <secret>`.
 *
 * Wire this to a GHL workflow with trigger "Opportunity Deleted" (or
 * "Opportunity Status Changed -> deleted" depending on plan), sending:
 *   { "opportunity_id": "{{opportunity.id}}" }
 *
 * Effect: every unit whose lock was placed by this opportunity is released
 * back to Available on BOTH sides (GHL Unit record + dashboard mirror), the
 * holder is cleared, parent rollups are recomputed, and the release is logged
 * with reason OPPORTUNITY_DELETED.
 *
 * Sold/Closed units are never auto-released. Idempotent: re-delivery finds the
 * units already Available and reports success without further updates.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

export const Route = createFileRoute("/api/public/webhooks/ghl/opportunity-deleted")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const secret = process.env.KLEEGR_WEBHOOK_SECRET;
        if (!secret) return json({ error: "Webhook secret not configured" }, 500);

        const raw = await request.text();
        if (!verifyAuth(request, raw, secret)) return json({ error: "Invalid signature" }, 401);

        let payload: Record<string, unknown>;
        try { payload = JSON.parse(raw); } catch { return json({ error: "Invalid JSON" }, 400); }

        const opportunityId =
          strOrNull(payload.opportunity_id)
          ?? strOrNull(payload.opportunityId)
          ?? strOrNull((payload.customData as Record<string, unknown> | undefined)?.opportunity_id)
          ?? strOrNull(payload.id);
        if (!opportunityId) return json({ error: "opportunity_id is required" }, 400);

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        await supabaseAdmin.from("webhook_events").insert({
          provider_event_id: `deleted-${opportunityId}-${Date.now()}`,
          opportunity_id: opportunityId,
          raw: payload as never,
          outcome: "opportunity_deleted_received",
          processed_at: new Date().toISOString(),
        }).then(() => undefined, () => undefined);

        const { createCrmClient } = await import("@/lib/kleegr/client.server");
        const { releaseUnitsHeldBy } = await import("@/lib/kleegr/release.server");

        const client = await createCrmClient();
        const released = await releaseUnitsHeldBy(client, opportunityId, "OPPORTUNITY_DELETED");

        return json({
          ok: true,
          opportunityId,
          released,
          message: released.length === 0
            ? "No units were held by this opportunity — nothing to release."
            : undefined,
        });
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
