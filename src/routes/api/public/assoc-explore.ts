/**
 * TEMPORARY read-only diagnostic — SELF-DRIVING.
 *
 * No IDs needed. It finds opportunities itself, then dumps:
 *   1. the location's association DEFINITIONS (this is where "Suggested Units"
 *      and "Locked/Reserved Units" are defined — we need their keys/ids to
 *      filter on)
 *   2. the raw relations payload for the first few opportunities that actually
 *      have relations
 *
 * DELETE THIS FILE after use.
 *
 *   ?token=<TOKEN>
 *   &dump=3     how many opportunities to dump in full (default 3)
 *   &scan=60    how many opportunities to scan for relations (default 60)
 *
 * Read-only: GETs only. Writes nothing.
 */
import { createFileRoute } from "@tanstack/react-router";

const TOKEN = "kb7Xt2mQ9pR4wLzN8vD3sFhJ6yA1cE5u";

export const Route = createFileRoute("/api/public/assoc-explore")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          if (url.searchParams.get("token") !== TOKEN) {
            return json({ error: "Invalid token" }, 401);
          }
          const dumpLimit = clampInt(url.searchParams.get("dump"), 3, 1, 10);
          const scanLimit = clampInt(url.searchParams.get("scan"), 60, 1, 200);

          const { createCrmClient } = await import("@/lib/kleegr/client.server");
          const client = await createCrmClient();
          const locationId = client.config.location_id;
          if (!locationId) return json({ error: "crm_config.location_id is not set" }, 500);

          // ---- 1) Association definitions for this location -------------------
          // This is the key artefact: it should name both association types and
          // give us the id/key that each relation row refers back to.
          let associationDefinitions: unknown = null;
          let associationDefinitionsError: string | null = null;
          try {
            const res = await client.request<unknown>("GET", "/associations/", {
              query: { locationId, skip: 0, limit: 100 },
            });
            associationDefinitions = res.data;
          } catch (err) {
            associationDefinitionsError = err instanceof Error ? err.message : String(err);
          }

          // ---- 2) Find opportunities ------------------------------------------
          const opps: Array<Record<string, unknown>> = [];
          let oppsError: string | null = null;
          try {
            let page = 1;
            while (opps.length < scanLimit && page <= 3) {
              const res = await client.request<Record<string, unknown>>(
                "GET",
                "/opportunities/search",
                { query: { location_id: locationId, limit: 100, page } },
              );
              const data = res.data ?? {};
              const list = (data["opportunities"] ?? data["data"] ?? []) as Array<Record<string, unknown>>;
              if (!Array.isArray(list) || list.length === 0) break;
              opps.push(...list);
              if (list.length < 100) break;
              page++;
            }
          } catch (err) {
            oppsError = err instanceof Error ? err.message : String(err);
          }

          // ---- 3) Scan them for relations -------------------------------------
          const withRelations: Array<Record<string, unknown>> = [];
          const scanned = opps.slice(0, scanLimit);
          for (const opp of scanned) {
            if (withRelations.length >= dumpLimit) break;
            const oppId = typeof opp["id"] === "string" ? (opp["id"] as string) : null;
            if (!oppId) continue;
            try {
              const res = await client.request<Record<string, unknown>>(
                "GET",
                `/associations/relations/${oppId}`,
                { query: { locationId, skip: 0, limit: 100 } },
              );
              const body = res.data ?? {};
              const relations = body["relations"];
              const count = Array.isArray(relations) ? relations.length : 0;
              if (count === 0) continue;
              withRelations.push({
                opportunityId: oppId,
                opportunityName: opp["name"] ?? null,
                stageName: opp["stageName"] ?? opp["stage"] ?? null,
                pipelineStageId: opp["pipelineStageId"] ?? opp["stageId"] ?? null,
                relation_count: count,
                raw: body,
              });
            } catch {
              // ignore and keep scanning
            }
          }

          return json({
            ok: true,
            summary: {
              opportunities_found: opps.length,
              opportunities_scanned: scanned.length,
              opportunities_with_relations_dumped: withRelations.length,
              opportunities_error: oppsError,
              association_definitions_error: associationDefinitionsError,
            },
            association_definitions: associationDefinitions,
            opportunities_with_relations: withRelations,
            hint: withRelations.length === 0
              ? "No opportunity in the scanned set has any association. Attach a unit to an opportunity in GHL, then reload."
              : "Looking for the field on each relation that identifies WHICH association it belongs to.",
          });
        } catch (err) {
          return json({ ok: false, caught: err instanceof Error ? err.message : String(err) }, 500);
        }
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.trunc(n), min), max);
}

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
