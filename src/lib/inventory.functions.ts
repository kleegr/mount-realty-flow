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

    const [projectsMap, buildingsMap, unitsMap, recentJobs, recentAudit, recentWebhooks] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "project"),
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "building"),
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "unit"),
      supabaseAdmin.from("import_jobs").select("id, filename, status, created_at, units_created, units_updated, errors_count").order("created_at", { ascending: false }).limit(5),
      supabaseAdmin.from("audit_events").select("id, kind, entity_crm_id, reason, created_at").order("created_at", { ascending: false }).limit(5),
      supabaseAdmin.from("webhook_events").select("id, outcome, opportunity_id, stage_id, received_at").order("received_at", { ascending: false }).limit(5),
    ]);

    return {
      counts: {
        projects: projectsMap.count ?? 0,
        buildings: buildingsMap.count ?? 0,
        units: unitsMap.count ?? 0,
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
