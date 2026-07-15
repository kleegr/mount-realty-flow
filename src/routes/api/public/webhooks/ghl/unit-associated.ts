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
 * Effects:
 *   1. SELECTED_UNIT_CHANGED — if this opportunity was already holding a
 *      DIFFERENT unit, that previous unit is released back to Available first
 *      (both in GHL and on the dashboard). One opportunity holds one unit.
 *   2. Replays any `pending_no_unit` stage-change events for this opportunity,
 *      so a user who moves the lead first and adds the unit afterwards still
 *      gets the correct inventory state applied.
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

        // SELECTED_UNIT_CHANGED: free any other unit this opportunity holds
        // before the new one takes its place. Best-effort — the replay below
        // must run even if this step fails.
        let previousReleased: unknown[] = [];
        try {
          const { createCrmClient } = await import("@/lib/kleegr/client.server");
          const { releaseUnitsHeldBy } = await import("@/lib/kleegr/release.server");
          previousReleased = await releaseUnitsHeldBy(
            await createCrmClient(),
            opportunityId,
            "SELECTED_UNIT_CHANGED",
            unitCrmId, // don't release the unit being associated
          );
        } catch (err) {
          console.warn("[unit-associated] previous-unit release failed:", err instanceof Error ? err.message : err);
        }

        const { replayPendingForOpportunity } = await import("@/lib/kleegr/stage-apply.server");
        const result = await replayPendingForOpportunity(opportunityId, unitCrmId);
        return json({ ok: true, ...result, previousReleased });
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
