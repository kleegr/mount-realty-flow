import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * HIERARCHY REPAIR — external_id_map.parent_crm_id is NULL for all 332 units,
 * 71 buildings and 12 projects.
 *
 * ROOT CAUSE: flex-execute.server.ts saveMap() writes scope, external_import_id,
 * crm_record_id, first_seen_job_id, display_name and code — and never
 * parent_crm_id. The importer resolves parents correctly (parentCrm.building /
 * parentCrm.project) and queues the GHL associations, then discards the
 * parentage instead of persisting it.
 *
 * WHY IT MATTERS: recalcAllRollups() starts each unit with
 *   `const parent = u.parent_crm_id; if (!parent) continue;`
 * so with every parent null it skips all 332 units and writes nothing — exactly
 * the "Recalculated 0 buildings and 0 projects" we just saw. The Jul 7
 * spreadsheet's numbers (MYLU: Total 4 / Available 7 / Reserved -3) have been
 * unrepairable ever since, because the repair path had nothing to count.
 *
 * INSPECT BEFORE REPAIR: the associations may not exist in GHL either.
 * associateByScopes() returns ok:false when no association DEFINITION exists
 * between two object types, and the importer only records that as a warning. So
 * "the import ran" is not evidence the links were made. This dumps the raw
 * definitions and one real relation payload per scope so the repair is written
 * against the actual shape rather than a guess at it.
 */

async function requireAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin")) throw new Error("Forbidden: admin only.");
}

/**
 * Read whatever GHL returns for a record's relations, without assuming a shape.
 * Tries the documented path and reports verbatim on failure.
 */
async function readRelations(
  client: { config: { location_id: string | null }; request: <T>(m: "GET", p: string, o?: unknown) => Promise<{ data: T }> },
  recordId: string,
): Promise<{ ok: boolean; raw: unknown; error?: string }> {
  try {
    const res = await client.request<unknown>("GET", `/associations/relations/${recordId}`, {
      query: { locationId: String(client.config.location_id), skip: 0, limit: 100 },
    });
    return { ok: true, raw: res.data };
  } catch (err) {
    return { ok: false, raw: null, error: err instanceof Error ? err.message.slice(0, 400) : String(err) };
  }
}

export const inspectHierarchy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("LOOK") }).parse(d))
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();
    const locationId = client.config.location_id;

    // ---- 1. What associations are DEFINED at this location?
    let defs: unknown = null;
    let defsError: string | null = null;
    try {
      const res = await client.request<{ associations?: unknown[] }>("GET", "/associations/", {
        query: { locationId: String(locationId), skip: 0, limit: 100 },
      });
      defs = res.data?.associations ?? res.data;
    } catch (err) {
      defsError = err instanceof Error ? err.message.slice(0, 400) : String(err);
    }

    // ---- 2. One real record per scope, and whatever relations it carries.
    const samples: Record<string, { crmId: string | null; displayName: string | null; relations: unknown; error?: string }> = {};
    for (const scope of ["project", "building", "unit"] as const) {
      const { data: row } = await supabaseAdmin
        .from("external_id_map")
        .select("crm_record_id, display_name")
        .eq("scope", scope)
        .limit(1)
        .maybeSingle();

      if (!row?.crm_record_id) {
        samples[scope] = { crmId: null, displayName: null, relations: null, error: "no record mapped" };
        continue;
      }
      const rel = await readRelations(client as never, row.crm_record_id);
      samples[scope] = {
        crmId: row.crm_record_id,
        displayName: row.display_name,
        relations: rel.raw,
        ...(rel.error ? { error: rel.error } : {}),
      };
    }

    return {
      locationId,
      objectKeys: {
        project: client.config.project_object_key ?? null,
        building: client.config.building_object_key ?? null,
        unit: client.config.unit_object_key ?? null,
      },
      associationDefinitions: defs,
      associationDefinitionsError: defsError,
      samples,
      note:
        "If associationDefinitions contains a project<->building and a building<->unit pair, AND the samples " +
        "carry matching relations, parentage can be rebuilt from GHL. If the relations come back empty, the " +
        "links were never created and the hierarchy has to be rebuilt from the spreadsheet instead.",
    };
  });
