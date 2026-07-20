import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * STAGE -> STATUS MAPPING CONFIG.
 *
 * The unit-status engine (release.server.ts) decides a unit's status from the
 * per-pipeline stage lists in crm_pipelines:
 *   release_stage_names[]        -> Available
 *   reserved_stage_names[]       -> Reserved
 *   under_contract_stage_names[] -> Under Contract
 *   sold_stage_names[]           -> Closed/Sold
 * A stage NOT in any list leaves the unit's current status unchanged.
 *
 * This module reads each pipeline's live stages from GHL, shows the current
 * mapping, and writes a new one. Changing a stage's status here takes effect on
 * the next reconcile (dashboard/report view, or a manual sync).
 */

async function requireAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin")) throw new Error("Forbidden: admin role required to change stage rules.");
}

export type StageStatus = "available" | "reserved" | "under_contract" | "sold" | "unmapped";

function norm(s: unknown): string {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

// ---------------------------------------------------------------- read

export const getStageConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("LOOK") }).parse(d))
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();
    const locationId = String(client.config.location_id);

    // Live pipelines + stages from GHL.
    const pipeRes = await client.request<{ pipelines?: Array<Record<string, unknown>> }>(
      "GET",
      "/opportunities/pipelines",
      { query: { locationId } },
    );
    const livePipelines = (pipeRes.data?.pipelines ?? []).map((p) => ({
      id: String(p.id ?? ""),
      name: String(p.name ?? "(unnamed)"),
      stages: Array.isArray(p.stages)
        ? (p.stages as Array<Record<string, unknown>>).map((s) => ({ id: String(s.id ?? ""), name: String(s.name ?? "") }))
        : [],
    }));

    // Current rule lists from crm_pipelines.
    const { data: rules } = await supabaseAdmin
      .from("crm_pipelines")
      .select(
        "pipeline_id, pipeline_name, release_stage_names, reserved_stage_names, under_contract_stage_names, sold_stage_names",
      );
    const ruleByPid = new Map<string, Record<string, unknown>>();
    for (const r of rules ?? []) if (r.pipeline_id) ruleByPid.set(String(r.pipeline_id), r);

    const statusOf = (rule: Record<string, unknown> | undefined, stageName: string): StageStatus => {
      if (!rule) return "unmapped";
      const inList = (key: string) =>
        Array.isArray(rule[key]) && (rule[key] as unknown[]).some((n) => norm(n) === norm(stageName));
      if (inList("release_stage_names")) return "available";
      if (inList("reserved_stage_names")) return "reserved";
      if (inList("under_contract_stage_names")) return "under_contract";
      if (inList("sold_stage_names")) return "sold";
      return "unmapped";
    };

    const pipelines = livePipelines.map((p) => {
      const rule = ruleByPid.get(p.id);
      return {
        pipelineId: p.id,
        pipelineName: p.name,
        governed: Boolean(rule),
        stages: p.stages.map((s) => ({ stageId: s.id, stageName: s.name, status: statusOf(rule, s.name) })),
      };
    });

    return { locationId, pipelines };
  });

// ---------------------------------------------------------------- write

const AssignmentSchema = z.object({
  confirm: z.literal("SAVE"),
  pipelineId: z.string().min(1),
  pipelineName: z.string().min(1),
  // stageName -> status. "unmapped" removes the stage from every list.
  assignments: z.record(z.string(), z.enum(["available", "reserved", "under_contract", "sold", "unmapped"])),
});

export const saveStageConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => AssignmentSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Rebuild the four lists from the assignment map. This is a full replace for
    // the stages the user sent, which is every stage in the pipeline - so the
    // lists become an exact reflection of the on-screen choices.
    const release: string[] = [];
    const reserved: string[] = [];
    const underContract: string[] = [];
    const sold: string[] = [];
    for (const [stageName, status] of Object.entries(data.assignments)) {
      if (status === "available") release.push(stageName);
      else if (status === "reserved") reserved.push(stageName);
      else if (status === "under_contract") underContract.push(stageName);
      else if (status === "sold") sold.push(stageName);
      // "unmapped" -> in no list
    }

    // Upsert the row for this pipeline. Keyed by pipeline_id.
    const { data: existing } = await supabaseAdmin
      .from("crm_pipelines")
      .select("pipeline_id")
      .eq("pipeline_id", data.pipelineId)
      .maybeSingle();

    const payload = {
      pipeline_id: data.pipelineId,
      pipeline_name: data.pipelineName,
      release_stage_names: release,
      reserved_stage_names: reserved,
      under_contract_stage_names: underContract,
      sold_stage_names: sold,
    };

    if (existing) {
      const { error } = await supabaseAdmin.from("crm_pipelines").update(payload).eq("pipeline_id", data.pipelineId);
      if (error) throw new Error(`Save failed: ${error.message}`);
    } else {
      const { error } = await supabaseAdmin.from("crm_pipelines").insert(payload);
      if (error) throw new Error(`Save failed: ${error.message}`);
    }

    return {
      saved: true,
      counts: {
        available: release.length,
        reserved: reserved.length,
        under_contract: underContract.length,
        sold: sold.length,
      },
    };
  });
