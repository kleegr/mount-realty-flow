import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * BUILDING-MATCH DIAGNOSTIC.
 *
 * The opportunity importer resolves a building by:
 *   norm(`${developer} - ${building}`)  ==  norm(external_id_map.display_name)
 * for scope='building'. When it says "no building matching X", either:
 *   (a) no external_id_map row has that display_name, or
 *   (b) a row exists but the normalized strings differ (spacing, casing, a
 *       slash, a hidden character).
 *
 * This tool dumps BOTH sides so the mismatch is visible instead of guessed:
 *   - every building display_name currently in external_id_map (+ its norm)
 *   - the target strings the importer would build for the failing rows
 * Read-only.
 */

async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden: importer role required.");
}

function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export const diagnoseBuildingMatch = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ confirm: z.literal("DIAG"), needles: z.array(z.string()).default([]) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // ALL building rows in external_id_map, with their raw + normalized names.
    const { data: buildings } = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id, display_name, external_import_id, code")
      .eq("scope", "building")
      .order("display_name");

    const rows = (buildings ?? []).map((b) => ({
      crm_record_id: b.crm_record_id,
      display_name: b.display_name,
      display_name_norm: norm(b.display_name),
      external_import_id: b.external_import_id,
      code: b.code,
      has_null_name: b.display_name == null,
    }));

    // For each needle (e.g. "319 Lake Shore - 319 Lake Shore"), show whether ANY
    // building matches by normalized name, and the closest candidates.
    const needleResults = (data.needles ?? []).map((needle) => {
      const nNorm = norm(needle);
      const exact = rows.filter((r) => r.display_name_norm === nNorm);
      // near matches: contains, or shares a long prefix
      const near = rows
        .filter((r) => r.display_name_norm && (r.display_name_norm.includes(nNorm) || nNorm.includes(r.display_name_norm)))
        .slice(0, 5);
      return {
        needle,
        needleNorm: nNorm,
        exactMatchCount: exact.length,
        exactMatches: exact,
        nearMatches: near,
      };
    });

    // Buildings whose display_name is NULL but which have a Lake Shore / Duelk /
    // Indigo -ish external id or code (i.e. the flex-created ones that may have
    // failed to record a name).
    const suspiciousNullNames = rows.filter((r) => r.has_null_name).slice(0, 40);

    return {
      totalBuildingRows: rows.length,
      buildingsWithNullName: rows.filter((r) => r.has_null_name).length,
      needleResults,
      suspiciousNullNames,
      // A sample of all names so we can eyeball the real format used.
      allBuildingNamesSample: rows.slice(0, 120).map((r) => r.display_name ?? "(null)"),
    };
  });
