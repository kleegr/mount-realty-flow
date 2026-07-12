import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function requireAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (!data) throw new Error("Admin role required");
}

export const startCrmSync = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ scope: z.enum(["project", "building", "unit", "all"]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Refuse to start a second sync while one is already running for the same scope
    const { data: existing } = await supabaseAdmin
      .from("sync_jobs")
      .select("id")
      .eq("status", "running")
      .in("scope", data.scope === "all" ? ["all"] : [data.scope, "all"])
      .limit(1);
    if (existing && existing.length > 0) {
      throw new Error("A sync is already running for this scope. Wait for it to finish.");
    }

    const { data: job, error } = await supabaseAdmin
      .from("sync_jobs")
      .insert({ scope: data.scope, started_by: context.userId })
      .select("id")
      .single();
    if (error || !job) throw new Error(error?.message ?? "Failed to create sync job");

    // Fire and forget — the worker updates the job as it progresses.
    const { runSync } = await import("@/lib/sync/run.server");
    void runSync(job.id, data.scope).catch((e) =>
      console.error("[sync] worker crashed:", e instanceof Error ? e.message : e),
    );

    return { jobId: job.id };
  });

export const listSyncJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("sync_jobs")
      .select("*")
      .order("started_at", { ascending: false })
      .limit(20);
    if (error) throw new Error(error.message);
    return { jobs: data ?? [] };
  });

export const getSyncJob = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: job, error } = await supabaseAdmin
      .from("sync_jobs").select("*").eq("id", data.id).maybeSingle();
    if (error) throw new Error(error.message);
    return { job };
  });
