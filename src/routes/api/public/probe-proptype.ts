/**
 * TEMPORARY probe — finds which payload shape GHL's PUT accepts for the
 * MULTIPLE_OPTIONS field `property_type`.
 *
 * DELETE THIS FILE after use.
 *
 *   ?token=<TOKEN>&recordId=<project record id>
 *
 * Tries each candidate format in turn against ONE project record and reports
 * the status of each. Use a FAKE project — this writes.
 *
 * Background: the importer sends property_type: ["condo"] (correct shape for a
 * multi-select). POST /records accepts it; PUT /records/{id} returns 422
 * "We couldn't apply updates to Property Type due to an unexpected format."
 * So the create and update endpoints disagree, and we need to know how.
 */
import { createFileRoute } from "@tanstack/react-router";

const TOKEN = "kb7Xt2mQ9pR4wLzN8vD3sFhJ6yA1cE5u";

const CANDIDATES: Array<{ label: string; value: unknown }> = [
  { label: 'array of option key   ["condo"]', value: ["condo"] },
  { label: 'bare option key       "condo"', value: "condo" },
  { label: 'array of label        ["Condo"]', value: ["Condo"] },
  { label: 'bare label            "Condo"', value: "Condo" },
  { label: 'object wrapper        {value:["condo"]}', value: { value: ["condo"] } },
];

export const Route = createFileRoute("/api/public/probe-proptype")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          if (url.searchParams.get("token") !== TOKEN) {
            return json({ error: "Invalid token" }, 401);
          }

          const recordId = url.searchParams.get("recordId");
          if (!recordId) {
            return json({ error: "recordId query param required (use a FAKE project record id)" }, 400);
          }

          const { createCrmClient } = await import("@/lib/kleegr/client.server");
          const { requestObject } = await import("@/lib/kleegr/object-config.server");
          const client = await createCrmClient();

          // Control: does PUT work at all on this record with a plain TEXT field?
          let controlResult = "";
          try {
            await requestObject(client, "PUT", "project", `/records/${recordId}`, {
              body: { properties: { project_code: "PROBE" } },
            });
            controlResult = "OK - PUT itself works; the issue is property_type specifically";
          } catch (err) {
            controlResult = shorten(err);
          }

          const results: Array<{ format: string; result: string }> = [];
          for (const candidate of CANDIDATES) {
            try {
              await requestObject(client, "PUT", "project", `/records/${recordId}`, {
                body: { properties: { property_type: candidate.value } },
              });
              results.push({ format: candidate.label, result: "OK" });
            } catch (err) {
              results.push({ format: candidate.label, result: shorten(err) });
            }
          }

          return json({
            ok: true,
            recordId,
            control_put_text_field_only: controlResult,
            property_type_formats: results,
            note: "Whichever format reports OK is what PUT wants.",
          });
        } catch (err) {
          return json({ ok: false, caught: err instanceof Error ? err.message : String(err) }, 500);
        }
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});

function shorten(err: unknown): string {
  const m = err instanceof Error ? err.message : String(err);
  return m.length > 200 ? m.slice(0, 200) + "..." : m;
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
