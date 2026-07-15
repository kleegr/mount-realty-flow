/**
 * TEMPORARY admin tool — force-release units back to Available.
 * DELETE THIS FILE after use.
 *
 *   ?token=<TOKEN>&ids=<unitCrmId,unitCrmId,...>
 *   &dry=1   → report what WOULD change, write nothing
 *
 * Fixes BOTH sides that drift apart:
 *   1. the GHL unit record (availability / stages / inventory_deducted / locked_date)
 *   2. the Supabase unit_state mirror the dashboard reads
 * ...then recomputes the parent Building / Project rollups.
 *
 * NOTE on clearing: normalizeRecordProperties() strips "" values, so an empty
 * string can never clear a field in GHL. We send explicit nulls instead, and
 * fall back to a partial update if GHL rejects them — reporting which happened.
 */
import { createFileRoute } from "@tanstack/react-router";

const TOKEN = "kb7Xt2mQ9pR4wLzN8vD3sFhJ6yA1cE5u";

type UnitResult = {
  unitCrmId: string;
  ghl: string;
  mirror: string;
  note?: string;
};

export const Route = createFileRoute("/api/public/release-units")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);
          if (url.searchParams.get("token") !== TOKEN) {
            return json({ error: "Invalid token" }, 401);
          }

          const idsParam = url.searchParams.get("ids") ?? "";
          const ids = idsParam.split(",").map((s) => s.trim()).filter(Boolean);
          if (ids.length === 0) {
            return json({ error: "ids query param required (comma-separated unit CRM ids)" }, 400);
          }
          if (ids.length > 50) {
            return json({ error: "max 50 ids per call" }, 400);
          }
          const dryRun = url.searchParams.get("dry") === "1";

          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
          const { createCrmClient } = await import("@/lib/kleegr/client.server");
          const { normalizeRecordProperties, requestObject } = await import("@/lib/kleegr/object-config.server");
          const { FIELDS } = await import("@/lib/kleegr/field-map");

          // Current mirror state, for the report and for rollup targets.
          const { data: before } = await supabaseAdmin
            .from("unit_state")
            .select("unit_crm_id, availability, stage, building_crm_id, project_crm_id")
            .in("unit_crm_id", ids);

          if (dryRun) {
            return json({
              ok: true,
              dry_run: true,
              would_release: (before ?? []).map((r) => ({
                unitCrmId: r.unit_crm_id,
                from: { availability: r.availability, stage: r.stage },
                to: { availability: "Available", stage: "" },
              })),
              not_in_mirror: ids.filter((id) => !(before ?? []).some((r) => r.unit_crm_id === id)),
            });
          }

          const client = await createCrmClient();
          const results: UnitResult[] = [];
          const buildingIds = new Set<string>();
          const projectIds = new Set<string>();

          for (const unitId of ids) {
            const result: UnitResult = { unitCrmId: unitId, ghl: "skipped", mirror: "skipped" };

            // --- GHL side -----------------------------------------------------
            // Values that survive stripEmpty:
            const setProps = await normalizeRecordProperties(client, "unit", {
              [FIELDS.unit.availability]: "Available",
              [FIELDS.unit.inventory_deducted]: "No",
            });
            // Values that must be CLEARED — explicit null, since "" gets stripped.
            const clearProps = {
              ...setProps,
              [FIELDS.unit.stage]: null,
              [FIELDS.unit.locked_date]: null,
            };

            try {
              await requestObject(client, "PUT", "unit", `/records/${unitId}`, {
                body: { properties: clearProps },
              });
              result.ghl = "released (stage cleared)";
            } catch (errWithNulls) {
              // GHL rejected the nulls — fall back to updating only availability.
              try {
                await requestObject(client, "PUT", "unit", `/records/${unitId}`, {
                  body: { properties: setProps },
                });
                result.ghl = "released (availability only)";
                result.note = `GHL rejected null-clear: ${
                  errWithNulls instanceof Error ? errWithNulls.message : String(errWithNulls)
                }. Clear the Stages field manually on this record.`;
              } catch (errPlain) {
                result.ghl = `FAILED: ${errPlain instanceof Error ? errPlain.message : String(errPlain)}`;
                results.push(result);
                continue;
              }
            }

            // --- Mirror side --------------------------------------------------
            const { error: upErr } = await supabaseAdmin.from("unit_state").upsert(
              { unit_crm_id: unitId, availability: "Available", stage: "" },
              { onConflict: "unit_crm_id" },
            );
            result.mirror = upErr ? `FAILED: ${upErr.message}` : "Available";

            // Best-effort: clear the holder if the ownership migration has run.
            await supabaseAdmin
              .from("unit_state")
              .update({ held_by_opportunity_id: null })
              .eq("unit_crm_id", unitId)
              .then(
                () => undefined,
                () => undefined,
              );

            const row = (before ?? []).find((r) => r.unit_crm_id === unitId);
            if (row?.building_crm_id) buildingIds.add(row.building_crm_id);
            if (row?.project_crm_id) projectIds.add(row.project_crm_id);

            await supabaseAdmin.from("audit_events").insert({
              kind: "manual_release",
              entity_scope: "unit",
              entity_crm_id: unitId,
              previous: { availability: row?.availability ?? null, stage: row?.stage ?? null } as never,
              next: { availability: "Available", stage: "" } as never,
              reason: "Force-released via release-units endpoint (orphaned lock)",
            });

            results.push(result);
          }

          // --- Rollups --------------------------------------------------------
          const rollups: string[] = [];
          if (buildingIds.size > 0 || projectIds.size > 0) {
            const { summarize, writeBuildingRollup, writeProjectRollup } = await import("@/lib/kleegr/rollups.server");
            for (const buildingId of buildingIds) {
              try {
                const { data: siblings } = await supabaseAdmin
                  .from("unit_state").select("availability, stage").eq("building_crm_id", buildingId);
                await writeBuildingRollup(
                  client,
                  buildingId,
                  summarize((siblings ?? []).map((r) => ({ availability: r.availability ?? "", stage: r.stage ?? "" }))),
                );
                rollups.push(`building ${buildingId}: ok`);
              } catch (err) {
                rollups.push(`building ${buildingId}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            for (const projectId of projectIds) {
              try {
                const { data: siblings } = await supabaseAdmin
                  .from("unit_state").select("availability, stage").eq("project_crm_id", projectId);
                await writeProjectRollup(
                  client,
                  projectId,
                  summarize((siblings ?? []).map((r) => ({ availability: r.availability ?? "", stage: r.stage ?? "" }))),
                );
                rollups.push(`project ${projectId}: ok`);
              } catch (err) {
                rollups.push(`project ${projectId}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }

          return json({
            ok: true,
            released: results,
            rollups: rollups.length > 0 ? rollups : "no parent building/project recorded for these units",
          });
        } catch (err) {
          return json(
            { ok: false, caught: err instanceof Error ? err.message : String(err) },
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
