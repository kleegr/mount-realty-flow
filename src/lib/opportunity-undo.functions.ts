import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * UNDO + AVAILABLE SWEEP.
 *
 * WHY. The opportunity import only writes units that got a deal. The 181
 * blank-STATUS rows correctly produce no deal — but the inventory reset had
 * already CLEARED every unit's status first, so those units are left BLANK, not
 * "Available". "Left over" only equals "Available" if something writes the word.
 * Nothing did. That was a design gap, not a CRM bug.
 *
 * ORDER MATTERS. Delete the deals FIRST, then sweep. A unit still associated to
 * a live deal would get repainted by the engine on the next webhook, so freeing
 * it before the deal is gone just produces a race.
 *
 * VERIFY-FIRST. GHL 200s an unknown custom-field payload and silently drops it,
 * and normalizeRecordProperties drops any key not in the live schema. So the
 * FIRST write of each phase is read back, and the run ABORTS if GHL accepted the
 * call but stored nothing. Better to fail on unit 1 than to report "332 units
 * set" over a no-op — which is exactly how Stages ended up empty.
 */

async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden: importer role required.");
}

function shortErr(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
  return m.slice(0, 240);
}

// ------------------------------------------------------------- field resolution

/**
 * Dump how each unit field key resolves against the LIVE schema. A key the
 * schema doesn't know is silently dropped, so a wrong key looks like success
 * forever. This settles the "Stages is empty" question with evidence.
 */
export const showUnitFieldResolution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("LOOK") }).parse(d))
  .handler(async ({ context }) => {
    await requireImporter(context.userId);

    const { createCrmClient } = await import("./kleegr/client.server");
    const { requestObject } = await import("./kleegr/objects.server");
    const { FIELDS } = await import("./kleegr/field-map");
    const client = await createCrmClient();
    const locationId = client.config.location_id;

    const out: Record<string, unknown> = {};

    for (const scope of ["unit", "building"] as const) {
      const res = await requestObject<{ fields?: Array<Record<string, unknown>> }>(client, "GET", scope, "", {
        query: { locationId: String(locationId), fetchProperties: "true" },
      });

      const live = new Map<string, { name: string; dataType: string; options: string[] }>();
      for (const f of res.data?.fields ?? []) {
        const key = String(f.fieldKey ?? f.key ?? "").replace(/^custom_objects\.[^.]+\./, "");
        if (!key) continue;
        const raw = (f.picklistOptions ?? f.picklistOptionValues ?? f.options) as unknown;
        const options = Array.isArray(raw)
          ? raw
              .map((o) =>
                typeof o === "string" ? o : ((o as Record<string, unknown>)?.value ?? (o as Record<string, unknown>)?.name),
              )
              .filter((v): v is string => typeof v === "string")
          : [];
        live.set(key, { name: String(f.name ?? ""), dataType: String(f.dataType ?? ""), options });
      }

      const resolution: Record<string, unknown> = {};
      const map = (FIELDS as Record<string, Record<string, string>>)[scope] ?? {};
      for (const [logical, key] of Object.entries(map)) {
        const hit = live.get(key);
        resolution[`${logical} -> "${key}"`] = hit
          ? { writes: true, ghlName: hit.name, dataType: hit.dataType, options: hit.options }
          : { writes: false, WARNING: "KEY NOT IN LIVE SCHEMA — WRITES HERE ARE SILENTLY DROPPED" };
      }

      out[scope] = {
        resolution,
        allLiveKeys: [...live.entries()].map(([k, v]) => ({ key: k, name: v.name, dataType: v.dataType, options: v.options })),
      };
    }

    return out;
  });

// ------------------------------------------------------------- undo

export const previewUndo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("LOOK") }).parse(d))
  .handler(async ({ context }) => {
    await requireImporter(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();
    const locationId = client.config.location_id;

    const { data: rules } = await supabaseAdmin.from("crm_pipelines").select("pipeline_id, pipeline_name");

    const pipelines: Array<{ id: string; name: string; deals: number; governed: boolean }> = [];
    const res = await client.request<{ pipelines?: Array<Record<string, unknown>> }>("GET", "/opportunities/pipelines", {
      query: { locationId: String(locationId) },
    });
    const governed = new Set((rules ?? []).map((r) => r.pipeline_id).filter(Boolean));

    for (const p of res.data?.pipelines ?? []) {
      const id = typeof p.id === "string" ? p.id : "";
      if (!id) continue;
      let deals = 0;
      try {
        const c = await client.request<{ meta?: { total?: number }; total?: number }>("GET", "/opportunities/search", {
          query: { location_id: String(locationId), pipeline_id: id, limit: 1 },
        });
        deals = c.data?.meta?.total ?? c.data?.total ?? 0;
      } catch {
        deals = 0;
      }
      pipelines.push({ id, name: String(p.name ?? "(unnamed)"), deals, governed: governed.has(id) });
    }

    const { count: heldUnits } = await supabaseAdmin
      .from("unit_state")
      .select("unit_crm_id", { count: "exact", head: true })
      .not("held_by_opportunity_id", "is", null);

    const { count: totalUnits } = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id", { count: "exact", head: true })
      .eq("scope", "unit");

    return { pipelines, heldUnits: heldUnits ?? 0, totalUnits: totalUnits ?? 0 };
  });

/**
 * Delete every opportunity in the given pipeline. Associations go with the deal.
 */
export const undoOpportunities = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        confirm: z.literal("DELETE"),
        pipelineId: z.string().min(1),
        limit: z.number().int().min(1).max(25).default(15),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();
    const locationId = client.config.location_id;

    // Always read page 1: deleting shrinks the list, so paging by offset would
    // skip records. Caller loops until remaining hits 0.
    const search = await client.request<{
      opportunities?: Array<Record<string, unknown>>;
      meta?: { total?: number };
      total?: number;
    }>("GET", "/opportunities/search", {
      query: { location_id: String(locationId), pipeline_id: data.pipelineId, limit: data.limit },
    });

    const list = Array.isArray(search.data?.opportunities) ? search.data.opportunities : [];
    const before = search.data?.meta?.total ?? search.data?.total ?? list.length;

    const results: Array<{ id: string; name: string; ok: boolean; detail: string }> = [];

    for (const o of list) {
      const id = typeof o.id === "string" ? o.id : "";
      const name = String(o.name ?? "(unnamed)");
      if (!id) continue;
      try {
        await client.request("DELETE", `/opportunities/${id}`);
        await supabaseAdmin
          .from("unit_state")
          .update({ held_by_opportunity_id: null, status: null })
          .eq("held_by_opportunity_id", id);
        results.push({ id, name, ok: true, detail: "deleted" });
      } catch (err) {
        results.push({ id, name, ok: false, detail: shortErr(err) });
      }
    }

    const deleted = results.filter((r) => r.ok).length;
    return {
      processed: results.length,
      deleted,
      failed: results.filter((r) => !r.ok),
      results,
      remaining: Math.max(0, before - deleted),
    };
  });

// ------------------------------------------------------------- available sweep

/**
 * Set every UNHELD unit to Available. Held units are never touched — the lock is
 * the on switch, so a held unit's status belongs to its deal.
 */
export const sweepAvailableUnits = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        confirm: z.literal("SWEEP"),
        dryRun: z.boolean().default(true),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(25).default(15),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const { requestObject } = await import("./kleegr/objects.server");
    const { normalizeRecordProperties } = await import("./kleegr/object-config.server");
    const { FIELDS } = await import("./kleegr/field-map");
    const client = await createCrmClient();
    const locationId = client.config.location_id;

    const { data: units } = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id, display_name")
      .eq("scope", "unit")
      .order("crm_record_id");

    const { data: held } = await supabaseAdmin
      .from("unit_state")
      .select("unit_crm_id")
      .not("held_by_opportunity_id", "is", null);
    const heldIds = new Set((held ?? []).map((h) => h.unit_crm_id));

    const free = (units ?? []).filter((u) => !heldIds.has(u.crm_record_id));

    if (data.dryRun) {
      return {
        dryRun: true,
        totalUnits: units?.length ?? 0,
        heldByDeal: heldIds.size,
        wouldSetAvailable: free.length,
        sample: free.slice(0, 15).map((u) => u.display_name),
        processed: 0,
        succeeded: 0,
        failed: [] as Array<{ unit: string; detail: string }>,
        results: [] as Array<{ unit: string; ok: boolean; detail: string }>,
        nextOffset: 0,
        remaining: free.length,
      };
    }

    const slice = free.slice(data.offset, data.offset + data.limit);
    const results: Array<{ unit: string; ok: boolean; detail: string }> = [];
    let verified = data.offset > 0;

    for (const u of slice) {
      const label = u.display_name ?? u.crm_record_id;
      try {
        const props = (await normalizeRecordProperties(
          client,
          "unit",
          {
            [FIELDS.unit.availability]: "Available",
            [FIELDS.unit.inventory_deducted]: "No",
          },
          { forUpdate: true },
        )) as Record<string, unknown>;

        // Stage has no "Available" value — Available IS the stage cleared. An
        // explicit null clears it, appended AFTER normalisation because
        // stripEmpty() drops nulls.
        props[FIELDS.unit.stage] = null;

        await requestObject(client, "PUT", "unit", `/${u.crm_record_id}`, {
          body: { locationId, properties: props },
        });

        if (!verified) {
          const back = await requestObject<Record<string, unknown>>(client, "GET", "unit", `/${u.crm_record_id}`, {
            query: { locationId: String(locationId) },
          });
          const b = (back.data ?? {}) as Record<string, unknown>;
          const rec = (b.record && typeof b.record === "object" ? b.record : b) as Record<string, unknown>;
          const p = (rec.properties ?? {}) as Record<string, unknown>;
          const got = String(p[FIELDS.unit.availability] ?? "");
          if (!/available/i.test(got)) {
            throw new Error(
              `ABORTED AFTER ONE UNIT. Sent availability="Available" to key "${FIELDS.unit.availability}"; ` +
                `GHL returned 200 but read back "${got}". The key is wrong or "Available" is not a valid option. ` +
                `Run "Show field resolution" to see the real key. Read back: ${JSON.stringify(p).slice(0, 300)}`,
            );
          }
          verified = true;
        }

        await supabaseAdmin
          .from("unit_state")
          .upsert(
            { unit_crm_id: u.crm_record_id, status: "available", held_by_opportunity_id: null },
            { onConflict: "unit_crm_id" },
          );

        results.push({ unit: label, ok: true, detail: "Available" });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        results.push({ unit: label, ok: false, detail: shortErr(err) });
        if (/ABORTED AFTER ONE UNIT/.test(raw)) break;
      }
    }

    const nextOffset = data.offset + slice.length;
    return {
      dryRun: false,
      totalUnits: units?.length ?? 0,
      heldByDeal: heldIds.size,
      wouldSetAvailable: free.length,
      sample: [] as string[],
      processed: slice.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).map((r) => ({ unit: r.unit, detail: r.detail })),
      results,
      nextOffset,
      remaining: Math.max(0, free.length - nextOffset),
    };
  });

/** Rebuild building + project rollups from real unit state. Kills the −1s. */
export const recalcAll = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("RECALC") }).parse(d))
  .handler(async ({ context }) => {
    await requireImporter(context.userId);
    const { createCrmClient } = await import("./kleegr/client.server");
    const { recalcAllRollups } = await import("./kleegr/rollups.server");
    const client = await createCrmClient();
    return await recalcAllRollups(client);
  });
