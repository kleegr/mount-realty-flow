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
 * recalcAllRollups() opens each unit with `if (!parent) continue;`, so with every
 * parent null it skipped all 332 units and wrote nothing.
 *
 * THE FIX IS CHEAP BECAUSE OF HOW GHL STORES IT: the BUILDING is firstRecordId in
 * BOTH associations — buildings<->units and buildings<->projects. One read per
 * building yields its units AND its project. 71 reads rebuild the graph, not 403.
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

/**
 * WHICH FIELD AM I ACTUALLY WRITING?
 *
 * normalizeRecordProperties() resolves a property key against the live object
 * schema and SILENTLY DROPS anything it cannot match:
 *
 *   if (!schemaTypeMap.has(prop)) continue;
 *
 * So a field-map key that doesn't correspond to a real GHL field writes nothing,
 * with no error — indistinguishable from a value that happened to already be
 * correct. With three "Reserved" columns in the Buildings view, "it shows 0" is
 * not evidence that we wrote the 0.
 *
 * This dumps every field on each object with its key, and marks which one each
 * FIELDS entry resolves to — matching by the same rule the normalizer uses
 * (field.name, field.fieldKey, or the tail after the last dot).
 */
export const inspectSchema = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("LOOK") }).parse(d))
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);

    const { createCrmClient } = await import("./kleegr/client.server");
    const { requestObject } = await import("./kleegr/object-config.server");
    const { FIELDS } = await import("./kleegr/field-map");
    const client = await createCrmClient();
    const locationId = client.config.location_id;

    const out: Record<string, unknown> = {};

    for (const scope of ["building", "project", "unit"] as const) {
      try {
        const res = await requestObject<{ fields?: Array<Record<string, unknown>> }>(client, "GET", scope, "", {
          query: { locationId: String(locationId), fetchProperties: "true" },
        });
        const fields = Array.isArray(res.data?.fields) ? res.data.fields : [];

        // Same key resolution the normalizer performs.
        const keysFor = (f: Record<string, unknown>): string[] => {
          const keys: string[] = [];
          if (typeof f.name === "string" && f.name) keys.push(f.name);
          if (typeof f.fieldKey === "string" && f.fieldKey) {
            keys.push(f.fieldKey);
            const tail = f.fieldKey.split(".").pop();
            if (tail) keys.push(tail);
          }
          return keys;
        };

        const allFields = fields.map((f) => ({
          name: f.name ?? null,
          fieldKey: f.fieldKey ?? null,
          dataType: f.dataType ?? f.type ?? null,
          options: Array.isArray(f.options)
            ? (f.options as Array<Record<string, unknown>>).map((o) => o.key ?? o.label ?? null)
            : undefined,
        }));

        // Does each FIELDS entry for this scope resolve to a real field?
        const mapping = FIELDS[scope] as Record<string, string>;
        const resolution: Record<string, { writes: boolean; matchedField: string | null; dataType: string | null }> = {};
        for (const [logical, key] of Object.entries(mapping)) {
          const hit = fields.find((f) => keysFor(f).includes(key));
          resolution[`${logical} -> "${key}"`] = {
            writes: Boolean(hit),
            matchedField: hit ? String(hit.name ?? hit.fieldKey ?? "?") : null,
            dataType: hit ? String(hit.dataType ?? hit.type ?? "?") : null,
          };
        }

        out[scope] = { fieldCount: fields.length, resolution, allFields };
      } catch (err) {
        out[scope] = { error: err instanceof Error ? err.message.slice(0, 400) : String(err) };
      }
    }

    return out;
  });

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

        for (const unitId of childUnits) {
          const { error } = await supabaseAdmin
            .from("external_id_map")
            .update({ parent_crm_id: buildingId })
            .eq("scope", "unit")
            .eq("crm_record_id", unitId);
          if (!error) unitsLinked++;

          await supabaseAdmin
            .from("unit_state")
            .update({ building_crm_id: buildingId, project_crm_id: parentProject })
            .eq("unit_crm_id", unitId)
            .then(() => undefined, () => undefined);
        }

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
