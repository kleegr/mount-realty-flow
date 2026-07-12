/**
 * Pending stage-change events dashboard: list, replay with a supplied unit CRM ID,
 * and best-effort auto-rescan (drops rows that have already been resolved).
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function requireImporterOrAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) {
    throw new Error("Forbidden");
  }
}

export const listPendingEvents = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireImporterOrAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("webhook_events")
      .select("id, opportunity_id, pipeline_id, stage_id, received_at, outcome")
      .eq("outcome", "pending_no_unit")
      .is("processed_at", null)
      .order("received_at", { ascending: false })
      .limit(50);
    if (error) throw new Error(error.message);
    return { events: data ?? [], scannedAt: new Date().toISOString() };
  });

export const applyPendingWithUnit = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      opportunityId: z.string().min(1),
      unitCrmId: z.string().min(1),
    }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporterOrAdmin(context.userId);
    const { replayPendingForOpportunity } = await import("@/lib/kleegr/stage-apply.server");
    const result = await replayPendingForOpportunity(data.opportunityId, data.unitCrmId);
    return { ok: true, ...result };
  });
