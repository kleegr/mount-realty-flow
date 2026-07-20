import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * INVENTORY + PIPELINE AUDIT (spec 7).
 *
 * Read-only except for an optional CRM->mirror sync that only ever fills in
 * missing unit_state rows (never deletes). Answers two questions the spec
 * requires confirmed from live data:
 *
 * 1) PIPELINE first-stage + deal placement: for every pipeline, the real first
 *    stage (id + name) and how many deals sit in each stage. Also surfaces a
 *    stray deal a wrong-pipeline run may have created.
 *
 * 2) INVENTORY safety: the true unit_state distribution. IMPORTANT - two columns
 *    matter and mean different things:
 *      held_by_opportunity_id  -> the importer's lock (this is "held")
 *      availability / stage     -> mirrored from the CRM by syncUnitStatesFromCrm
 *    A held unit is one with a non-null held_by_opportunity_id. An earlier audit
 *    read the wrong column and reported zero. This reads held_by_opportunity_id,
 *    and (optionally) runs the CRM mirror first so the table is complete rather
 *    than sparse.
 */

async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden: importer role required.");
}

export const auditPipelinesAndInventory = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ confirm: z.literal("AUDIT"), syncFirst: z.boolean().default(false) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();
    const locationId = String(client.config.location_id);

    // Optionally mirror every unit's live CRM state into unit_state first, so the
    // inventory counts below reflect all units, not just the sparse subset.
    let syncResult: unknown = null;
    if (data.syncFirst) {
      try {
        const { syncUnitStatesFromCrm } = await import("./kleegr/live-records.server");
        syncResult = await syncUnitStatesFromCrm(client);
      } catch (err) {
        syncResult = { error: err instanceof Error ? err.message : String(err) };
      }
    }

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

    // ---- Inventory: from external_id_map (all units) LEFT-JOINed to state. ----
    const [{ data: allUnits }, { data: states }] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", "unit"),
      supabaseAdmin.from("unit_state").select("unit_crm_id, held_by_opportunity_id, availability, stage"),
    ]);

    const stateById = new Map<string, { held: string | null; availability: string; stage: string }>();
    for (const s of states ?? []) {
      stateById.set(s.unit_crm_id, {
        held: (s.held_by_opportunity_id as string | null) ?? null,
        availability: (s.availability as string) ?? "",
        stage: (s.stage as string) ?? "",
      });
    }

    const inv = { totalUnitsMapped: allUnits?.length ?? 0, stateRows: states?.length ?? 0, held: 0, available: 0, noState: 0, other: 0 };
    const heldIds: string[] = [];
    for (const u of allUnits ?? []) {
      const st = stateById.get(u.crm_record_id);
      if (!st) {
        inv.noState++;
        continue;
      }
      if (st.held) {
        inv.held++;
        heldIds.push(st.held);
      } else if (!st.stage && /available/i.test(st.availability)) {
        inv.available++;
      } else {
        inv.other++;
      }
    }

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
      syncResult,
      pipelines,
      inventory: inv,
      heldOpportunities: uniqueHolders.length,
      staleHoldersCheckedFirst: checked,
      staleHoldersFound: staleHolders,
    };
  });
