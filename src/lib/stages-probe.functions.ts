import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * STAGES PROBE v3.
 *
 * Rounds 1-2 proved: for `stages` on PUT, EVERY structured shape 422s
 * ("unexpected format") and EVERY bare string is accepted-and-dropped,
 * including the exact Value string from the field settings (`under_contract`).
 *
 * Silent-accept-then-drop (not 422) means the value reaches the option matcher
 * and fails to match. So the string GHL matches on is probably NOT the "Value"
 * column shown in the UI - custom-object option pickers frequently key on an
 * internal option id. This round does two things:
 *
 *   1. DUMP the raw option objects for `stages` with ALL their properties, so
 *      we can see the real id/value/key the writer must send.
 *   2. Try writing each option's every string-ish property as a bare value,
 *      reading back after each, to discover empirically which string sticks.
 *
 * Restores original at the end (best effort).
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

    // 1) Full raw schema for the stages field - every property on every option.
    const schema = await requestObject<{ fields?: Array<Record<string, unknown>> }>(client, "GET", "unit", "", {
      query: { locationId, fetchProperties: "true" },
    });
    const stagesField = (schema.data?.fields ?? []).find(
      (f) => String(f.fieldKey ?? f.key ?? "").replace(/^custom_objects\.[^.]+\./, "") === "stages",
    );

    // Collect every option object exactly as GHL returns it.
    const rawOptionContainers = [
      stagesField?.picklistOptions,
      stagesField?.picklistOptionValues,
      stagesField?.options,
      stagesField?.picklist,
    ].filter(Boolean);
    const optionObjects: Array<Record<string, unknown>> = [];
    for (const container of rawOptionContainers) {
      if (Array.isArray(container)) {
        for (const o of container) {
          if (o && typeof o === "object") optionObjects.push(o as Record<string, unknown>);
          else if (typeof o === "string") optionObjects.push({ _stringOption: o });
        }
      }
    }

    // Find the option that represents "Under Contract".
    const uc = optionObjects.find((o) =>
      Object.values(o).some((v) => typeof v === "string" && /under.?contract/i.test(v)),
    );

    // Every distinct string value across that option's properties = write candidates.
    const candidates: Array<{ from: string; value: string }> = [];
    if (uc) {
      for (const [k, v] of Object.entries(uc)) {
        if (typeof v === "string" && v.trim()) candidates.push({ from: k, value: v });
      }
    }

    const before = await requestObject<Record<string, unknown>>(client, "GET", "unit", `/records/${unitId}`, {
      query: { locationId },
    });
    const originalStage = readStage((before.data ?? {}) as Record<string, unknown>);

    const attempts: Array<{ from: string; sent: unknown; readBack: unknown; stuck: boolean; error?: string }> = [];

    async function tryValue(from: string, value: unknown) {
      try {
        await requestObject(client, "PUT", "unit", `/records/${unitId}`, {
          body: { properties: { stages: value } },
        });
        const back = await requestObject<Record<string, unknown>>(client, "GET", "unit", `/records/${unitId}`, {
          query: { locationId },
        });
        const readBack = readStage((back.data ?? {}) as Record<string, unknown>);
        const stuck = readBack != null && JSON.stringify(readBack) !== "\"\"" && JSON.stringify(readBack) !== "[]";
        attempts.push({ from, sent: value, readBack, stuck });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        attempts.push({ from, sent: value, readBack: undefined, stuck: false, error: msg.slice(0, 200) });
      }
    }

    // Try each candidate string as a bare value AND array-wrapped.
    for (const cand of candidates) {
      await tryValue(`${cand.from} (bare)`, cand.value);
      await tryValue(`${cand.from} (array)`, [cand.value]);
    }

    // Restore.
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
      stagesFieldSchema: stagesField
        ? {
            name: stagesField.name,
            dataType: stagesField.dataType,
            fieldKey: stagesField.fieldKey,
            allFieldProps: Object.keys(stagesField),
          }
        : null,
      underContractOption: uc ?? "NOT FOUND",
      allOptionObjects: optionObjects,
      candidatesTried: candidates,
      originalStage,
      attempts,
      winner: attempts.find((a) => a.stuck) ?? "STILL NONE - send allOptionObjects, that has the real shape",
    };
  });
