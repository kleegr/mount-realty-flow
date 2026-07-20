/**
 * TEMPORARY diagnostic endpoint - DELETE AFTER USE. Round 5: CREATE THE FIX.
 * dataType is immutable on update (round 4), so the broken MULTIPLE_OPTIONS
 * "stages" field cannot be converted. Instead: create a new SINGLE_OPTIONS
 * field "Stage" (fieldKey custom_objects.units.stage) with the same four
 * options in the same folder, VERIFY two real record writes stick, then
 * delete the old unwritable field (it holds no data anywhere - proven in
 * rounds 1-3). Idempotent: safe to re-run. Results returned AND stored in
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
        const V = "2021-07-28";

        const result: Record<string, unknown> = { round: 5, startedAt: new Date().toISOString() };
        const log: Array<Record<string, unknown>> = [];
        result.log = log;

        const call = async (
          method: "GET" | "PUT" | "POST" | "DELETE",
          path: string,
          body?: unknown,
        ): Promise<{ status: number; data: unknown; head: string }> => {
          const res = await fetch(`${base}${path}`, {
            method,
            headers: {
              Authorization: `Bearer ${bearer}`,
              "Content-Type": "application/json",
              Accept: "application/json",
              Version: V,
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

          const writeAndRead = async (propKey: string, value: string | null): Promise<{ stuck: boolean; readBack: unknown }> => {
            await call("PUT", `/objects/${recSchemaKey}/records/${unitId}?locationId=${encodeURIComponent(locationId)}`, {
              properties: { [propKey]: value },
            });
            const back = await call("GET", `/objects/${recSchemaKey}/records/${unitId}?locationId=${encodeURIComponent(locationId)}`);
            const b = (back.data ?? {}) as Record<string, unknown>;
            const rec = (b.record && typeof b.record === "object" ? b.record : b) as Record<string, unknown>;
            const got = ((rec.properties ?? {}) as Record<string, unknown>)[propKey];
            return { stuck: got != null && got !== "" && JSON.stringify(got) !== "[]", readBack: got ?? null };
          };

          const fetchFields = async (): Promise<Array<Record<string, unknown>>> => {
            const r = await call("GET", `/custom-fields/object-key/custom_objects.units?locationId=${encodeURIComponent(locationId)}`);
            if (r.status === 200 && r.data && typeof r.data === "object") {
              const d = r.data as Record<string, unknown>;
              const arr = (d.fields ?? d.customFields ?? d.data) as unknown;
              if (Array.isArray(arr)) return arr as Array<Record<string, unknown>>;
            }
            return [];
          };

          const tail = (fk: unknown) => String(fk ?? "").replace(/^custom_objects\.[^.]+\./, "");
          let fields = await fetchFields();
          const oldStages = fields.find((f) => tail(f.fieldKey ?? f.key) === "stages") ?? null;
          let newField = fields.find((f) => tail(f.fieldKey ?? f.key) === "stage") ?? null;
          log.push({ step: "initial field scan", total: fields.length, oldStagesId: oldStages?.id ?? null, newFieldId: newField?.id ?? null });

          const OPTIONS = [
            { key: "available", label: "Available" },
            { key: "reserved_locked", label: "Reserved/Locked" },
            { key: "under_contract", label: "Under Contract" },
            { key: "closed_sold", label: "Closed/Sold" },
          ];

          // 1) Create the new SINGLE_OPTIONS field if it does not exist yet.
          if (!newField) {
            const parentId = String((oldStages?.parentId as string | undefined) ?? "");
            const bodies: Array<{ name: string; body: Record<string, unknown> }> = [
              {
                name: "full fieldKey",
                body: {
                  locationId,
                  objectKey: "custom_objects.units",
                  fieldKey: "custom_objects.units.stage",
                  name: "Stage",
                  dataType: "SINGLE_OPTIONS",
                  description: "",
                  position: 201,
                  showInForms: true,
                  ...(parentId ? { parentId } : {}),
                  options: OPTIONS,
                },
              },
              {
                name: "short fieldKey",
                body: {
                  locationId,
                  objectKey: "custom_objects.units",
                  fieldKey: "stage",
                  name: "Stage",
                  dataType: "SINGLE_OPTIONS",
                  description: "",
                  position: 201,
                  showInForms: true,
                  ...(parentId ? { parentId } : {}),
                  options: OPTIONS,
                },
              },
            ];
            for (const attempt of bodies) {
              const r = await call("POST", `/custom-fields/`, attempt.body);
              log.push({ step: `create Stage field (${attempt.name})`, status: r.status, head: r.status < 300 ? undefined : r.head });
              if (r.status >= 200 && r.status < 300) break;
            }
            fields = await fetchFields();
            newField = fields.find((f) => tail(f.fieldKey ?? f.key) === "stage") ?? null;
          }
          result.newField = newField
            ? { id: newField.id, fieldKey: newField.fieldKey, dataType: newField.dataType, options: newField.options }
            : "CREATE FAILED - see log";
          if (!newField) throw new Error("Stage field could not be created");

          // 2) VERIFY: two real writes must stick.
          const v1 = await writeAndRead("stage", "available");
          log.push({ step: "verify stage=available", ...v1 });
          const v2 = await writeAndRead("stage", "reserved_locked");
          log.push({ step: "verify stage=reserved_locked", ...v2 });
          const verified = v1.stuck && v2.stuck;
          result.verified = verified;

          // Restore the probe record to empty.
          await writeAndRead("stage", null);

          // 3) Delete the old unwritable field only after full verification.
          if (verified && oldStages?.id) {
            const fid = String(oldStages.id);
            let del = await call("DELETE", `/custom-fields/${fid}?locationId=${encodeURIComponent(locationId)}`);
            if (del.status >= 300) {
              del = await call("DELETE", `/locations/${locationId}/customFields/${fid}`);
            }
            log.push({ step: "delete old stages field", status: del.status, head: del.status < 300 ? undefined : del.head });
            result.oldFieldDeleted = del.status >= 200 && del.status < 300;
          } else if (oldStages?.id) {
            result.oldFieldDeleted = "SKIPPED - verification failed";
          } else {
            result.oldFieldDeleted = "already gone";
          }
        } catch (err) {
          result.error = (err instanceof Error ? err.message : String(err)).slice(0, 400);
        }

        result.finishedAt = new Date().toISOString();

        try {
          await supabaseAdmin.from("audit_events").insert({
            kind: "stage_probe",
            reason: "temporary stages picklist probe round 5 (create + verify + swap)",
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
