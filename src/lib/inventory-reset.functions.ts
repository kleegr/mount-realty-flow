import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * INVENTORY RESET — put every unit back to Available, then let the deals repaint it.
 *
 * WHY THIS EXISTS: the Building/Project counts still hold values the Jul 7
 * spreadsheet wrote DIRECTLY, back when count columns were still importable
 * (MYLU: Total 4 / Available 7 / Reserved -3). Nothing has recomputed them
 * since, because recalcAllRollups() counts units via unit_state — and unit_state
 * had 8 rows for 332 units. A unit with no mirrored row classifies as
 * `unclassified`, and unclassified is never written to GHL, so a recalc would
 * have pushed available: 0 to all 71 buildings. This seeds the mirror properly
 * so the recount is both possible and correct.
 *
 * SAFE ONLY BECAUSE THE PIPELINES ARE EMPTY. Unit status is derived from
 * opportunity position — with deals present, selfHealCrmState() would re-apply
 * their stages within ~2 minutes and quietly undo this. With zero opportunities
 * there is nothing to re-apply, so Available is a stable resting state.
 *
 * WHY NOT JUST CALL releaseUnit() 332 TIMES: it calls recomputeParents() per
 * unit, which is right for one webhook and catastrophic for a bulk pass — 332
 * units would fire ~1,000 CRM writes and blow the serverless timeout. The GHL
 * write shape below is copied from it exactly (same fields, same explicit
 * nulls, same forUpdate); only the rollup is deferred to one pass at the end.
 *
 * ALSO BACKFILLS PARENTAGE: unit_state.building_crm_id / project_crm_id are
 * populated from external_id_map. recomputeParents() returns early when both
 * are null — so without this, every FUTURE single-unit release would silently
 * fail to update its building's counts.
 *
 * Resumable by offset. Nothing here deletes a record.
 */

async function roles(userId: string): Promise<string[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  return (data ?? []).map((r) => r.role);
}

async function requireAdmin(userId: string) {
  const r = await roles(userId);
  if (!r.includes("admin")) throw new Error("Forbidden: admin only.");
}

export const resetInventoryChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        confirm: z.literal("RESET"),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(40).default(25),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireAdmin(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const { FIELDS } = await import("./kleegr/field-map");
    const { normalizeRecordProperties, requestObject } = await import("./kleegr/object-config.server");

    const client = await createCrmClient();

    // Guard: this is only safe while no deal can re-apply a stage.
    const { count: heldCount } = await supabaseAdmin
      .from("unit_state")
      .select("unit_crm_id", { count: "exact", head: true })
      .not("held_by_opportunity_id", "is", null);
    if ((heldCount ?? 0) > 0) {
      throw new Error(
        `${heldCount} units are still recorded as held by an opportunity. Self-heal would undo this reset within ~2 minutes. Resolve those first.`,
      );
    }

    const [unitsRes, buildingsRes] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id, parent_crm_id").eq("scope", "unit").order("crm_record_id"),
      supabaseAdmin.from("external_id_map").select("crm_record_id, parent_crm_id").eq("scope", "building"),
    ]);

    const buildingParent = new Map<string, string | null>();
    for (const b of buildingsRes.data ?? []) buildingParent.set(b.crm_record_id, b.parent_crm_id);

    const all = unitsRes.data ?? [];
    const slice = all.slice(data.offset, data.offset + data.limit);

    const results: Array<{ unitCrmId: string; ok: boolean; detail: string }> = [];

    for (const u of slice) {
      const unitCrmId = u.crm_record_id;
      const buildingCrmId = u.parent_crm_id ?? null;
      const projectCrmId = buildingCrmId ? (buildingParent.get(buildingCrmId) ?? null) : null;

      try {
        // Exactly releaseUnit()'s GHL write. normalizeRecordProperties strips
        // ""/null, so cleared fields are appended as explicit nulls AFTER
        // normalisation — GHL accepts those and they are what actually clear
        // the field. forUpdate: true because PUT rejects the array shape POST
        // accepts, and a 422 here would leave the unit silently unchanged.
        const setProps = await normalizeRecordProperties(
          client,
          "unit",
          {
            [FIELDS.unit.availability]: "Available",
            [FIELDS.unit.inventory_deducted]: "No",
          },
          { forUpdate: true },
        );
        const clearProps = {
          ...setProps,
          [FIELDS.unit.stage]: null,
          [FIELDS.unit.locked_date]: null,
        };

        await requestObject(client, "PUT", "unit", `/records/${unitCrmId}`, { body: { properties: clearProps } });

        const { error: upErr } = await supabaseAdmin.from("unit_state").upsert(
          {
            unit_crm_id: unitCrmId,
            availability: "Available",
            stage: "",
            held_by_opportunity_id: null,
            building_crm_id: buildingCrmId,
            project_crm_id: projectCrmId,
          },
          { onConflict: "unit_crm_id" },
        );
        if (upErr) throw new Error(`mirror upsert failed: ${upErr.message}`);

        results.push({ unitCrmId, ok: true, detail: "available" });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const clean = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        results.push({ unitCrmId, ok: false, detail: clean.slice(0, 200) });
      }
    }

    const nextOffset = data.offset + slice.length;
    return {
      processed: slice.length,
      succeeded: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok),
      totalUnits: all.length,
      nextOffset,
      remaining: Math.max(0, all.length - nextOffset),
    };
  });

/**
 * One rollup pass over every Building and Project, after the units are seeded.
 * Deferred to the end on purpose: doing it per-unit is ~1,000 writes.
 */
export const finalizeInventoryReset = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("RECALC") }).parse(d))
  .handler(async ({ context }) => {
    await requireAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { recalcAllRollups } = await import("./kleegr/rollups.server");

    const res = await recalcAllRollups();

    await supabaseAdmin
      .from("audit_events")
      .insert({
        kind: "inventory_reset_recalc",
        reason: `buildings ${res.buildings}, projects ${res.projects}, failed ${res.failed.length}`,
      })
      .then(() => undefined, () => undefined);

    return res;
  });
