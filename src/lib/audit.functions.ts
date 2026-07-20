import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * INVENTORY + PIPELINE AUDIT (spec 7).
 *
 * Read-only. Answers two questions the spec requires confirmed from live data:
 *
 * 1) PIPELINE first-stage + deal placement: for every governed pipeline, the
 *    real first stage (id + name) and how many deals sit in each stage. This is
 *    also how we spot the stray deal a wrong-pipeline run created.
 *
 * 2) INVENTORY safety: the current unit_state distribution (available / held),
 *    and any unit that is held by an opportunity that no longer exists (which
 *    should have been cleared). Confirms the Available sweep did not free a
 *    legitimately held unit.
 */

async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden: importer role required.");
}

export const auditPipelinesAndInventory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("AUDIT") }).parse(d))
  .handler(async ({ context }) => {
    await requireImporter(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();
    const locationId = String(client.config.location_id);

    // ---- Pipelines: first stage + per-stage deal counts. ----
    const pipeRes = await client.request<{ pipelines?: Array<Record<string, unknown>> }>(
      "GET",
      "/opportunities/pipelines",
      { query: { locationId } },
    );

    const pipelines: Array<{
      id: string;
      name: string;
      firstStage: { id: string; name: string } | null;
      totalDeals: number;
      stageCounts: Array<{ stageId: string; stageName: string; count: number }>;
      sampleDeals: Array<{ id: string; name: string; stageId: string }>;
    }> = [];

    for (const p of pipeRes.data?.pipelines ?? []) {
      const id = typeof p.id === "string" ? p.id : "";
      if (!id) continue;
      const stages = Array.isArray(p.stages)
        ? (p.stages as Array<Record<string, unknown>>).map((s) => ({ id: String(s.id ?? ""), name: String(s.name ?? "") }))
        : [];

      // Pull deals (first page) to count by stage and sample names.
      let deals: Array<Record<string, unknown>> = [];
      let total = 0;
      try {
        const sr = await client.request<{
          opportunities?: Array<Record<string, unknown>>;
          meta?: { total?: number };
          total?: number;
        }>("GET", "/opportunities/search", {
          query: { location_id: locationId, pipeline_id: id, limit: 100 },
        });
        deals = Array.isArray(sr.data?.opportunities) ? sr.data.opportunities : [];
        total = sr.data?.meta?.total ?? sr.data?.total ?? deals.length;
      } catch {
        deals = [];
      }

      const stageCountMap = new Map<string, number>();
      for (const d of deals) {
        const sid = String(d.pipelineStageId ?? d.stageId ?? "");
        stageCountMap.set(sid, (stageCountMap.get(sid) ?? 0) + 1);
      }

      pipelines.push({
        id,
        name: String(p.name ?? "(unnamed)"),
        firstStage: stages[0] ?? null,
        totalDeals: total,
        stageCounts: stages.map((s) => ({ stageId: s.id, stageName: s.name, count: stageCountMap.get(s.id) ?? 0 })),
        sampleDeals: deals.slice(0, 25).map((d) => ({
          id: String(d.id ?? ""),
          name: String(d.name ?? ""),
          stageId: String(d.pipelineStageId ?? d.stageId ?? ""),
        })),
      });
    }

    // ---- Inventory: unit_state distribution + stale holds. ----
    const { data: states } = await supabaseAdmin
      .from("unit_state")
      .select("unit_crm_id, status, held_by_opportunity_id, availability, stage");

    const inv = { total: states?.length ?? 0, available: 0, held: 0, other: 0 };
    const heldIds: string[] = [];
    for (const s of states ?? []) {
      if (s.held_by_opportunity_id) {
        inv.held++;
        heldIds.push(s.held_by_opportunity_id as string);
      } else if ((s.status ?? "").toLowerCase() === "available" || (s.availability ?? "").toLowerCase() === "available") {
        inv.available++;
      } else {
        inv.other++;
      }
    }

    // Check a sample of held opportunities still exist (stale-hold detection).
    const uniqueHolders = [...new Set(heldIds)];
    const staleHolders: string[] = [];
    let checked = 0;
    for (const oppId of uniqueHolders.slice(0, 40)) {
      checked++;
      try {
        await client.request("GET", `/opportunities/${oppId}`, {});
      } catch (err) {
        const status = (err as { status?: number })?.status;
        if (status === 404 || status === 400) staleHolders.push(oppId);
      }
    }

    return {
      locationId,
      pipelines,
      inventory: inv,
      heldOpportunities: uniqueHolders.length,
      staleHoldersCheckedFirst: checked,
      staleHoldersFound: staleHolders,
    };
  });
