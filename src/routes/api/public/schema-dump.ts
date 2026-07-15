/**
 * TEMPORARY read-only diagnostic — dumps the CRM schema for one object.
 * DELETE THIS FILE after use.
 *
 *   ?token=<TOKEN>&scope=project   (or building | unit)
 *
 * Read-only: issues a single GET against the CRM. Writes nothing.
 */
import { createFileRoute } from "@tanstack/react-router";

const TOKEN = "kb7Xt2mQ9pR4wLzN8vD3sFhJ6yA1cE5u";

export const Route = createFileRoute("/api/public/schema-dump")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          if (url.searchParams.get("token") !== TOKEN) {
            return json({ error: "Invalid token" }, 401);
          }

          const scopeParam = (url.searchParams.get("scope") ?? "project").toLowerCase();
          if (!["project", "building", "unit"].includes(scopeParam)) {
            return json({ error: "scope must be project, building or unit" }, 400);
          }
          const scope = scopeParam as "project" | "building" | "unit";

          const { createCrmClient } = await import("@/lib/kleegr/client.server");
          const { requestObject } = await import("@/lib/kleegr/object-config.server");

          const client = await createCrmClient();
          const locationId = client.config.location_id;
          if (!locationId) return json({ error: "crm_config.location_id is not set" }, 500);

          const res = await requestObject<{ fields?: unknown[] }>(client, "GET", scope, "", {
            query: { locationId, fetchProperties: "true" },
          });

          const fields = Array.isArray(res.data?.fields) ? res.data.fields : [];

          // Compact view: just what drives normalizeRecordProperties().
          const summary = fields.map((f) => {
            const field = f as Record<string, unknown>;
            const opts = Array.isArray(field.options) ? field.options : [];
            return {
              name: field.name ?? null,
              fieldKey: field.fieldKey ?? null,
              dataType: field.dataType ?? field.type ?? null,
              optionKeys: opts
                .map((o) => (o as Record<string, unknown>)?.key)
                .filter(Boolean),
            };
          });

          return json({
            ok: true,
            scope,
            field_count: summary.length,
            fields: summary,
          });
        } catch (err) {
          return json(
            {
              ok: false,
              caught: err instanceof Error ? err.message : String(err),
            },
            500,
          );
        }
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
