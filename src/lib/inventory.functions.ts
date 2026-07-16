import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";


async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden");
}

export const getDashboardSnapshot = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ refresh: z.boolean().optional() }).optional().parse(d) ?? {})
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const refresh = data?.refresh === true;

    // Self-heal on every view (throttled inside; forced on explicit Sync now).
    // Prunes deleted CRM records, mirrors every unit's actual availability from
    // the CRM, and releases/re-applies any unit whose holding opportunity is
    // deleted / lost / moved / no longer holds the Locked/Reserved label.
    try {
      const { selfHealCrmState } = await import("@/lib/kleegr/release.server");
      await selfHealCrmState(refresh);
    } catch (err) {
      console.warn("[dashboard] self-heal failed:", err instanceof Error ? err.message : err);
    }

    // Explicit Sync now also rebuilds every Building/Project count from the
    // units themselves. This is the repair path for records whose numbers came
    // from somewhere other than the rollup engine (an old spreadsheet column, a
    // hand edit in GHL) — e.g. a building left showing Total 4 / Available 7.
    // One PUT per building + project, so it stays on the manual path only.
    let rollups: { buildings: number; projects: number; failed: number; skipped: string | null } | null = null;
    if (refresh) {
      try {
        const { recalcAllRollups } = await import("@/lib/kleegr/rollups.server");
        const res = await recalcAllRollups();
        rollups = {
          buildings: res.buildings,
          projects: res.projects,
          failed: res.failed.length,
          skipped: res.skipped,
        };
        if (res.failed.length > 0) {
          console.warn("[dashboard] rollup recalc failures:", res.failed.slice(0, 5));
        }
      } catch (err) {
        console.warn("[dashboard] rollup recalc failed:", err instanceof Error ? err.message : err);
      }
    }



    const [projectsMap, buildingsMap, unitsMap, unitStates, recentJobs, recentAudit, recentWebhooks] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "project"),
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "building"),
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "unit"),
      supabaseAdmin.from("unit_state").select("availability, stage"),
      supabaseAdmin.from("import_jobs").select("id, filename, status, created_at, units_created, units_updated, errors_count").order("created_at", { ascending: false }).limit(5),
      supabaseAdmin.from("audit_events").select("id, kind, entity_crm_id, reason, created_at").order("created_at", { ascending: false }).limit(5),
      supabaseAdmin.from("webhook_events").select("id, outcome, opportunity_id, stage_id, received_at").order("received_at", { ascending: false }).limit(5),
    ]);

    const byAvail: Record<string, number> = { available: 0, reserved: 0, under_contract: 0, sold: 0 };
    for (const row of unitStates.data ?? []) {
      const stage = (row.stage ?? "").trim().toLowerCase();
      const availability = (row.availability ?? "").trim().toLowerCase();
      if (stage === "reserved/locked" || stage === "reserved" || stage === "locked") byAvail.reserved++;
      else if (stage === "under contract") byAvail.under_contract++;
      else if (stage === "closed/sold" || stage === "sold" || stage === "closed") byAvail.sold++;
      else if (availability.includes("reserved") || availability.includes("locked")) byAvail.reserved++;
      else if (availability.includes("under") && availability.includes("contract")) byAvail.under_contract++;
      else if (availability.includes("sold") || availability.includes("closed")) byAvail.sold++;
      else if (availability === "available" || !availability) byAvail.available++;
    }

    return {
      counts: {
        projects: projectsMap.count ?? 0,
        buildings: buildingsMap.count ?? 0,
        units: unitsMap.count ?? 0,
      },
      availability: {
        available: byAvail.available,
        reserved: byAvail.reserved,
        under_contract: byAvail.under_contract,
        sold: byAvail.sold,
      },
      rollups,
      recentJobs: recentJobs.data ?? [],
      recentAudit: recentAudit.data ?? [],
      recentWebhooks: recentWebhooks.data ?? [],
    };
  });

export const getInventory = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("external_id_map")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    return { records: data ?? [] };
  });
