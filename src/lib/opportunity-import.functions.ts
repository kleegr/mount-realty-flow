import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * OPPORTUNITY IMPORT — context + preview. NOTHING HERE WRITES.
 *
 * The deal import is the first step that can actually corrupt inventory, so it
 * gets a resolution dry-run first. Two things must be true for a row to import,
 * and both are guesses until measured:
 *
 *   1. THE PERSON RESOLVES. contact_id_map keys on stable_id, which for this
 *      sheet is `name:<normalised>` — no C001 column was ever added. 110 of 143
 *      matched on email and are solid; 22 matched on name alone. Name drift is
 *      real here ("Friedman (Yoel Gluck)", "Efroyam" vs "efraim"), so the rate
 *      is reported rather than assumed.
 *
 *   2. THE UNIT RESOLVES. This is the part that was impossible before today.
 *      Unit display names are "{DEVELOPER} - {BUILDING} - {UNIT} {NUMBER}" and
 *      buildings are "{DEVELOPER} - {BUILDING}", so a naive string match is
 *      brittle. Now that parent_crm_id is populated, the reliable path is
 *      building-first: resolve "{DEVELOPER} - {BUILDING}" to a building, then
 *      look only at ITS units. That turns a global string match into a search of
 *      four candidates, and makes "47 Mangin Lot 1" vs "47 Mangin Lot 2"
 *      unambiguous.
 *
 * THE STAGE MAPPING IS NOT GUESSED. Every distinct STATUS in the sheet is
 * reported with its row count, and the live pipeline stages are returned
 * alongside, so the mapping is chosen against reality rather than described in
 * prose. 177 rows say "Under Contract" in two different casings; where they land
 * is a business decision, not an inference I should be making.
 */

async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden: importer role required.");
}

function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function clean(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function isJunk(v: unknown): boolean {
  const s = String(v ?? "").trim();
  if (!s) return true;
  return /^(#value!|#ref!|#n\/a|#div\/0!|#name\?|null|undefined|n\/a|-|none)$/i.test(s);
}

/** Find a header by loose name, so "CLIENT NAME" and "Client Name" both hit. */
function pickHeader(headers: string[], aliases: string[]): string | null {
  const wanted = aliases.map(norm);
  return headers.find((h) => wanted.includes(norm(h))) ?? null;
}

/** Live pipelines and their stages, plus how much of the sheet can resolve. */
export const getOpportunityContext = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("LOOK") }).parse(d))
  .handler(async ({ context }) => {
    await requireImporter(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();
    const locationId = client.config.location_id;

    const pipelines: Array<{
      id: string;
      name: string;
      stages: Array<{ id: string; name: string }>;
      openDeals: number | null;
    }> = [];
    let crmError: string | null = null;

    try {
      const res = await client.request<{ pipelines?: Array<Record<string, unknown>> }>(
        "GET",
        "/opportunities/pipelines",
        { query: { locationId: String(locationId) } },
      );
      for (const p of res.data?.pipelines ?? []) {
        const id = typeof p.id === "string" ? p.id : "";
        if (!id) continue;
        const stages = Array.isArray(p.stages)
          ? (p.stages as Array<Record<string, unknown>>)
              .map((s) => ({ id: String(s.id ?? ""), name: String(s.name ?? "") }))
              .filter((s) => s.id)
          : [];
        let openDeals: number | null = null;
        try {
          const c = await client.request<{ meta?: { total?: number }; total?: number }>(
            "GET",
            "/opportunities/search",
            { query: { location_id: String(locationId), pipeline_id: id, limit: 1 } },
          );
          openDeals = c.data?.meta?.total ?? c.data?.total ?? null;
        } catch {
          openDeals = null;
        }
        pipelines.push({ id, name: String(p.name ?? "(unnamed)"), stages, openDeals });
      }
    } catch (err) {
      crmError = err instanceof Error ? err.message.slice(0, 400) : String(err);
    }

    // What the engine treats each stage as. Stage ids are all null in this
    // location — everything matches by NAME.
    const { data: rules } = await supabaseAdmin
      .from("crm_pipelines")
      .select(
        "pipeline_id, pipeline_name, release_stage_names, reserved_stage_names, under_contract_stage_names, sold_stage_names",
      );

    const [{ count: contacts }, { count: units }] = await Promise.all([
      supabaseAdmin.from("contact_id_map").select("stable_id", { count: "exact", head: true }),
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "unit"),
    ]);

    return {
      pipelines,
      crmError,
      stageRules: rules ?? [],
      contactsMapped: contacts ?? 0,
      unitsMapped: units ?? 0,
      totalOpenDeals: pipelines.reduce((n, p) => n + (p.openDeals ?? 0), 0),
    };
  });

const RowSchema = z.record(z.string(), z.unknown());

/**
 * Dry run. Reports what WOULD happen, resolves nothing destructively.
 */
export const previewOpportunityImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ rows: z.array(RowSchema).max(5000) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const headers = Object.keys(data.rows[0] ?? {});
    const H = {
      developer: pickHeader(headers, ["developer", "project", "builder"]),
      building: pickHeader(headers, ["building", "buildingname", "address"]),
      unit: pickHeader(headers, ["unit", "unitnumber", "unitno", "apt"]),
      status: pickHeader(headers, ["status", "unitstatus"]),
      client: pickHeader(headers, ["clientname", "client", "buyer", "buyername", "name"]),
      price: pickHeader(headers, ["saleprice", "price", "askingprice", "askingsaleprice"]),
    };

    // ---- Load the maps once. 332 units + 71 buildings is nothing.
    const [unitsRes, buildingsRes, contactsRes] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id, display_name, code, parent_crm_id").eq("scope", "unit"),
      supabaseAdmin.from("external_id_map").select("crm_record_id, display_name, code").eq("scope", "building"),
      supabaseAdmin.from("contact_id_map").select("stable_id, crm_contact_id, display_name"),
    ]);

    const buildingByName = new Map<string, string>();
    for (const b of buildingsRes.data ?? []) {
      if (b.display_name) buildingByName.set(norm(b.display_name), b.crm_record_id);
    }

    const unitsByBuilding = new Map<string, Array<{ id: string; name: string }>>();
    const unitByName = new Map<string, string>();
    for (const u of unitsRes.data ?? []) {
      if (u.display_name) unitByName.set(norm(u.display_name), u.crm_record_id);
      if (u.parent_crm_id) {
        const arr = unitsByBuilding.get(u.parent_crm_id) ?? [];
        arr.push({ id: u.crm_record_id, name: u.display_name ?? "" });
        unitsByBuilding.set(u.parent_crm_id, arr);
      }
    }

    const contactByStable = new Map<string, string>();
    for (const c of contactsRes.data ?? []) contactByStable.set(c.stable_id, c.crm_contact_id);

    // ---- Walk the rows.
    const statusCounts: Record<string, number> = {};
    let withClient = 0;
    let contactHit = 0;
    let buildingHit = 0;
    let unitHit = 0;
    const unresolvedUnits: Array<{ row: number; key: string }> = [];
    const unresolvedContacts: Array<{ row: number; name: string }> = [];

    for (const [i, row] of data.rows.entries()) {
      const rowNo = i + 2;
      const status = clean(H.status ? row[H.status] : "");
      const statusKey = status || "(blank)";
      statusCounts[statusKey] = (statusCounts[statusKey] ?? 0) + 1;

      const clientName = clean(H.client ? row[H.client] : "");
      if (!clientName || isJunk(clientName)) continue;
      withClient++;

      // person
      const stable = `name:${norm(clientName)}`;
      if (contactByStable.has(stable)) contactHit++;
      else if (unresolvedContacts.length < 25) unresolvedContacts.push({ row: rowNo, name: clientName });

      // building, then its units only
      const dev = clean(H.developer ? row[H.developer] : "");
      const bld = clean(H.building ? row[H.building] : "");
      const unitRef = clean(H.unit ? row[H.unit] : "");
      const buildingKey = norm(`${dev} - ${bld}`);
      const buildingId = buildingByName.get(buildingKey) ?? null;
      if (buildingId) buildingHit++;

      let resolvedUnit: string | null = null;
      if (buildingId && unitRef && !isJunk(unitRef)) {
        const candidates = unitsByBuilding.get(buildingId) ?? [];
        const want = norm(unitRef);
        const exact = candidates.find((c) => norm(c.name) === norm(`${dev} - ${bld} - ${unitRef} ${unitRef}`));
        const byTail = candidates.find((c) => norm(c.name).endsWith(want));
        const byContains = candidates.filter((c) => norm(c.name).includes(want));
        resolvedUnit = exact?.id ?? byTail?.id ?? (byContains.length === 1 ? byContains[0].id : null);
      }
      if (!resolvedUnit) {
        const whole = unitByName.get(norm(`${dev} - ${bld} - ${unitRef} ${unitRef}`));
        if (whole) resolvedUnit = whole;
      }

      if (resolvedUnit) unitHit++;
      else if (unresolvedUnits.length < 25) unresolvedUnits.push({ row: rowNo, key: `${dev} | ${bld} | ${unitRef}` });
    }

    return {
      totalRows: data.rows.length,
      headersFound: H,
      statusCounts,
      withClient,
      contactHit,
      buildingHit,
      unitHit,
      unresolvedContacts,
      unresolvedUnits,
      sampleUnitNames: (unitsRes.data ?? []).slice(0, 5).map((u) => u.display_name),
      sampleBuildingNames: (buildingsRes.data ?? []).slice(0, 5).map((b) => b.display_name),
    };
  });
