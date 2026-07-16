import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * HIERARCHY REPAIR — rebuild external_id_map.parent_crm_id from GHL.
 *
 * ROOT CAUSE: flex-execute.server.ts saveMap() writes scope, external_import_id,
 * crm_record_id, first_seen_job_id, display_name and code — and never
 * parent_crm_id. The importer resolves the parent correctly, uses it to create
 * the GHL association, then discards it instead of persisting it locally.
 *
 * WHY IT MATTERS: recalcAllRollups() opens each unit with
 *   `const parent = u.parent_crm_id; if (!parent) continue;`
 * With every parent null it skips all 332 units and writes nothing — "Recalculated
 * 0 buildings and 0 projects". The Jul 7 spreadsheet's numbers (MYLU: Total 4 /
 * Available 7 / Reserved -3) have been unrepairable ever since, because the
 * repair path had no hierarchy to count through.
 *
 * THE FIX IS CHEAP BECAUSE OF HOW GHL STORES IT: the inspect showed the BUILDING
 * is firstRecordId in BOTH associations — buildings<->units and
 * buildings<->projects. So one read per building yields its units AND its
 * project. 71 reads rebuild the whole graph, not 403.
 *
 * MATCHED BY OBJECT KEY, NOT ASSOCIATION ID: association ids are location data
 * and can be recreated. objectKeyCandidates() already knows every alias for a
 * scope (raw object id, singular, plural), so relations are classified by what
 * they point AT. Direction is not assumed either — whichever end is not this
 * building is treated as the other record.
 */

async function requireAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin")) throw new Error("Forbidden: admin only.");
}

function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase();
}

interface Relation {
  firstObjectKey?: string;
  firstRecordId?: string;
  secondObjectKey?: string;
  secondRecordId?: string;
  associationId?: string;
}

/** Page through every relation on a record. */
async function readAllRelations(
  client: { config: { location_id: string | null }; request: <T>(m: "GET", p: string, o?: unknown) => Promise<{ data: T }> },
  recordId: string,
): Promise<Relation[]> {
  const out: Relation[] = [];
  let skip = 0;
  for (let page = 0; page < 20; page++) {
    const res = await client.request<{ relations?: Relation[]; total?: number }>(
      "GET",
      `/associations/relations/${recordId}`,
      { query: { locationId: String(client.config.location_id), skip, limit: 100 } },
    );
    const rels = Array.isArray(res.data?.relations) ? res.data.relations : [];
    out.push(...rels);
    const total = typeof res.data?.total === "number" ? res.data.total : out.length;
    skip += rels.length;
    if (rels.length === 0 || out.length >= total) break;
  }
  return out;
}

export const inspectHierarchy = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("LOOK") }).parse(d))
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const { objectKeyCandidates } = await import("./kleegr/object-config.server");
    const client = await createCrmClient();
    const locationId = client.config.location_id;

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

    const samples: Record<string, unknown> = {};
    for (const scope of ["project", "building", "unit"] as const) {
      let keys: string[] = [];
      try {
        keys = objectKeyCandidates(client, scope);
      } catch {
        keys = [];
      }
      const { data: row } = await supabaseAdmin
        .from("external_id_map")
        .select("crm_record_id, display_name")
        .eq("scope", scope)
        .limit(1)
        .maybeSingle();
      if (!row?.crm_record_id) {
        samples[scope] = { crmId: null, objectKeys: keys, error: "no record mapped" };
        continue;
      }
      try {
        const res = await client.request<unknown>("GET", `/associations/relations/${row.crm_record_id}`, {
          query: { locationId: String(locationId), skip: 0, limit: 100 },
        });
        samples[scope] = { crmId: row.crm_record_id, displayName: row.display_name, objectKeys: keys, relations: res.data };
      } catch (err) {
        samples[scope] = {
          crmId: row.crm_record_id,
          displayName: row.display_name,
          objectKeys: keys,
          error: err instanceof Error ? err.message.slice(0, 400) : String(err),
        };
      }
    }

    return { locationId, associationDefinitions: defs, associationDefinitionsError: defsError, samples };
  });

/**
 * Walk buildings in chunks; for each, read its relations once and record both
 * directions: which units hang off it, and which project it hangs off.
 */
export const repairHierarchyChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        confirm: z.literal("REPAIR"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(25).default(15),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const { objectKeyCandidates } = await import("./kleegr/object-config.server");
    const client = await createCrmClient();

    const unitKeys = new Set(objectKeyCandidates(client, "unit").map(norm));
    const projectKeys = new Set(objectKeyCandidates(client, "project").map(norm));

    const { data: buildings } = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id, display_name")
      .eq("scope", "building")
      .order("crm_record_id");

    const all = buildings ?? [];
    const slice = all.slice(data.offset, data.offset + data.limit);

    let unitsLinked = 0;
    let buildingsLinked = 0;
    const failures: Array<{ crmId: string; name: string | null; detail: string }> = [];

    for (const b of slice) {
      const buildingId = b.crm_record_id;
      try {
        const rels = await readAllRelations(client as never, buildingId);

        const childUnits: string[] = [];
        let parentProject: string | null = null;

        for (const r of rels) {
          // Whichever end isn't this building is the other record. Direction is
          // read, not assumed.
          let otherKey: string | undefined;
          let otherId: string | undefined;
          if (r.firstRecordId === buildingId) {
            otherKey = r.secondObjectKey;
            otherId = r.secondRecordId;
          } else if (r.secondRecordId === buildingId) {
            otherKey = r.firstObjectKey;
            otherId = r.firstRecordId;
          } else {
            continue;
          }
          if (!otherId || !otherKey) continue;

          if (unitKeys.has(norm(otherKey))) childUnits.push(otherId);
          else if (projectKeys.has(norm(otherKey))) parentProject = otherId;
        }

        // unit -> this building
        for (const unitId of childUnits) {
          const { error } = await supabaseAdmin
            .from("external_id_map")
            .update({ parent_crm_id: buildingId })
            .eq("scope", "unit")
            .eq("crm_record_id", unitId);
          if (!error) unitsLinked++;

          // The mirror needs parentage too: recomputeParents() returns early
          // when both ids are null, so without this every future single-unit
          // release would silently fail to update its building's counts.
          await supabaseAdmin
            .from("unit_state")
            .update({ building_crm_id: buildingId, project_crm_id: parentProject })
            .eq("unit_crm_id", unitId)
            .then(() => undefined, () => undefined);
        }

        // this building -> its project
        if (parentProject) {
          const { error } = await supabaseAdmin
            .from("external_id_map")
            .update({ parent_crm_id: parentProject })
            .eq("scope", "building")
            .eq("crm_record_id", buildingId);
          if (!error) buildingsLinked++;
        }
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const clean = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        failures.push({ crmId: buildingId, name: b.display_name, detail: clean.slice(0, 200) });
      }
    }

    const nextOffset = data.offset + slice.length;
    return {
      processed: slice.length,
      unitsLinked,
      buildingsLinked,
      failures,
      totalBuildings: all.length,
      nextOffset,
      remaining: Math.max(0, all.length - nextOffset),
    };
  });

/** What the graph looks like now — for confirming the repair actually took. */
export const hierarchyCoverage = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("COUNT") }).parse(d))
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const out: Record<string, { total: number; withParent: number }> = {};
    for (const scope of ["project", "building", "unit"] as const) {
      const [{ count: total }, { count: withParent }] = await Promise.all([
        supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", scope),
        supabaseAdmin
          .from("external_id_map")
          .select("crm_record_id", { count: "exact", head: true })
          .eq("scope", scope)
          .not("parent_crm_id", "is", null),
      ]);
      out[scope] = { total: total ?? 0, withParent: withParent ?? 0 };
    }
    return out;
  });
