import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * OPPORTUNITY IMPORT.
 *
 * RESOLUTION. The sheet's Building column carries the unit number glued on the
 * end ("10 Chesnut Drive # 101") while GHL's building is "10 Chesnut Drive".
 * That single pattern was the whole reason the first dry run resolved 118/183.
 * stripUnitSuffix() handles it.
 *
 * Units are matched BUILDING-FIRST: unit names are
 * "{DEVELOPER} - {BUILDING} - {UNIT} {NUMBER}", so matching "101" globally would
 * hit every building with a 101. Resolving the building narrows it to that
 * building's ~4 units, which is what makes "47 Mangin Lot 1" vs "Lot 2"
 * decidable. Only possible because parent_crm_id was repaired.
 *
 * THE LOCK. Per the engine's rule 1, the Locked/Reserved association is the ON
 * switch — the stage map does nothing without it. The association definition
 * says units are FIRST and the opportunity SECOND:
 *   firstObjectKey: custom_objects.units, secondObjectKey: opportunity
 * Passing the opportunity first is what produced
 * "Invalid record id ... for association" in the earlier probe.
 *
 * IDEMPOTENCY WITHOUT A NEW TABLE. A unit can be locked to exactly ONE
 * opportunity, so unit_state.held_by_opportunity_id IS the resume state: held
 * means done. No cursor, no bookkeeping table, and re-running is free.
 *
 * ATOMIC PER ROW. If the association fails after the opportunity is created, the
 * opportunity is DELETED. Otherwise a retry would see an unheld unit, create a
 * second deal, and leave an orphan card behind for every partial failure.
 *
 * DOUBLE-CLAIMED UNITS RESOLVE THEMSELVES SAFELY. Two rows on one apartment: the
 * first wins, the second finds the unit already held and reports it instead of
 * silently stealing it. Two families cannot be under contract on one unit.
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

function money(v: unknown): number | null {
  const n = Number(String(v ?? "").replace(/[$,\s]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** "10 Chesnut Drive # 101" -> { building: "10 Chesnut Drive", unit: "101" } */
function stripUnitSuffix(raw: string): { building: string; unit: string | null } {
  const m = /^(.*?)\s*#\s*(\S+)\s*$/.exec(raw);
  if (!m) return { building: raw.trim(), unit: null };
  return { building: m[1].trim(), unit: m[2].trim() };
}

function pickHeader(headers: string[], aliases: string[]): string | null {
  const wanted = aliases.map(norm);
  return headers.find((h) => wanted.includes(norm(h))) ?? null;
}

function headersOf(row: Record<string, unknown>) {
  const headers = Object.keys(row ?? {});
  return {
    developer: pickHeader(headers, ["developer", "project", "builder"]),
    building: pickHeader(headers, ["building", "buildingname"]),
    unit: pickHeader(headers, ["unit", "unitnumber", "unitno", "apt"]),
    status: pickHeader(headers, ["status", "unitstatus"]),
    client: pickHeader(headers, ["clientname", "client", "buyer", "buyername"]),
    price: pickHeader(headers, ["saleprice", "price", "askingprice", "askingsaleprice"]),
  };
}

// ---------------------------------------------------------------- context

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

// ---------------------------------------------------------------- resolver

interface Maps {
  buildingByName: Map<string, string>;
  unitsByBuilding: Map<string, Array<{ id: string; name: string }>>;
  contactByStable: Map<string, string>;
}

async function loadMaps(): Promise<Maps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [unitsRes, buildingsRes, contactsRes] = await Promise.all([
    supabaseAdmin.from("external_id_map").select("crm_record_id, display_name, parent_crm_id").eq("scope", "unit"),
    supabaseAdmin.from("external_id_map").select("crm_record_id, display_name").eq("scope", "building"),
    supabaseAdmin.from("contact_id_map").select("stable_id, crm_contact_id"),
  ]);

  const buildingByName = new Map<string, string>();
  for (const b of buildingsRes.data ?? []) if (b.display_name) buildingByName.set(norm(b.display_name), b.crm_record_id);

  const unitsByBuilding = new Map<string, Array<{ id: string; name: string }>>();
  for (const u of unitsRes.data ?? []) {
    if (!u.parent_crm_id) continue;
    const arr = unitsByBuilding.get(u.parent_crm_id) ?? [];
    arr.push({ id: u.crm_record_id, name: u.display_name ?? "" });
    unitsByBuilding.set(u.parent_crm_id, arr);
  }

  const contactByStable = new Map<string, string>();
  for (const c of contactsRes.data ?? []) contactByStable.set(c.stable_id, c.crm_contact_id);

  return { buildingByName, unitsByBuilding, contactByStable };
}

interface Resolved {
  rowNo: number;
  client: string;
  status: string;
  contactId: string | null;
  unitId: string | null;
  unitLabel: string;
  price: number | null;
  why: string;
  conflict: string | null;
}

function resolveRow(row: Record<string, unknown>, i: number, H: ReturnType<typeof headersOf>, m: Maps): Resolved | null {
  const rowNo = i + 2;
  const clientName = clean(H.client ? row[H.client] : "");
  const status = clean(H.status ? row[H.status] : "");
  if (!clientName || isJunk(clientName)) return null;

  const dev = clean(H.developer ? row[H.developer] : "");
  const rawBuilding = clean(H.building ? row[H.building] : "");
  const unitCol = clean(H.unit ? row[H.unit] : "");
  const { building: bldName, unit: bldUnit } = stripUnitSuffix(rawBuilding);

  const buildingId =
    m.buildingByName.get(norm(`${dev} - ${bldName}`)) ?? m.buildingByName.get(norm(`${dev} - ${rawBuilding}`)) ?? null;

  let unitRef: string | null = null;
  let conflict: string | null = null;
  if (unitCol && !isJunk(unitCol)) {
    unitRef = unitCol;
    if (bldUnit && norm(bldUnit) !== norm(unitCol)) {
      conflict = `Building says unit "${bldUnit}" but the UNIT column says "${unitCol}"`;
    }
  } else if (bldUnit) {
    unitRef = bldUnit;
  }

  let unitId: string | null = null;
  let why = "";
  if (!buildingId) why = `no building matching "${dev} - ${bldName}"`;
  else if (!unitRef) why = "no unit number in the UNIT column or the building name";
  else {
    const candidates = m.unitsByBuilding.get(buildingId) ?? [];
    const want = norm(unitRef);
    const exact = candidates.find((c) => norm(c.name) === norm(`${dev} - ${bldName} - ${unitRef} ${unitRef}`));
    const tail = candidates.filter((c) => norm(c.name).endsWith(want));
    const contains = candidates.filter((c) => norm(c.name).includes(want));
    if (exact) unitId = exact.id;
    else if (tail.length === 1) unitId = tail[0].id;
    else if (contains.length === 1) unitId = contains[0].id;
    else if (tail.length > 1 || contains.length > 1) why = `"${unitRef}" matches more than one unit in that building`;
    else why = `no unit "${unitRef}" under that building`;
  }

  return {
    rowNo,
    client: clientName,
    status,
    contactId: m.contactByStable.get(`name:${norm(clientName)}`) ?? null,
    unitId,
    unitLabel: `${dev} ${bldName} ${unitRef ?? ""}`.trim(),
    price: H.price ? money(row[H.price]) : null,
    why,
    conflict,
  };
}

// ---------------------------------------------------------------- preview

const RowSchema = z.record(z.string(), z.unknown());

export const previewOpportunityImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ rows: z.array(RowSchema).max(5000) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const H = headersOf(data.rows[0] ?? {});
    const m = await loadMaps();

    const statusCounts: Record<string, number> = {};
    let withClient = 0;
    let contactHit = 0;
    let unitHit = 0;
    const unresolvedUnits: Array<{ row: number; key: string; why: string }> = [];
    const unresolvedContacts: Array<{ row: number; name: string }> = [];
    const conflicts: Array<{ row: number; detail: string }> = [];
    const claims = new Map<string, Array<string>>();

    for (const [i, row] of data.rows.entries()) {
      const status = clean(H.status ? row[H.status] : "");
      statusCounts[status || "(blank)"] = (statusCounts[status || "(blank)"] ?? 0) + 1;
      const r = resolveRow(row, i, H, m);
      if (!r) continue;
      withClient++;
      if (r.contactId) contactHit++;
      else if (unresolvedContacts.length < 30) unresolvedContacts.push({ row: r.rowNo, name: r.client });
      if (r.conflict && conflicts.length < 30) conflicts.push({ row: r.rowNo, detail: r.conflict });
      if (r.unitId) {
        unitHit++;
        const arr = claims.get(r.unitId) ?? [];
        arr.push(`row ${r.rowNo}: ${r.client}`);
        claims.set(r.unitId, arr);
      } else if (unresolvedUnits.length < 30) {
        unresolvedUnits.push({ row: r.rowNo, key: r.unitLabel, why: r.why });
      }
    }

    const doubleClaimed = [...claims.entries()].filter(([, rs]) => rs.length > 1).map(([unitId, rs]) => ({ unitId, rows: rs })).slice(0, 20);

    return {
      totalRows: data.rows.length,
      headersFound: H,
      statusCounts,
      withClient,
      contactHit,
      unitHit,
      importable: Math.min(contactHit, unitHit),
      unresolvedContacts,
      unresolvedUnits,
      conflicts,
      doubleClaimed,
    };
  });

// ---------------------------------------------------------------- execute

export const runOpportunityImportChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        confirm: z.literal("IMPORT"),
        rows: z.array(RowSchema).max(5000),
        pipelineId: z.string().min(1),
        // normalised sheet status -> pipeline stage id
        stageMap: z.record(z.string(), z.string()),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(15).default(10),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const { applyOpportunityStageToUnit } = await import("./kleegr/release.server");
    const client = await createCrmClient();
    const locationId = client.config.location_id;

    // The Locked/Reserved association — the engine's ON switch. Resolved live so
    // a recreated definition doesn't silently break the lock.
    const defsRes = await client.request<{ associations?: Array<Record<string, unknown>> }>("GET", "/associations/", {
      query: { locationId: String(locationId), skip: 0, limit: 100 },
    });
    const defs = defsRes.data?.associations ?? [];
    const lockDef = defs.find((d) => norm(d.key) === norm("lockedreserved_units"));
    if (!lockDef?.id) {
      throw new Error(
        "No Locked/Reserved Units association is defined in GHL. Without it the stage map does nothing and every unit would stay Available.",
      );
    }
    // Definition order is authoritative: units are first, opportunity second.
    const unitIsFirst = norm(lockDef.firstObjectKey).includes("unit");

    const H = headersOf(data.rows[0] ?? {});
    const m = await loadMaps();

    // Only rows that describe a deal. Blank status = no opportunity; the unit
    // just stays Available.
    const queue: Resolved[] = [];
    for (const [i, row] of data.rows.entries()) {
      const r = resolveRow(row, i, H, m);
      if (!r) continue;
      if (!data.stageMap[norm(r.status)]) continue;
      queue.push(r);
    }

    const slice = queue.slice(data.offset, data.offset + data.limit);
    const results: Array<{ row: number; client: string; ok: boolean; detail: string }> = [];

    for (const r of slice) {
      try {
        if (!r.contactId) throw new Error(`no contact for "${r.client}" — import contacts first`);
        if (!r.unitId) throw new Error(r.why || "unit not resolved");

        // Resume state + double-claim guard in one: a unit holds exactly one deal.
        const { data: st } = await supabaseAdmin
          .from("unit_state")
          .select("held_by_opportunity_id")
          .eq("unit_crm_id", r.unitId)
          .maybeSingle();
        if (st?.held_by_opportunity_id) {
          results.push({ row: r.rowNo, client: r.client, ok: true, detail: `skipped — unit already held by ${st.held_by_opportunity_id}` });
          continue;
        }

        const stageId = data.stageMap[norm(r.status)];
        const body: Record<string, unknown> = {
          pipelineId: data.pipelineId,
          locationId,
          name: `${r.client} — ${r.unitLabel}`,
          pipelineStageId: stageId,
          status: "open",
          contactId: r.contactId,
        };
        if (r.price) body.monetaryValue = r.price;

        const res = await client.request<Record<string, unknown>>("POST", "/opportunities/", { body });
        const d = (res.data ?? {}) as Record<string, unknown>;
        const o = (d.opportunity && typeof d.opportunity === "object" ? d.opportunity : d) as Record<string, unknown>;
        const oppId = typeof o.id === "string" ? o.id : null;
        if (!oppId) throw new Error("CRM did not return an opportunity id");

        // Atomic-ish: an opportunity with no lock is worse than no opportunity,
        // because a retry would create a second one and orphan this card.
        try {
          await client.request("POST", "/associations/relations", {
            body: {
              locationId,
              associationId: lockDef.id,
              firstRecordId: unitIsFirst ? r.unitId : oppId,
              secondRecordId: unitIsFirst ? oppId : r.unitId,
            },
          });
        } catch (assocErr) {
          await client.request("DELETE", `/opportunities/${oppId}`).catch(() => undefined);
          throw new Error(`lock failed, deal rolled back: ${assocErr instanceof Error ? assocErr.message : String(assocErr)}`);
        }

        // The engine's own path: reads the card's live stage and applies it.
        const applied = await applyOpportunityStageToUnit(client, oppId, r.unitId);
        results.push({
          row: r.rowNo,
          client: r.client,
          ok: true,
          detail: `${oppId} · ${applied.outcome}${r.conflict ? ` · ⚠ ${r.conflict}` : ""}`,
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        results.push({ row: r.rowNo, client: r.client, ok: false, detail: msg.slice(0, 240) });
      }
    }

    const nextOffset = data.offset + slice.length;
    return {
      processed: slice.length,
      succeeded: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok),
      results,
      totalDeals: queue.length,
      nextOffset,
      remaining: Math.max(0, queue.length - nextOffset),
    };
  });
