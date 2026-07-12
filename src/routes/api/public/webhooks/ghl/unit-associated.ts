/**
 * Public webhook: a unit was associated to an opportunity in the CRM.
 * URL: /api/public/webhooks/ghl/unit-associated
 * Auth: HMAC `x-kleegr-signature: sha256=<hex>` OR shared header `x-kleegr-secret: <secret>`.
 *
 * Payload (from a GHL workflow triggered by "Custom Object Record Associated"
 * or a manual "Custom Webhook" the salesperson-facing automation can fire):
 *   {
 *     event_id?: string,
 *     opportunity_id: string,
 *     unit_crm_id: string,
 *   }
 *
 * Effect: replays any `pending_no_unit` stage-change events for this
 * opportunity, so a user who moves the lead first and adds the unit
 * afterwards still gets the correct inventory state applied.
 */
import { createFileRoute } from "@tanstack/react-router";
import { createHmac, timingSafeEqual } from "crypto";

export const Route = createFileRoute("/api/public/webhooks/ghl/unit-associated")({
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
        const unitCrmId = strOrNull(payload.unit_crm_id);
        if (!opportunityId || !unitCrmId) {
          return json({ error: "opportunity_id and unit_crm_id are required" }, 400);
        }

        const { replayPendingForOpportunity } = await import("@/lib/kleegr/stage-apply.server");
        const result = await replayPendingForOpportunity(opportunityId, unitCrmId);
        return json({ ok: true, ...result });
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
