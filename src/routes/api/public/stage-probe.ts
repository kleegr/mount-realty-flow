/**
 * TEMPORARY diagnostic endpoint - DELETE AFTER USE. Round 4: THE FIX.
 * Rounds 1-3 proved: GHL's records API cannot SET a MULTIPLE_OPTIONS field on
 * update (arrays 422, strings silently dropped, the property never exists on
 * the record under any Version header). Single-option fields write fine
 * (availablenot_available does). The stages field holds no data anywhere -
 * writes never landed - so converting it is risk-free.
 *
 * This round, in order:
 *   1. Fetch all unit fields via Custom Fields V2 (object-key endpoint) to
 *      get the stages field's id and exact JSON shape.
 *   2. Attempt PUT /custom-fields/{id} converting dataType to SINGLE_OPTIONS,
 *      adaptively building the body from the field's own shape.
 *   3. VERIFY by writing "available" to the probe record and reading it back.
 *   4. If conversion is refused, POST a new SINGLE_OPTIONS field "Stage" with
 *      the four options and verify a record write against ITS key instead.
 * Restores the record at the end. Results returned AND stored in
 * audit_events (kind 'stage_probe'). Auth: ?token=<PROBE_TOKEN>.
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
        const { objectKey } = await import("@/lib/kleegr/object-config.server");
        const client = await createCrmClient();
        const locationId = String(client.config.location_id ?? "");
        const bearer = process.env.KLEEGR_CRM_TOKEN ?? "";
        const base = String(client.config.api_base_url ?? "https://services.leadconnectorhq.com").replace(/\/$/, "");
        const recSchemaKey = objectKey(client, "unit");

        const result: Record<string, unknown> = { round: 4, startedAt: new Date().toISOString() };
        const log: Array<Record<string, unknown>> = [];
        result.log = log;

        const call = async (
          method: "GET" | "PUT" | "POST" | "DELETE",
          path: string,
          version: string,
          body?: unknown,
        ): Promise<{ status: number; data: unknown; head: string }> => {
          const res = await fetch(`${base}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${bearer}`,
              "Content-Type": "application/json",
              Accept: "application/json",
              Version: version,
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          });
          const text = await res.text();
          let data: unknown = null;
          try {
            data = JSON.parse(text);
          } catch {
            /* keep head */
          }
          return { status: res.status, data, head: text.slice(0, 300) };
        };

        try {
          // Probe record.
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

          const writeAndRead = async (propKey: string, value: string): Promise<{ stuck: boolean; readBack: unknown }> => {
            await call("PUT", `/objects/${recSchemaKey}/records/${unitId}?locationId=${encodeURIComponent(locationId)}`, "2021-07-28", {
              properties: { [propKey]: value },
            });
            const back = await call("GET", `/objects/${recSchemaKey}/records/${unitId}?locationId=${encodeURIComponent(locationId)}`, "2021-07-28");
            const b = (back.data ?? {}) as Record<string, unknown>;
            const rec = (b.record && typeof b.record === "object" ? b.record : b) as Record<string, unknown>;
            const got = ((rec.properties ?? {}) as Record<string, unknown>)[propKey];
            return { stuck: got != null && got !== "" && JSON.stringify(got) !== "[]", readBack: got ?? null };
          };

          // 1) All unit fields via Custom Fields V2.
          let fields: Array<Record<string, unknown>> = [];
          for (const [ver, path] of [
            ["2021-07-28", `/custom-fields/object-key/custom_objects.units?locationId=${encodeURIComponent(locationId)}`],
            ["2021-07-28", `/custom-field/object-key/custom_objects.units?locationId=${encodeURIComponent(locationId)}`],
          ] as const) {
            const r = await call("GET", path, ver);
            log.push({ step: `fetch fields ${path}`, status: r.status, head: r.status === 200 ? undefined : r.head });
            if (r.status === 200 && r.data && typeof r.data === "object") {
              const d = r.data as Record<string, unknown>;
              const arr = (d.fields ?? d.customFields ?? d.data) as unknown;
              if (Array.isArray(arr)) {
                fields = arr as Array<Record<string, unknown>>;
                break;
              }
            }
          }
          result.fieldCount = fields.length;

          const tail = (fk: unknown) => String(fk ?? "").replace(/^custom_objects\.[^.]+\./, "");
          const stagesField = fields.find((f) => tail(f.fieldKey ?? f.key) === "stages") ?? null;
          result.stagesField = stagesField;
          const unitStatusField = fields.find((f) => tail(f.fieldKey ?? f.key) === "unit_status") ?? null;
          result.unitStatusField = unitStatusField
            ? { id: unitStatusField.id, dataType: unitStatusField.dataType, options: unitStatusField.picklistOptions ?? unitStatusField.options }
            : null;

          // 2) Try converting stages -> SINGLE_OPTIONS.
          let fixed: { propKey: string; via: string } | null = null;
          if (stagesField?.id) {
            const fid = String(stagesField.id);
            const rawOptions = (stagesField.picklistOptions ?? stagesField.options) as unknown;
            const bodies: Array<{ name: string; body: Record<string, unknown> }> = [];
            // Adaptive: copy the field's own shape minus read-only props.
            const copy: Record<string, unknown> = { ...stagesField };
            for (const k of ["id", "_id", "locationId", "objectId", "objectKey", "createdAt", "updatedAt", "dateAdded", "dateUpdated", "createdBy", "updatedBy", "fieldKey", "parentId", "standard", "model"]) {
              delete copy[k];
            }
            copy.dataType = "SINGLE_OPTIONS";
            bodies.push({ name: "full copy minus readonly", body: { ...copy, locationId } });
            bodies.push({ name: "minimal name+dataType+options", body: { locationId, name: String(stagesField.name ?? "Stages"), dataType: "SINGLE_OPTIONS", ...(Array.isArray(rawOptions) ? { picklistOptions: rawOptions } : {}) } });
            bodies.push({ name: "minimal dataType only", body: { locationId, dataType: "SINGLE_OPTIONS" } });

            for (const attempt of bodies) {
              const r = await call("PUT", `/custom-fields/${fid}`, "2021-07-28", attempt.body);
              log.push({ step: `convert stages: ${attempt.name}`, status: r.status, head: r.head });
              if (r.status >= 200 && r.status < 300) {
                const v = await writeAndRead("stages", "available");
                log.push({ step: "verify stages write after conversion", ...v });
                if (v.stuck) {
                  fixed = { propKey: "stages", via: `converted via ${attempt.name}` };
                }
                break; // converted (or at least accepted) - do not keep re-putting
              }
            }
          } else {
            log.push({ step: "stages field id not found in Custom Fields V2 list" });
          }

          // 3) Fallback: create a fresh SINGLE_OPTIONS field and verify against it.
          if (!fixed) {
            const options = [
              { key: "available", label: "Available" },
              { key: "reservedlocked", label: "Reserved/Locked" },
              { key: "under_contract", label: "Under Contract" },
              { key: "closedsold", label: "Closed/Sold" },
            ];
            const createBodies: Array<{ name: string; body: Record<string, unknown> }> = [
              { name: "objectKey + picklistOptions objects", body: { locationId, objectKey: "custom_objects.units", name: "Stage", dataType: "SINGLE_OPTIONS", picklistOptions: options } },
              { name: "objectKey + options strings", body: { locationId, objectKey: "custom_objects.units", name: "Stage", dataType: "SINGLE_OPTIONS", options: options.map((o) => o.label) } },
              { name: "model + picklistOptions strings", body: { locationId, model: "custom_objects.units", name: "Stage", dataType: "SINGLE_OPTIONS", picklistOptions: options.map((o) => o.label) } },
            ];
            for (const attempt of createBodies) {
              const r = await call("POST", `/custom-fields/`, "2021-07-28", attempt.body);
              log.push({ step: `create Stage field: ${attempt.name}`, status: r.status, head: r.head });
              if (r.status >= 200 && r.status < 300 && r.data && typeof r.data === "object") {
                const d = r.data as Record<string, unknown>;
                const created = (d.field && typeof d.field === "object" ? d.field : d) as Record<string, unknown>;
                const newKey = tail(created.fieldKey ?? created.key ?? "stage") || "stage";
                result.createdField = { id: created.id, fieldKey: created.fieldKey, key: newKey };
                const v = await writeAndRead(newKey, "available");
                log.push({ step: `verify write to new field "${newKey}"`, ...v });
                if (v.stuck) fixed = { propKey: newKey, via: `new field ${attempt.name}` };
                break;
              }
            }
          }

          result.fixed = fixed ?? "NOT FIXED - see log";

          // Restore the probe record's stage to empty.
          await call("PUT", `/objects/${recSchemaKey}/records/${unitId}?locationId=${encodeURIComponent(locationId)}`, "2021-07-28", {
            properties: { stages: null, ...(fixed && fixed.propKey !== "stages" ? { [fixed.propKey]: null } : {}) },
          });
          result.restored = true;
        } catch (err) {
          result.error = (err instanceof Error ? err.message : String(err)).slice(0, 400);
        }

        result.finishedAt = new Date().toISOString();

        try {
          await supabaseAdmin.from("audit_events").insert({
            kind: "stage_probe",
            reason: "temporary stages picklist probe round 4 (fix attempt)",
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
