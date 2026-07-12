import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden");
}

export const getDashboardSnapshot = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [projectsMap, buildingsMap, unitsMap, unitStates, recentJobs, recentAudit, recentWebhooks] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "project"),
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "building"),
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "unit"),
      supabaseAdmin.from("unit_state").select("availability"),
      supabaseAdmin.from("import_jobs").select("id, filename, status, created_at, units_created, units_updated, errors_count").order("created_at", { ascending: false }).limit(5),
      supabaseAdmin.from("audit_events").select("id, kind, entity_crm_id, reason, created_at").order("created_at", { ascending: false }).limit(5),
      supabaseAdmin.from("webhook_events").select("id, outcome, opportunity_id, stage_id, received_at").order("received_at", { ascending: false }).limit(5),
    ]);

    const byAvail: Record<string, number> = { available: 0, reserved: 0, under_contract: 0, sold: 0 };
    for (const row of unitStates.data ?? []) {
      const k = (row.availability ?? "available").toLowerCase().replace(/[\s-]/g, "_");
      if (k in byAvail) byAvail[k]++;
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
