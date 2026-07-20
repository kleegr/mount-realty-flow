import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * UNDO + AVAILABLE SWEEP + STALE-HOLD CLEAR.
 *
 * WHY. The opportunity import only writes units that got a deal. Blank-STATUS
 * rows correctly produce no deal - but the inventory reset had already CLEARED
 * every unit's status first, so those units are left BLANK, not "Available".
 * "Left over" only equals "Available" if something writes the word. Nothing did.
 *
 * AVAILABLE IS A REAL STAGE (owner decision): the sweep writes BOTH
 * Availability="Available" AND Stage="Available" so a free unit's stage list
 * shows the word instead of sitting empty. The "Available" option must exist
 * on the Stages picklist in GHL - the first write is read back and the run
 * aborts if either value did not land.
 *
 * ORDER. Free holds -> set Available -> recalc. A unit still associated to a
 * live deal would get repainted by the engine, so we only free holds whose deal
 * is verified gone.
 *
 * VERIFY-FIRST. GHL 200s an unknown custom-field payload and silently drops it,
 * and normalizeRecordProperties drops any key not in the live schema. So the
 * FIRST write of each phase is read back, and the run ABORTS if GHL accepted the
 * call but stored nothing.
 *
 * PATHS. requestObject comes from object-config.server (NOT objects.server),
 * and unit records live at /records/{id} - the same path the stage engine uses.
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

export const showUnitFieldResolution = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("LOOK") }).parse(d))
  .handler(async ({ context }) => {
    await requireImporter(context.userId);

    const { createCrmClient } = await import("./kleegr/client.server");
    const { requestObject } = await import("./kleegr/object-config.server");
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
        resolution[`${logical} -> \"${key}\"`] = hit
          ? { writes: true, ghlName: hit.name, dataType: hit.dataType, options: hit.options }
          : { writes: false, WARNING: "KEY NOT IN LIVE SCHEMA - WRITES HERE ARE SILENTLY DROPPED" };
      }

      out[scope] = {
        resolution,
        allLiveKeys: [...live.entries()].map(([k, v]) => ({ key: k, name: v.name, dataType: v.dataType, options: v.options })),
      };
    }

    return out;
  });

// ------------------------------------------------------------- undo (still available)

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

// ------------------------------------------------------------- clear stale holds

/**
 * Free every unit whose held_by_opportunity_id points at a deal that no longer
 * exists in GHL. Needed after deals are deleted DIRECTLY in GHL (not through the
 * undo tool): Supabase still thinks those units are held, so a re-import would
 * skip them with "unit already held". Verifies each holder against the live CRM
 * and clears only the genuinely dead ones - a live deal's hold is kept. A
 * transient read error never frees a unit.
 */
export const clearStaleHolds = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        confirm: z.literal("CLEAR"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(25).default(20),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();

    const { data: heldRows } = await supabaseAdmin
      .from("unit_state")
      .select("unit_crm_id, held_by_opportunity_id")
      .not("held_by_opportunity_id", "is", null)
      .order("unit_crm_id");

    const rows = heldRows ?? [];
    const slice = rows.slice(data.offset, data.offset + data.limit);

    const existence = new Map<string, boolean>();
    const results: Array<{ unit: string; opp: string; ok: boolean; detail: string }> = [];

    for (const row of slice) {
      const oppId = row.held_by_opportunity_id as string;
      const unitId = row.unit_crm_id as string;
      try {
        let exists = existence.get(oppId);
        if (exists === undefined) {
          try {
            await client.request("GET", `/opportunities/${oppId}`, {});
            exists = true;
          } catch (err) {
            const status = (err as { status?: number })?.status;
            if (status === 404 || status === 400) exists = false;
            else throw err;
          }
          existence.set(oppId, exists);
        }

        if (exists) {
          results.push({ unit: unitId, opp: oppId, ok: true, detail: "deal still exists - hold kept" });
          continue;
        }

        await supabaseAdmin
          .from("unit_state")
          .update({ held_by_opportunity_id: null, status: null, stage: "" })
          .eq("unit_crm_id", unitId);
        results.push({ unit: unitId, opp: oppId, ok: true, detail: "deal gone - hold cleared" });
      } catch (err) {
        results.push({ unit: unitId, opp: oppId, ok: false, detail: shortErr(err) });
      }
    }

    const nextOffset = data.offset + slice.length;
    const cleared = results.filter((r) => r.detail.includes("cleared")).length;
    const kept = results.filter((r) => r.detail.includes("kept")).length;
    return {
      totalHeld: rows.length,
      processed: slice.length,
      cleared,
      kept,
      failed: results.filter((r) => !r.ok),
      results,
      nextOffset,
      remaining: Math.max(0, rows.length - nextOffset),
    };
  });

// ------------------------------------------------------------- available sweep

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
    const { requestObject, normalizeRecordProperties } = await import("./kleegr/object-config.server");
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
        // Availability AND Stage both say "Available" (owner decision). The
        // stage goes through normalizeRecordProperties so a MULTIPLE_OPTIONS
        // picklist gets the list shape it demands.
        const props = (await normalizeRecordProperties(
          client,
          "unit",
          {
            [FIELDS.unit.availability]: "Available",
            [FIELDS.unit.inventory_deducted]: "No",
            [FIELDS.unit.stage]: "Available",
          },
          { forUpdate: true },
        )) as Record<string, unknown>;

        await requestObject(client, "PUT", "unit", `/records/${u.crm_record_id}`, {
          body: { properties: props },
        });

        if (!verified) {
          const back = await requestObject<Record<string, unknown>>(
            client,
            "GET",
            "unit",
            `/records/${u.crm_record_id}`,
            { query: { locationId: String(locationId) } },
          );
          const b = (back.data ?? {}) as Record<string, unknown>;
          const rec = (b.record && typeof b.record === "object" ? b.record : b) as Record<string, unknown>;
          const p = (rec.properties ?? {}) as Record<string, unknown>;
          const gotAvail = String(p[FIELDS.unit.availability] ?? "");
          const gotStage = String(p[FIELDS.unit.stage] ?? "");
          if (!/available/i.test(gotAvail)) {
            throw new Error(
              `ABORTED AFTER ONE UNIT. Sent availability=\"Available\" to key \"${FIELDS.unit.availability}\"; ` +
                `GHL returned 200 but read back \"${gotAvail}\". The key is wrong or \"Available\" is not a valid option. ` +
                `Run \"Show unit field resolution\" to see the real key. Read back: ${JSON.stringify(p).slice(0, 300)}`,
            );
          }
          if (!/available/i.test(gotStage)) {
            throw new Error(
              `ABORTED AFTER ONE UNIT. Sent Stage=\"Available\" to key \"${FIELDS.unit.stage}\"; ` +
                `GHL returned 200 but read back \"${gotStage}\". ` +
                `Most likely \"Available\" is missing from the Stages picklist options in GHL - add it, then run again. ` +
                `Read back: ${JSON.stringify(p).slice(0, 300)}`,
            );
          }
          verified = true;
        }

        await supabaseAdmin
          .from("unit_state")
          .upsert(
            {
              unit_crm_id: u.crm_record_id,
              status: "available",
              availability: "Available",
              stage: "Available",
              held_by_opportunity_id: null,
            },
            { onConflict: "unit_crm_id" },
          );

        results.push({ unit: label, ok: true, detail: "Available (availability + stage)" });
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

/** Rebuild building + project rollups from real unit state. Kills the negative counts. */
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
