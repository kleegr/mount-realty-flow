import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * OPPORTUNITY IMPORT — context + preview. NOTHING HERE WRITES.
 *
 * FIRST DRY RUN RESOLVED 118 OF 183 UNITS. The cause was one pattern, not 65
 * separate problems: the sheet's Building column carries the unit number glued
 * on the end.
 *
 *   sheet: "Diligent developers | 10 Chesnut Drive # 101 | 101"
 *   GHL:   "Diligent developers - 10 Chesnut Drive"
 *
 * So the building key never matched, and a failed building means a failed unit —
 * building resolution was 119/183 and unit resolution 118/183 for the same
 * reason. stripUnitSuffix() below is the whole fix.
 *
 * WHY BUILDING-FIRST AT ALL: unit names are
 * "{DEVELOPER} - {BUILDING} - {UNIT} {NUMBER}" — matching "101" globally across
 * 332 units would hit every building with a 101. Resolving the building first
 * narrows it to that building's ~4 units, which is what makes "47 Mangin Lot 1"
 * vs "Lot 2" decidable. This only became possible when parent_crm_id was
 * repaired tonight.
 *
 * AMBIGUITY IS REPORTED, NEVER GUESSED. Two failure modes in this sheet are not
 * resolvable by code and must not be silently picked:
 *   - row 190: Building says "#201", UNIT column says "102". Which is the deal?
 *   - rows 197 + 198: two different clients on "57 Fort worth #101".
 * A wrong unit link doesn't make a bad card — it marks the wrong apartment Under
 * Contract for the wrong family. These surface as conflicts and get excluded.
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

/**
 * "10 Chesnut Drive # 101" -> { building: "10 Chesnut Drive", unit: "101" }
 * "49 Fort worth #101"     -> { building: "49 Fort worth",    unit: "101" }
 * "8 Unit Building C4"     -> { building: "8 Unit Building C4", unit: null }
 *
 * Anchored to the END so a building legitimately named "# 3" mid-string is safe.
 */
function stripUnitSuffix(raw: string): { building: string; unit: string | null } {
  const m = /^(.*?)\s*#\s*(\S+)\s*$/.exec(raw);
  if (!m) return { building: raw.trim(), unit: null };
  return { building: m[1].trim(), unit: m[2].trim() };
}

function pickHeader(headers: string[], aliases: string[]): string | null {
  const wanted = aliases.map(norm);
  return headers.find((h) => wanted.includes(norm(h))) ?? null;
}

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
      governed: boolean;
    }> = [];
    let crmError: string | null = null;

    const { data: rules } = await supabaseAdmin
      .from("crm_pipelines")
      .select(
        "pipeline_id, pipeline_name, release_stage_names, reserved_stage_names, under_contract_stage_names, sold_stage_names",
      );
    const governedIds = new Set((rules ?? []).map((r) => r.pipeline_id).filter(Boolean));

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
        pipelines.push({ id, name: String(p.name ?? "(unnamed)"), stages, openDeals, governed: governedIds.has(id) });
      }
    } catch (err) {
      crmError = err instanceof Error ? err.message.slice(0, 400) : String(err);
    }

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
      dealsInGovernedPipelines: pipelines.filter((p) => p.governed).reduce((n, p) => n + (p.openDeals ?? 0), 0),
      dealsInUngovernedPipelines: pipelines.filter((p) => !p.governed).reduce((n, p) => n + (p.openDeals ?? 0), 0),
    };
  });

const RowSchema = z.record(z.string(), z.unknown());

export const previewOpportunityImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ rows: z.array(RowSchema).max(5000) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const headers = Object.keys(data.rows[0] ?? {});
    const H = {
      developer: pickHeader(headers, ["developer", "project", "builder"]),
      building: pickHeader(headers, ["building", "buildingname"]),
      unit: pickHeader(headers, ["unit", "unitnumber", "unitno", "apt"]),
      status: pickHeader(headers, ["status", "unitstatus"]),
      client: pickHeader(headers, ["clientname", "client", "buyer", "buyername"]),
      price: pickHeader(headers, ["saleprice", "price", "askingprice", "askingsaleprice"]),
    };

    const [unitsRes, buildingsRes, contactsRes] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id, display_name, parent_crm_id").eq("scope", "unit"),
      supabaseAdmin.from("external_id_map").select("crm_record_id, display_name").eq("scope", "building"),
      supabaseAdmin.from("contact_id_map").select("stable_id, crm_contact_id"),
    ]);

    const buildingByName = new Map<string, string>();
    for (const b of buildingsRes.data ?? []) {
      if (b.display_name) buildingByName.set(norm(b.display_name), b.crm_record_id);
    }

    const unitsByBuilding = new Map<string, Array<{ id: string; name: string }>>();
    for (const u of unitsRes.data ?? []) {
      if (!u.parent_crm_id) continue;
      const arr = unitsByBuilding.get(u.parent_crm_id) ?? [];
      arr.push({ id: u.crm_record_id, name: u.display_name ?? "" });
      unitsByBuilding.set(u.parent_crm_id, arr);
    }

    const contactByStable = new Map<string, string>();
    for (const c of contactsRes.data ?? []) contactByStable.set(c.stable_id, c.crm_contact_id);

    const statusCounts: Record<string, number> = {};
    let withClient = 0;
    let contactHit = 0;
    let buildingHit = 0;
    let unitHit = 0;

    const unresolvedUnits: Array<{ row: number; key: string; why: string }> = [];
    const unresolvedContacts: Array<{ row: number; name: string }> = [];
    const conflicts: Array<{ row: number; key: string; detail: string }> = [];
    const byDeveloper: Record<string, { rows: number; resolved: number }> = {};

    // unit crm id -> rows claiming it
    const claims = new Map<string, Array<{ row: number; client: string }>>();

    for (const [i, row] of data.rows.entries()) {
      const rowNo = i + 2;
      const status = clean(H.status ? row[H.status] : "");
      statusCounts[status || "(blank)"] = (statusCounts[status || "(blank)"] ?? 0) + 1;

      const clientName = clean(H.client ? row[H.client] : "");
      if (!clientName || isJunk(clientName)) continue;
      withClient++;

      const stable = `name:${norm(clientName)}`;
      if (contactByStable.has(stable)) contactHit++;
      else if (unresolvedContacts.length < 30) unresolvedContacts.push({ row: rowNo, name: clientName });

      const dev = clean(H.developer ? row[H.developer] : "");
      const rawBuilding = clean(H.building ? row[H.building] : "");
      const unitCol = clean(H.unit ? row[H.unit] : "");

      const devKey = dev || "(none)";
      byDeveloper[devKey] = byDeveloper[devKey] ?? { rows: 0, resolved: 0 };
      byDeveloper[devKey].rows++;

      // The building column may carry the unit: "10 Chesnut Drive # 101".
      const { building: bldName, unit: bldUnit } = stripUnitSuffix(rawBuilding);

      let buildingId =
        buildingByName.get(norm(`${dev} - ${bldName}`)) ?? buildingByName.get(norm(`${dev} - ${rawBuilding}`)) ?? null;
      if (buildingId) buildingHit++;

      // Which unit does this row mean? The UNIT column wins; the suffix is a
      // fallback. When they disagree, that is a data conflict, not a tie to break.
      let unitRef: string | null = null;
      if (unitCol && !isJunk(unitCol)) {
        unitRef = unitCol;
        if (bldUnit && norm(bldUnit) !== norm(unitCol) && conflicts.length < 30) {
          conflicts.push({
            row: rowNo,
            key: `${dev} | ${rawBuilding} | ${unitCol}`,
            detail: `Building says unit "${bldUnit}" but the UNIT column says "${unitCol}".`,
          });
        }
      } else if (bldUnit) {
        unitRef = bldUnit;
      }

      let resolvedUnit: string | null = null;
      let why = "";
      if (!buildingId) {
        why = `no building matching "${dev} - ${bldName}"`;
      } else if (!unitRef) {
        why = "no unit number in either the UNIT column or the building name";
      } else {
        const candidates = unitsByBuilding.get(buildingId) ?? [];
        const want = norm(unitRef);
        const exact = candidates.find((c) => norm(c.name) === norm(`${dev} - ${bldName} - ${unitRef} ${unitRef}`));
        const tail = candidates.filter((c) => norm(c.name).endsWith(want));
        const contains = candidates.filter((c) => norm(c.name).includes(want));
        if (exact) resolvedUnit = exact.id;
        else if (tail.length === 1) resolvedUnit = tail[0].id;
        else if (contains.length === 1) resolvedUnit = contains[0].id;
        else if (tail.length > 1 || contains.length > 1) why = `"${unitRef}" matches ${Math.max(tail.length, contains.length)} units in that building`;
        else why = `no unit "${unitRef}" under that building (${candidates.length} units there)`;
      }

      if (resolvedUnit) {
        unitHit++;
        byDeveloper[devKey].resolved++;
        const arr = claims.get(resolvedUnit) ?? [];
        arr.push({ row: rowNo, client: clientName });
        claims.set(resolvedUnit, arr);
      } else if (unresolvedUnits.length < 30) {
        unresolvedUnits.push({ row: rowNo, key: `${dev} | ${rawBuilding} | ${unitCol}`, why });
      }
    }

    // Two clients, one apartment. Never auto-resolve this.
    const doubleClaimed = [...claims.entries()]
      .filter(([, rows]) => rows.length > 1)
      .map(([unitId, rows]) => ({
        unitId,
        rows: rows.map((r) => `row ${r.row}: ${r.client}`),
      }))
      .slice(0, 20);

    return {
      totalRows: data.rows.length,
      headersFound: H,
      statusCounts,
      withClient,
      contactHit,
      buildingHit,
      unitHit,
      importable: Math.min(contactHit, unitHit),
      byDeveloper,
      unresolvedContacts,
      unresolvedUnits,
      conflicts,
      doubleClaimed,
    };
  });
