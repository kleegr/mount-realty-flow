import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function requireAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId).eq("role", "admin").maybeSingle();
  if (!data) throw new Error("Admin role required");
}

export const getCrmConfig = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: role } = await supabaseAdmin
      .from("user_roles").select("role").eq("user_id", context.userId);
    const roles = (role ?? []).map((r) => r.role);
    if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden");
    const { data } = await supabaseAdmin.from("crm_config").select("*").eq("id", 1).maybeSingle();
    return { config: data, tokenConfigured: Boolean(process.env.KLEEGR_CRM_TOKEN) };
  });

const cfgSchema = z.object({
  location_id: z.string().optional().nullable(),
  api_base_url: z.string().url().optional(),
  project_object_key: z.string().optional().nullable(),
  building_object_key: z.string().optional().nullable(),
  unit_object_key: z.string().optional().nullable(),
  project_object_id: z.string().optional().nullable(),
  building_object_id: z.string().optional().nullable(),
  unit_object_id: z.string().optional().nullable(),
  opportunity_pipeline_id: z.string().optional().nullable(),
  stage_reserved_id: z.string().optional().nullable(),
  stage_under_contract_id: z.string().optional().nullable(),
  stage_closed_id: z.string().optional().nullable(),
  stage_release_id: z.string().optional().nullable(),
  template_xlsx_url: z.string().url().optional().nullable().or(z.literal("")),
});

export const updateCrmConfig = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => cfgSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const payload = {
      ...data,
      project_object_key: cleanString(data.project_object_key) || "custom_objects.project",
      building_object_key: cleanString(data.building_object_key) || "custom_objects.building",
      unit_object_key: cleanString(data.unit_object_key) || "custom_objects.unit",
      project_object_id: cleanString(data.project_object_id),
      building_object_id: cleanString(data.building_object_id),
      unit_object_id: cleanString(data.unit_object_id),
    };
    if (payload.template_xlsx_url === "") payload.template_xlsx_url = null;
    const { error } = await supabaseAdmin.from("crm_config").update(payload as never).eq("id", 1);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

function cleanString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed || null;
}

export const getMyRoles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", context.userId);
    return { roles: (data ?? []).map((r) => r.role) };
  });

export const listPipelines = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("crm_pipelines")
      .select("*")
      .order("created_at", { ascending: true });
    if (error) throw new Error(error.message);
    return { pipelines: data ?? [] };
  });

const pipelineSchema = z.object({
  id: z.string().uuid().optional().nullable(),
  pipeline_id: z.string().min(1),
  label: z.string().optional().nullable(),
  stage_reserved_id: z.string().optional().nullable(),
  stage_under_contract_id: z.string().optional().nullable(),
  stage_closed_id: z.string().optional().nullable(),
  stage_release_id: z.string().optional().nullable(),
});

export const upsertPipeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => pipelineSchema.parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const payload = {
      pipeline_id: data.pipeline_id,
      label: data.label ?? null,
      stage_reserved_id: data.stage_reserved_id ?? null,
      stage_under_contract_id: data.stage_under_contract_id ?? null,
      stage_closed_id: data.stage_closed_id ?? null,
      stage_release_id: data.stage_release_id ?? null,
    };
    if (data.id) {
      const { error } = await supabaseAdmin.from("crm_pipelines").update(payload).eq("id", data.id);
      if (error) throw new Error(error.message);
    } else {
      const { error } = await supabaseAdmin.from("crm_pipelines").upsert(payload, { onConflict: "pipeline_id" });
      if (error) throw new Error(error.message);
    }
    return { ok: true };
  });

export const deletePipeline = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ id: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.from("crm_pipelines").delete().eq("id", data.id);
    if (error) throw new Error(error.message);
    return { ok: true };
  });
