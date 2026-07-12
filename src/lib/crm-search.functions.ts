import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

export interface CrmSearchResult {
  crmId: string;
  scope: "project" | "building" | "unit";
  displayName: string;
  code: string | null;
  parentCrmId: string | null;
}

export const searchCrmRecords = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({
      query: z.string().default(""),
      scope: z.enum(["project", "building", "unit"]).optional(),
      limit: z.number().int().min(1).max(50).default(20),
    }).parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    let q = supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id, scope, display_name, code, parent_crm_id")
      .order("display_name", { ascending: true, nullsFirst: false })
      .limit(data.limit);

    if (data.scope) q = q.eq("scope", data.scope);
    if (data.query.trim()) {
      const term = `%${data.query.trim()}%`;
      q = q.or(`display_name.ilike.${term},code.ilike.${term},crm_record_id.ilike.${term}`);
    }

    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);

    const results: CrmSearchResult[] = (rows ?? []).map((r) => ({
      crmId: r.crm_record_id,
      scope: r.scope as CrmSearchResult["scope"],
      displayName: r.display_name ?? "(no name)",
      code: r.code,
      parentCrmId: r.parent_crm_id,
    }));
    return { results };
  });
