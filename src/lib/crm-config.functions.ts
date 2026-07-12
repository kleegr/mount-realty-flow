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
    const payload = { ...data };
    if (payload.template_xlsx_url === "") payload.template_xlsx_url = null;
    const { error } = await supabaseAdmin.from("crm_config").update(payload as never).eq("id", 1);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const getMyRoles = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", context.userId);
    return { roles: (data ?? []).map((r) => r.role) };
  });
