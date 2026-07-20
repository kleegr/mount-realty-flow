/**
 * TEMPORARY diagnostic endpoint - DELETE AFTER USE. Round 3.
 * Round 2 found: PUT with Version 2023-02-21 + bare string returns 200 WITH
 * the full record, while arrays 422 and PATCH 404s. Round 1's "silent drop"
 * verdicts all used GET with Version 2021-07-28 - which may simply not
 * return MULTIPLE_OPTIONS values. Round 3: write a bare string under each
 * Version, then read back under BOTH Versions, capturing the FULL properties
 * from every response. Restores at end. Results returned AND stored in
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
        const schemaKey = objectKey(client, "unit");

        const result: Record<string, unknown> = { round: 3, startedAt: new Date().toISOString(), schemaKey };

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

          const raw = async (
            method: "GET" | "PUT",
            version: string,
            body?: unknown,
          ): Promise<{ status: number; properties: unknown; head: string }> => {
            const res = await fetch(
              `${base}/objects/${schemaKey}/records/${unitId}?locationId=${encodeURIComponent(locationId)}`,
              {
                method,
                headers: {
                  Authorization: `Bearer ${bearer}`,
                  "Content-Type": "application/json",
                  Accept: "application/json",
                  Version: version,
                },
                body: body === undefined ? undefined : JSON.stringify(body),
              },
            );
            const text = await res.text();
            let properties: unknown = null;
            try {
              const parsed = JSON.parse(text) as Record<string, unknown>;
              const rec = (parsed.record && typeof parsed.record === "object" ? parsed.record : parsed) as Record<string, unknown>;
              properties = rec.properties ?? null;
            } catch {
              /* keep head */
            }
            return { status: res.status, properties, head: text.slice(0, 200) };
          };

          const steps: Array<Record<string, unknown>> = [];
          const record = (name: string, r: { status: number; properties: unknown; head: string }) =>
            steps.push({ name, status: r.status, properties: r.properties, head: r.properties ? undefined : r.head });

          // Baseline read under both versions.
          record("GET v2021 before", await raw("GET", "2021-07-28"));
          record("GET v2023 before", await raw("GET", "2023-02-21"));

          // Write bare string under v2023, read back under both.
          record("PUT v2023 stages=available", await raw("PUT", "2023-02-21", { properties: { stages: "available" } }));
          record("GET v2021 after v2023 write", await raw("GET", "2021-07-28"));
          record("GET v2023 after v2023 write", await raw("GET", "2023-02-21"));

          // Clear, then write bare string under v2021, read back under both.
          record("PUT v2023 clear", await raw("PUT", "2023-02-21", { properties: { stages: null } }));
          record("PUT v2021 stages=available", await raw("PUT", "2021-07-28", { properties: { stages: "available" } }));
          record("GET v2021 after v2021 write", await raw("GET", "2021-07-28"));
          record("GET v2023 after v2021 write", await raw("GET", "2023-02-21"));

          // Restore empty.
          record("PUT v2023 restore null", await raw("PUT", "2023-02-21", { properties: { stages: null } }));
          record("GET v2023 final", await raw("GET", "2023-02-21"));

          result.steps = steps;
        } catch (err) {
          result.error = (err instanceof Error ? err.message : String(err)).slice(0, 400);
        }

        result.finishedAt = new Date().toISOString();

        try {
          await supabaseAdmin.from("audit_events").insert({
            kind: "stage_probe",
            reason: "temporary stages picklist probe round 3",
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
