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
  .handler(async ({ context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Reconcile local mirror against live CRM so counts drop when records
    // are deleted directly in the CRM.
    try {
      const { reconcileScopes } = await import("@/lib/kleegr/live-records.server");
      await reconcileScopes(["project", "building", "unit"]);
    } catch (err) {
      console.warn("[dashboard] reconcile failed:", err instanceof Error ? err.message : err);
    }

    // Sync live unit status (Reserved / Under Contract / Sold) from CRM
    // opportunities into unit_state so the Dashboard tiles match reality.
    try {
      const { fetchUnitLeadsMap } = await import("@/lib/kleegr/opportunity-leads.server");
      const leads = await fetchUnitLeadsMap();
      const { data: existingStates } = await supabaseAdmin
        .from("unit_state").select("unit_crm_id, availability, stage");
      const prevMap = new Map<string, { availability: string | null; stage: string | null }>();
      for (const s of existingStates ?? []) prevMap.set(s.unit_crm_id, { availability: s.availability, stage: s.stage });

      const classify = (availability: string | null, stage: string | null): string => {
        const st = (stage ?? "").trim().toLowerCase();
        const av = (availability ?? "").trim().toLowerCase();
        if (st === "closed/sold" || st === "sold" || st === "closed" || av.includes("sold") || av.includes("closed")) return "sold";
        if (st === "under contract" || (av.includes("under") && av.includes("contract"))) return "under_contract";
        if (st === "reserved/locked" || st === "reserved" || st === "locked" || av.includes("reserved") || av.includes("locked")) return "reserved";
        if (av === "available" || av === "") return "available";
        return "unknown";
      };
      const toState = (status: string): { availability: string; stage: string } => {
        if (status === "sold") return { availability: "Not Available", stage: "Closed/Sold" };
        if (status === "under_contract") return { availability: "Not Available", stage: "Under Contract" };
        if (status === "reserved") return { availability: "Not Available", stage: "Reserved/Locked" };
        if (status === "available") return { availability: "Available", stage: "" };
        return { availability: "", stage: "" };
      };
      const upserts: Array<{ unit_crm_id: string; availability: string; stage: string }> = [];
      for (const [unitId, lead] of leads) {
        if (!lead.status || lead.status === "unknown") continue;
        const prev = prevMap.get(unitId);
        if (classify(prev?.availability ?? null, prev?.stage ?? null) === lead.status) continue;
        upserts.push({ unit_crm_id: unitId, ...toState(lead.status) });
      }
      if (upserts.length > 0) {
        await supabaseAdmin.from("unit_state").upsert(upserts, { onConflict: "unit_crm_id" });
      }
    } catch (err) {
      console.warn("[dashboard] live status sync failed:", err instanceof Error ? err.message : err);
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
