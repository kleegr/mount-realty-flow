import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * INVENTORY POSTURE — read-only. Answers "what is actually in there right now?"
 * before anything destructive gets written.
 *
 * It exists because two separate reads misled us today:
 *
 *   - unit_state has 8 rows, which looked like an empty inventory. It isn't the
 *     inventory. It's a SPARSE log — the engine only writes a row when it
 *     touches a unit. The real inventory is external_id_map: 332 units.
 *
 *   - contacts "imported" today turned out to be 142 updates and 1 create,
 *     because an earlier run had already created them. The same question is
 *     open for opportunities, and there the stakes are higher: duplicate deals
 *     corrupt both the pipeline and the inventory counts that derive from them.
 *
 * THE LANDMINE THIS QUANTIFIES: recalcAllRollups() classifies a unit with no
 * unit_state row as `unclassified`, and writeBuildingRollup never writes an
 * unclassified field. So with 332 units and 8 states, a "Sync now" would push
 * available: 0 to all 71 buildings — arithmetically coherent, entirely wrong.
 * unitsWithoutState below is exactly the size of that blast radius.
 */

async function roles(userId: string): Promise<string[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  return (data ?? []).map((r) => r.role);
}

export const getInventoryPosture = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await roles(context.userId);
    if (!r.includes("admin") && !r.includes("importer")) throw new Error("Forbidden: importer role required.");

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");

    // ---- what the mirror knows
    const [units, buildings, projects, states, contacts] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "unit"),
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "building"),
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "project"),
      supabaseAdmin.from("unit_state").select("unit_crm_id, availability, stage"),
      supabaseAdmin.from("contact_id_map").select("stable_id", { count: "exact", head: true }),
    ]);

    const stateRows = states.data ?? [];
    const byAvailability: Record<string, number> = {};
    for (const s of stateRows) {
      const k = (s.availability ?? "(null)").trim() || "(blank)";
      byAvailability[k] = (byAvailability[k] ?? 0) + 1;
    }
    const withStage = stateRows.filter((s) => (s.stage ?? "").trim()).length;

    const unitCount = units.count ?? 0;
    const unitsWithoutState = Math.max(0, unitCount - stateRows.length);

    // ---- what GHL actually holds
    const pipelines: Array<{ name: string; id: string; opportunities: number | null; note: string }> = [];
    let crmError: string | null = null;

    try {
      const client = await createCrmClient();
      const locationId = client.config.location_id;

      const cat = await client.request<{ pipelines?: Array<Record<string, unknown>> }>(
        "GET",
        "/opportunities/pipelines",
        { query: { locationId: String(locationId) } },
      );

      for (const p of cat.data?.pipelines ?? []) {
        const id = typeof p.id === "string" ? p.id : "";
        const name = String(p.name ?? "(unnamed)");
        if (!id) continue;
        try {
          // limit=1: we want the count, not the payload.
          const s = await client.request<{ meta?: { total?: number }; total?: number }>(
            "GET",
            "/opportunities/search",
            { query: { location_id: String(locationId), pipeline_id: id, limit: 1 } },
          );
          const total = s.data?.meta?.total ?? s.data?.total ?? null;
          pipelines.push({
            name,
            id,
            opportunities: typeof total === "number" ? total : null,
            note: typeof total === "number" ? "" : "count not returned by the API",
          });
        } catch (err) {
          pipelines.push({
            name,
            id,
            opportunities: null,
            note: err instanceof Error ? err.message.slice(0, 160) : String(err),
          });
        }
      }
    } catch (err) {
      crmError = err instanceof Error ? err.message : String(err);
    }

    const totalOpps = pipelines.reduce((n, p) => n + (p.opportunities ?? 0), 0);

    return {
      inventory: {
        units: unitCount,
        buildings: buildings.count ?? 0,
        projects: projects.count ?? 0,
      },
      mirror: {
        unitStateRows: stateRows.length,
        unitsWithoutState,
        byAvailability,
        unitsWithAStage: withStage,
      },
      contactsMapped: contacts.count ?? 0,
      pipelines,
      totalOpportunities: totalOpps,
      crmError,
      // Plain-language readings, so the numbers can't be misinterpreted twice.
      readings: {
        recalcWouldZero:
          unitsWithoutState > 0
            ? `"Sync now" would write available: 0 to buildings covering ${unitsWithoutState} units, because a unit with no mirrored state counts as unclassified and unclassified is never written to GHL.`
            : "Every mapped unit has mirrored state; a recalc is safe.",
        opportunityRisk:
          totalOpps > 0
            ? `${totalOpps} opportunities already exist. Importing 183 more would ADD to these, not replace them. Check these are not the Lazers deals before importing.`
            : "No opportunities found. A fresh import would not duplicate anything.",
      },
    };
  });
