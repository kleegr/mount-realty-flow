/**
 * TEMPORARY diagnostic endpoint - DELETE AFTER USE. Round 2.
 * Round 1 proved: with Version 2021-07-28, EVERY bare string (including the
 * schema's own option keys and labels) is accepted-and-dropped on PUT, and
 * the array shape 422s. The field is MULTIPLE_OPTIONS. This round tests the
 * write matrix: Version header (2021-07-28 / 2023-02-21) x body shape
 * (array, bare string, nested options, flat body, PATCH). Restores at end.
 * Results returned AND stored in audit_events (kind 'stage_probe').
 * Auth: ?token=<PROBE_TOKEN>.
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
        const { requestObject, objectKey } = await import("@/lib/kleegr/object-config.server");
        const client = await createCrmClient();
        const locationId = String(client.config.location_id ?? "");
        const bearer = process.env.KLEEGR_CRM_TOKEN ?? "";
        const base = String(client.config.api_base_url ?? "https://services.leadconnectorhq.com").replace(/\/$/, "");
        const schemaKey = objectKey(client, "unit");

        const result: Record<string, unknown> = { round: 2, startedAt: new Date().toISOString(), schemaKey };

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

          const rawWrite = async (
            method: "PUT" | "PATCH" | "POST",
            version: string,
            body: unknown,
            pathSuffix = `/records/${unitId}`,
            withLocationQuery = true,
          ): Promise<{ status: number; text: string }> => {
            const q = withLocationQuery ? `?locationId=${encodeURIComponent(locationId)}` : "";
            const res = await fetch(`${base}/objects/${schemaKey}${pathSuffix}${q}`, {
              method,
              headers: {
                Authorization: `Bearer ${bearer}`,
                "Content-Type": "application/json",
                Accept: "application/json",
                Version: version,
              },
              body: JSON.stringify(body),
            });
            const text = await res.text();
            return { status: res.status, text: text.slice(0, 220) };
          };

          type Cand = { name: string; method: "PUT" | "PATCH"; version: string; body: unknown };
          const A = "available";
          const candidates: Cand[] = [
            { name: "PUT v2021 props array (baseline)", method: "PUT", version: "2021-07-28", body: { properties: { stages: [A] } } },
            { name: "PUT v2023 props array", method: "PUT", version: "2023-02-21", body: { properties: { stages: [A] } } },
            { name: "PUT v2023 props string", method: "PUT", version: "2023-02-21", body: { properties: { stages: A } } },
            { name: "PUT v2021 props label array", method: "PUT", version: "2021-07-28", body: { properties: { stages: ["Available"] } } },
            { name: "PUT v2021 nested options", method: "PUT", version: "2021-07-28", body: { properties: { stages: { options: [A] } } } },
            { name: "PUT v2021 flat body array", method: "PUT", version: "2021-07-28", body: { stages: [A], locationId } },
            { name: "PUT v2023 flat body array", method: "PUT", version: "2023-02-21", body: { stages: [A], locationId } },
            { name: "PUT v2021 props array + body locationId", method: "PUT", version: "2021-07-28", body: { locationId, properties: { stages: [A] } } },
            { name: "PUT v2021 option objects", method: "PUT", version: "2021-07-28", body: { properties: { stages: [{ key: A }] } } },
            { name: "PATCH v2021 props array", method: "PATCH", version: "2021-07-28", body: { properties: { stages: [A] } } },
            { name: "PATCH v2023 props array", method: "PATCH", version: "2023-02-21", body: { properties: { stages: [A] } } },
          ];

          const attempts: Array<Record<string, unknown>> = [];
          let winner: string | null = null;
          for (const c of candidates) {
            try {
              const w = await rawWrite(c.method, c.version, c.body);
              const back = w.status >= 200 && w.status < 300 ? await readStage() : undefined;
              const stuck = back != null && back !== "" && JSON.stringify(back) !== "[]";
              attempts.push({ name: c.name, status: w.status, response: w.text, readBack: back ?? null, stuck });
              if (stuck && !winner) winner = c.name;
            } catch (err) {
              attempts.push({ name: c.name, error: (err instanceof Error ? err.message : String(err)).slice(0, 180), stuck: false });
            }
          }
          result.attempts = attempts;
          result.winner = winner ?? "NONE";

          try {
            await rawWrite("PUT", "2021-07-28", { properties: { stages: original == null || original === "" ? null : original } });
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
            reason: "temporary stages picklist probe round 2",
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
