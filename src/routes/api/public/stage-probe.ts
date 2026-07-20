/**
 * TEMPORARY diagnostic endpoint - DELETE AFTER USE.
 * Empirically discovers which value GHL's option matcher accepts for the
 * unit "stages" picklist by writing candidate values to ONE unit and reading
 * each back. Restores the original value at the end. Results are returned in
 * the response AND stored in audit_events (kind 'stage_probe') so they
 * survive even if the HTTP caller times out.
 * Auth: ?token=<PROBE_TOKEN> (single-purpose random string).
 */
import { createFileRoute } from "@tanstack/react-router";

const PROBE_TOKEN = "kp9X2vQ7mL4tR8wZ3nB6yD1cF5hJ0aSg";

export const Route = createFileRoute("/api/public/stage-probe")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("token") !== PROBE_TOKEN) {
          return json({ error: "forbidden" }, 403);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
        const { createCrmClient } = await import("@/lib/kleegr/client.server");
        const { requestObject } = await import("@/lib/kleegr/object-config.server");
        const client = await createCrmClient();
        const locationId = String(client.config.location_id ?? "");

        const result: Record<string, unknown> = { startedAt: new Date().toISOString() };

        try {
          // 1) Full live schema for the stages field, every option container.
          const schema = await requestObject<{ fields?: Array<Record<string, unknown>> }>(client, "GET", "unit", "", {
            query: { locationId, fetchProperties: "true" },
          });
          const stagesField = (schema.data?.fields ?? []).find(
            (f) => String(f.fieldKey ?? f.key ?? "").replace(/^custom_objects\.[^.]+\./, "") === "stages",
          );
          const containers: Record<string, unknown> = {};
          if (stagesField) {
            for (const c of ["picklistOptions", "picklistOptionValues", "options", "picklist"]) {
              if (c in stagesField) containers[c] = (stagesField as Record<string, unknown>)[c];
            }
          }
          result.stagesField = stagesField
            ? { name: stagesField.name, dataType: stagesField.dataType, fieldKey: stagesField.fieldKey, containers }
            : "NOT FOUND";

          const optionObjects: Array<Record<string, unknown>> = [];
          for (const c of Object.values(containers)) {
            if (!Array.isArray(c)) continue;
            for (const o of c) {
              if (o && typeof o === "object") optionObjects.push(o as Record<string, unknown>);
              else if (typeof o === "string") optionObjects.push({ _string: o });
            }
          }
          result.optionObjects = optionObjects;

          // 2) Probe unit = first mapped unit (the same one the sweep hits first).
          const { data: u } = await supabaseAdmin
            .from("external_id_map")
            .select("crm_record_id, display_name")
            .eq("scope", "unit")
            .order("crm_record_id")
            .limit(1)
            .maybeSingle();
          if (!u?.crm_record_id) throw new Error("no unit to probe");
          const unitId = u.crm_record_id;
          result.unit = { id: unitId, name: u.display_name };

          const readStage = async (): Promise<unknown> => {
            const back = await requestObject<Record<string, unknown>>(client, "GET", "unit", `/records/${unitId}`, {
              query: { locationId },
            });
            const b = (back.data ?? {}) as Record<string, unknown>;
            const rec = (b.record && typeof b.record === "object" ? b.record : b) as Record<string, unknown>;
            return ((rec.properties ?? {}) as Record<string, unknown>).stages;
          };

          const original = await readStage();
          result.original = original ?? null;

          // 3) Candidates: every string property of the Available option, the
          //    obvious literals, one array shape, and calibration writes using
          //    the original options' keys and labels to learn the matcher rule.
          const isAvail = (o: Record<string, unknown>) =>
            Object.values(o).some((v) => typeof v === "string" && /available/i.test(v));
          const availOpt = optionObjects.find(isAvail) ?? null;
          result.availableOption = availOpt ?? "NOT IN API SCHEMA";

          const seen = new Set<string>();
          const candidates: Array<{ from: string; value: unknown }> = [];
          const add = (from: string, value: unknown) => {
            const sig = JSON.stringify(value);
            if (seen.has(sig)) return;
            seen.add(sig);
            candidates.push({ from, value });
          };
          if (availOpt) {
            for (const [k, v] of Object.entries(availOpt)) {
              if (typeof v === "string" && v.trim()) add(`available.${k}`, v);
            }
          }
          add("literal label", "Available");
          add("lowercase", "available");
          add("uppercase", "AVAILABLE");
          const availLabel = availOpt && typeof availOpt.label === "string" ? availOpt.label : "Available";
          add("array label", [availLabel]);
          for (const o of optionObjects) {
            if (o === availOpt) continue;
            if (typeof o.key === "string" && o.key.trim()) add(`calib key ${o.key}`, o.key);
            if (typeof o.label === "string" && o.label.trim()) add(`calib label ${o.label}`, o.label);
          }

          // 4) Write each candidate, read back after each.
          const attempts: Array<Record<string, unknown>> = [];
          for (const cand of candidates) {
            try {
              await requestObject(client, "PUT", "unit", `/records/${unitId}`, {
                body: { properties: { stages: cand.value } },
              });
              const back = await readStage();
              const stuck = back != null && back !== "" && JSON.stringify(back) !== "[]";
              attempts.push({ from: cand.from, sent: cand.value, readBack: back ?? null, stuck });
            } catch (err) {
              attempts.push({
                from: cand.from,
                sent: cand.value,
                error: (err instanceof Error ? err.message : String(err)).slice(0, 180),
                stuck: false,
              });
            }
          }
          result.attempts = attempts;
          result.winners = attempts.filter((a) => a.stuck === true);

          // 5) Restore the original value.
          try {
            await requestObject(client, "PUT", "unit", `/records/${unitId}`, {
              body: { properties: { stages: original == null || original === "" ? null : original } },
            });
            result.restored = true;
          } catch (err) {
            result.restored = (err instanceof Error ? err.message : String(err)).slice(0, 180);
          }
        } catch (err) {
          result.error = (err instanceof Error ? err.message : String(err)).slice(0, 400);
        }

        result.finishedAt = new Date().toISOString();

        try {
          await supabaseAdmin.from("audit_events").insert({
            kind: "stage_probe",
            reason: "temporary stages picklist probe",
            next: result as never,
          });
        } catch {
          /* best effort */
        }

        return json(result);
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), { status, headers: { "Content-Type": "application/json" } });
}
