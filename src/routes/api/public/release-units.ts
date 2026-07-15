/**
 * Admin tool — force-release units back to Available.
 *
 * AUTH: the KLEEGR_WEBHOOK_SECRET env value, NOT a hardcoded token. Pass it
 * either as ?secret=<value> or as an `x-kleegr-secret` header. (The previous
 * hardcoded token had been shared in a support conversation, so it was
 * rotated out entirely.)
 *
 *   ?secret=<KLEEGR_WEBHOOK_SECRET>&ids=<unitCrmId,unitCrmId,...>
 *   &dry=1   → report what WOULD change, write nothing
 *
 * Uses the shared release engine: updates the GHL Unit record AND the
 * unit_state mirror, clears the holder, recomputes parent Building/Project
 * rollups, and writes an audit event with reason MANUAL_UNIT_RELEASE.
 *
 * MANUAL_UNIT_RELEASE is the one reason permitted to free a Closed/Sold unit
 * — automated paths never can.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/release-units")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);

          const secret = process.env.KLEEGR_WEBHOOK_SECRET;
          const provided = url.searchParams.get("secret") ?? request.headers.get("x-kleegr-secret");
          if (!secret || !provided || provided !== secret) {
            return json({ error: "Invalid secret" }, 401);
          }

          const idsParam = url.searchParams.get("ids") ?? "";
          const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
          if (ids.length === 0) {
            return json({ error: "ids query param required (comma-separated unit CRM ids)" }, 400);
          }
          if (ids.length > 50) {
            return json({ error: "max 50 ids per call" }, 400);
          }
          const dryRun = url.searchParams.get("dry") === "1";

          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { data: before } = await supabaseAdmin
            .from("unit_state")
            .select("unit_crm_id, availability, stage")
            .in("unit_crm_id", ids);

          if (dryRun) {
            return json({
              ok: true,
              dry_run: true,
              would_release: (before ?? []).map((r) => ({
                unitCrmId: r.unit_crm_id,
                from: { availability: r.availability, stage: r.stage },
                to: { availability: "Available", stage: "" },
              })),
              not_in_mirror: ids.filter((id) => !(before ?? []).some((r) => r.unit_crm_id === id)),
            });
          }

          const { createCrmClient } = await import("@/lib/kleegr/client.server");
          const { releaseUnit } = await import("@/lib/kleegr/release.server");
          const client = await createCrmClient();

          const released: Array<{ unitCrmId: string; released: boolean; outcome: string }> = [];
          for (const id of ids) {
            released.push(await releaseUnit(client, id, "MANUAL_UNIT_RELEASE"));
          }

          return json({ ok: true, released });
        } catch (err) {
          return json(
            { ok: false, caught: err instanceof Error ? err.message : String(err) },
            500,
          );
        }
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
