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
 * THE GATE (owner-confirmed rule): only the "Locked/Reserved Units" label
 * drives inventory. "Suggested Units" is browsing — a salesperson shortlisting
 * homes for a client. This webhook fires for BOTH labels and the payload does
 * not say which one it was, so the association is verified against the live
 * CRM before anything happens. A suggested unit exits here having changed
 * nothing: no release of the current unit, no replay, no status write.
 *
 * Effects, once the unit is confirmed Locked/Reserved:
 *   1. SELECTED_UNIT_CHANGED — if this opportunity was already holding a
 *      DIFFERENT unit, that previous unit is released back to Available first
 *      (both in GHL and on the dashboard). One opportunity holds one unit.
 *   2. Replays any `pending_no_unit` stage-change events for this opportunity.
 *   3. Applies the opportunity's CURRENT stage to the unit — so attaching the
 *      label to a deal that is already in, say, Contract Negotiation reserves
 *      the unit immediately, with no stage move needed.
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

        const { createCrmClient } = await import("@/lib/kleegr/client.server");
        let client;
        try {
          client = await createCrmClient();
        } catch (err) {
          return json({ error: "CRM not configured", detail: err instanceof Error ? err.message : String(err) }, 500);
        }

        // ---- THE GATE. Ask the CRM what this association actually is.
        // On a read failure we do NOTHING rather than guess: wrongly locking a
        // browsing unit (and releasing the real one) is far more damaging than
        // a delayed lock, and the self-heal sweep re-checks every held unit
        // against the live CRM every couple of minutes anyway.
        let kind: "locked" | "suggested" | "unrelated";
        try {
          const { classifyUnitForOpportunity } = await import("@/lib/kleegr/opportunities.server");
          kind = await classifyUnitForOpportunity(client, opportunityId, unitCrmId);
        } catch (err) {
          console.warn("[unit-associated] association verify failed:", err instanceof Error ? err.message : err);
          return json({
            ok: true,
            ignored: true,
            reason: "verification_failed",
            message: "Could not confirm the association type with the CRM. Nothing was changed; the sync sweep will settle this shortly.",
          });
        }

        if (kind === "suggested") {
          return json({
            ok: true,
            ignored: true,
            reason: "suggested_unit",
            message: "Suggested Units are browsing-only and never affect inventory. Nothing changed.",
          });
        }

        if (kind === "unrelated") {
          return json({
            ok: true,
            ignored: true,
            reason: "not_locked",
            message: "This unit is not associated to the opportunity as Locked/Reserved. Nothing changed.",
          });
        }

        // ---- Confirmed Locked/Reserved. Full automation from here.

        // 1. SELECTED_UNIT_CHANGED: free any other unit this opportunity holds
        // before the new one takes its place. Best-effort — the steps below
        // must run even if this fails.
        let previousReleased: unknown[] = [];
        try {
          const { releaseUnitsHeldBy } = await import("@/lib/kleegr/release.server");
          previousReleased = await releaseUnitsHeldBy(
            client,
            opportunityId,
            "SELECTED_UNIT_CHANGED",
            unitCrmId, // don't release the unit being associated
          );
        } catch (err) {
          console.warn("[unit-associated] previous-unit release failed:", err instanceof Error ? err.message : err);
        }

        // 2. Replay stage events that arrived before a unit was chosen.
        const { replayPendingForOpportunity } = await import("@/lib/kleegr/stage-apply.server");
        const result = await replayPendingForOpportunity(opportunityId, unitCrmId);

        // 3. The card's current position is the final authority — apply it now,
        // so the unit is correct even when there was no pending event to replay.
        let applied: { outcome: string } = { outcome: "skipped" };
        try {
          const { applyOpportunityStageToUnit } = await import("@/lib/kleegr/release.server");
          applied = await applyOpportunityStageToUnit(client, opportunityId, unitCrmId);
        } catch (err) {
          console.warn("[unit-associated] current-stage apply failed:", err instanceof Error ? err.message : err);
        }

        return json({ ok: true, locked: true, ...result, applied, previousReleased });
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
