import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * STAGES PROBE v2.
 *
 * Round 1 established: options DO exist, with INCONSISTENT keys -
 *   reservedlocked | under_contract | closedsold
 * and:
 *   - array shapes -> 422 "unexpected format" (PUT rejects arrays, as with
 *     property_type)
 *   - bare string, whether label "Under Contract" or key "under_contract"
 *     -> accepted with no error but STORED NOTHING.
 *
 * So GHL wants neither a scalar nor an array. This round tests the remaining
 * candidate shapes for a MULTIPLE_OPTIONS field on PUT: the object/map form and
 * the comma-joined form, using the EXACT option keys from the schema. Whatever
 * reads back non-empty is the shape the engine and sweep must send.
 *
 * Restores the original value at the end (best effort).
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

function stuckOn(readBack: unknown): boolean {
  const s = JSON.stringify(readBack ?? null).toLowerCase();
  return s.includes("under") || s.includes("contract");
}

export const probeStagesField = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ confirm: z.literal("PROBE"), unitCrmId: z.string().optional() }).parse(d),
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
        attempts.push({ shape, sent: value, readBack, stuck: stuckOn(readBack) });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        attempts.push({ shape, sent: value, readBack: undefined, stuck: false, error: msg.slice(0, 200) });
      }
    }

    // The exact key for "Under Contract" from round 1.
    const KEY = "under_contract";

    // Remaining candidate shapes for MULTIPLE_OPTIONS on PUT.
    await tryShape("object map { key: true }", { [KEY]: true });
    await tryShape("comma-joined keys", KEY);
    await tryShape("value wrapper { value: [key] }", { value: [KEY] });
    await tryShape("value wrapper { value: key }", { value: KEY });
    await tryShape("options wrapper { options: [key] }", { options: [KEY] });
    await tryShape("selected wrapper { selected: [key] }", { selected: [KEY] });
    await tryShape("label as array ['Under Contract'] via key form", { [KEY]: "Under Contract" });

    // Restore original (best effort).
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
      keyUsed: KEY,
      originalStage,
      attempts,
      winner: attempts.find((a) => a.stuck)?.shape ?? "STILL NONE - send this whole result",
    };
  });
