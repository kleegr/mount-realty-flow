import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * STAGES PROBE.
 *
 * The unit "Stages" field is MULTIPLE_OPTIONS and was writing NOTHING: every
 * other unit field updated but Stages stayed blank. object-config.server.ts
 * special-cases `stages` OUT of array-wrapping, so it has been sending a bare
 * string on PUT - and GHL silently drops it (200, stored nothing).
 *
 * The schema dump also showed the field's options as []. So we do not actually
 * know the valid option VALUES or the accepted payload SHAPE. Guessing wastes
 * runs. Instead this probe writes one real unit several ways, reading the field
 * back after each, and reports which shape (if any) sticks. Whatever wins is
 * the shape the engine and the sweep must use.
 *
 * It restores the unit's original Stages value at the end (best effort).
 */

async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden: importer role required.");
}

function readStage(rec: Record<string, unknown>): unknown {
  const props = (rec.properties ?? rec) as Record<string, unknown>;
  return props?.stages;
}

export const probeStagesField = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        confirm: z.literal("PROBE"),
        // Optional: a specific unit CRM id. If omitted, the first mapped unit is used.
        unitCrmId: z.string().optional(),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const { requestObject } = await import("./kleegr/object-config.server");
    const client = await createCrmClient();
    const locationId = String(client.config.location_id);

    let unitId = data.unitCrmId ?? null;
    if (!unitId) {
      const { data: u } = await supabaseAdmin
        .from("external_id_map")
        .select("crm_record_id")
        .eq("scope", "unit")
        .order("crm_record_id")
        .limit(1)
        .maybeSingle();
      unitId = u?.crm_record_id ?? null;
    }
    if (!unitId) throw new Error("No unit found to probe.");

    // 1) Read the field's real schema, including option values (the earlier dump
    //    showed []; confirm whether options truly exist).
    const schema = await requestObject<{ fields?: Array<Record<string, unknown>> }>(client, "GET", "unit", "", {
      query: { locationId, fetchProperties: "true" },
    });
    const stagesField = (schema.data?.fields ?? []).find(
      (f) => String(f.fieldKey ?? f.key ?? "").replace(/^custom_objects\.[^.]+\./, "") === "stages",
    );
    const rawOptions =
      (stagesField?.picklistOptions ??
        stagesField?.picklistOptionValues ??
        stagesField?.options ??
        stagesField?.picklist) as unknown;

    // Capture original value to restore later.
    const before = await requestObject<Record<string, unknown>>(client, "GET", "unit", `/records/${unitId}`, {
      query: { locationId },
    });
    const originalStage = readStage((before.data ?? {}) as Record<string, unknown>);

    const attempts: Array<{ shape: string; sent: unknown; readBack: unknown; stuck: boolean; error?: string }> = [];

    async function tryShape(shape: string, value: unknown) {
      try {
        await requestObject(client, "PUT", "unit", `/records/${unitId}`, {
          body: { properties: { stages: value } },
        });
        const back = await requestObject<Record<string, unknown>>(client, "GET", "unit", `/records/${unitId}`, {
          query: { locationId },
        });
        const readBack = readStage((back.data ?? {}) as Record<string, unknown>);
        const stuck =
          JSON.stringify(readBack ?? null).toLowerCase().includes("under") ||
          JSON.stringify(readBack ?? null).toLowerCase().includes("contract");
        attempts.push({ shape, sent: value, readBack, stuck });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        attempts.push({ shape, sent: value, readBack: undefined, stuck: false, error: msg.slice(0, 200) });
      }
    }

    // The candidate shapes, in order. Target value "Under Contract" in each guise.
    await tryShape("bare string 'Under Contract'", "Under Contract");
    await tryShape("array ['Under Contract']", ["Under Contract"]);
    await tryShape("underscore key 'under_contract'", "under_contract");
    await tryShape("array underscore ['under_contract']", ["under_contract"]);

    // Restore original (best effort, try both shapes).
    try {
      const restore = originalStage == null || originalStage === "" ? null : originalStage;
      await requestObject(client, "PUT", "unit", `/records/${unitId}`, {
        body: { properties: { stages: restore } },
      });
    } catch {
      /* best effort */
    }

    return {
      unitId,
      stagesFieldRawOptions: rawOptions ?? null,
      stagesFieldSchema: stagesField
        ? { name: stagesField.name, dataType: stagesField.dataType, fieldKey: stagesField.fieldKey }
        : null,
      originalStage,
      attempts,
      winner: attempts.find((a) => a.stuck)?.shape ?? "NONE STUCK - see attempts and rawOptions",
    };
  });
