/**
 * TEMPORARY read-only diagnostic — dumps the raw GHL associations response for
 * one opportunity, so we can see how "Suggested Units" is distinguished from
 * "Locked/Reserved Units" in the payload.
 *
 * DELETE THIS FILE after use.
 *
 *   ?token=<TOKEN>&opportunityId=<id>
 *
 * Read-only: one GET against the CRM. Writes nothing.
 */
import { createFileRoute } from "@tanstack/react-router";

const TOKEN = "kb7Xt2mQ9pR4wLzN8vD3sFhJ6yA1cE5u";

export const Route = createFileRoute("/api/public/assoc-dump")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          if (url.searchParams.get("token") !== TOKEN) {
            return json({ error: "Invalid token" }, 401);
          }

          const opportunityId = url.searchParams.get("opportunityId");
          if (!opportunityId) {
            return json({ error: "opportunityId query param is required" }, 400);
          }

          const { createCrmClient } = await import("@/lib/kleegr/client.server");
          const client = await createCrmClient();
          const locationId = client.config.location_id;
          if (!locationId) return json({ error: "crm_config.location_id is not set" }, 500);

          const res = await client.request<unknown>(
            "GET",
            `/associations/relations/${opportunityId}`,
            { query: { locationId, skip: 0, limit: 100 } },
          );

          // Return the RAW body untouched — the whole point is to see the shape,
          // specifically whether each relation carries an association label/key
          // we can filter on (e.g. "Locked/Reserved Units" vs "Suggested Units").
          return json({
            ok: true,
            opportunityId,
            raw: res.data,
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
