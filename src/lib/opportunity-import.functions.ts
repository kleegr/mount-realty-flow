import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * OPPORTUNITY IMPORT.
 *
 * RESOLUTION. The sheet's Building column carries the unit number glued on the
 * end ("10 Chesnut Drive # 101") while GHL's building is "10 Chesnut Drive".
 * That single pattern was why the first dry run only resolved 118/183.
 *
 * Units match BUILDING-FIRST: unit names are
 * "{DEVELOPER} - {BUILDING} - {UNIT} {NUMBER}", so matching "101" globally would
 * hit every building with a 101. Resolving the building narrows it to that
 * building's ~4 units. Only possible because parent_crm_id was repaired.
 *
 * THE LOCK. The Locked/Reserved association is the ON switch - the stage map
 * does nothing without it. The definition says units are FIRST:
 *   firstObjectKey: custom_objects.units, secondObjectKey: opportunity
 * Passing the opportunity first is what produced "Invalid record id" earlier.
 *
 * IDEMPOTENCY WITHOUT A NEW TABLE. A unit locks to exactly ONE opportunity, so
 * unit_state.held_by_opportunity_id IS the resume state: held means done.
 *
 * ATOMIC PER ROW. If the lock fails after the deal is created, the deal is
 * DELETED. Otherwise a retry sees a free unit, creates a second deal, and
 * orphans the first.
 *
 * THE NAME is the contact's full name plus their full phone. The unit is NOT in
 * the name: it is already on the association, and duplicating it there means two
 * places to disagree.
 *
 * PAYMENT FIELDS ARE SCHEMA-DRIVEN. The deal-level columns (Date Signed,
 * Executed, Down Payment, Paid Amount, Remaining, Receipt #, Payment Type,
 * % Paid, Notes) were deliberately blocked from the contact import - one buyer
 * with six units has six different payment schedules, so they cannot live on the
 * person. They belong here. Field keys and picklist values are read live from
 * GHL and matched case/punctuation-insensitively, and the FIRST write is read
 * back: GHL 200s an unknown custom-field payload and silently drops it, so
 * without the check the happy path is "186 deals imported" with no payment data
 * on any of them.
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

/** Columns that identify the row rather than describe the deal. */
const STRUCTURAL = new Set([
  "developer", "project", "builder", "building", "buildingname", "unit", "unitnumber", "unitno", "apt",
  "status", "unitstatus", "clientname", "client", "buyer", "buyername", "phone", "email", "father",
  "fatherinlaw", "saleprice", "floor1", "floor2", "empty",
]);

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

// ---------------------------------------------------------------- opp schema

interface OppField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
  options: string[];
}

async function loadOpportunityFields(client: {
  config: { location_id: string | null };
  request: <T>(m: "GET", p: string, o?: { query?: Record<string, string> }) => Promise<{ data: T }>;
}): Promise<OppField[]> {
  const locationId = client.config.location_id;
  if (!locationId) return [];
  const res = await client.request<{ customFields?: Array<Record<string, unknown>> }>(
    "GET",
    `/locations/${locationId}/customFields`,
    { query: { model: "opportunity" } },
  );
  const all = Array.isArray(res.data?.customFields) ? res.data.customFields : [];
  return all
    .filter((f) => /opportunity/i.test(String(f.model ?? "")) || /^opportunity\./.test(String(f.fieldKey ?? "")))
    .map((f) => {
      const raw = (f.picklistOptions ?? f.picklistOptionValues ?? f.options) as unknown;
      const options = Array.isArray(raw)
        ? raw
            .map((o) => {
              if (typeof o === "string") return o;
              if (o && typeof o === "object") {
                const r = o as Record<string, unknown>;
                const v = r.value ?? r.name ?? r.label ?? r.key;
                return typeof v === "string" ? v : null;
              }
              return null;
            })
            .filter((v): v is string => Boolean(v))
        : [];
      return {
        id: String(f.id ?? ""),
        name: String(f.name ?? ""),
        fieldKey: String(f.fieldKey ?? ""),
        dataType: String(f.dataType ?? ""),
        options,
      };
    });
}

function resolveOption(f: OppField, value: unknown): string | null {
  const n = norm(value);
  if (!n) return null;
  return f.options.find((o) => norm(o) === n) ?? null;
}

export interface OppColumnMap {
  header: string;
  fieldId: string | null;
  fieldName: string;
  dataType: string | null;
}

/** Map every non-structural column onto a live opportunity field, by name. */
function mapDealColumns(headers: string[], fields: OppField[]): OppColumnMap[] {
  return headers
    .filter((h) => !STRUCTURAL.has(norm(h)) && norm(h))
    .map((h) => {
      const n = norm(h);
      const f = fields.find((x) => norm(x.name) === n || norm(x.fieldKey.replace(/^opportunity\./, "")) === n);
      return {
        header: h,
        fieldId: f?.id ?? null,
        fieldName: f?.name ?? "(no matching opportunity field)",
        dataType: f?.dataType ?? null,
      };
    });
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

    let oppFields: OppField[] = [];
    let fieldsError: string | null = null;
    try {
      oppFields = await loadOpportunityFields(client as never);
    } catch (err) {
      fieldsError = err instanceof Error ? err.message.slice(0, 300) : String(err);
    }

    const [{ count: contacts }, { count: units }] = await Promise.all([
      supabaseAdmin.from("contact_id_map").select("stable_id", { count: "exact", head: true }),
      supabaseAdmin.from("external_id_map").select("crm_record_id", { count: "exact", head: true }).eq("scope", "unit"),
    ]);

    return {
      pipelines,
      crmError,
      opportunityFields: oppFields.map((f) => ({
        id: f.id,
        name: f.name,
        key: f.fieldKey,
        dataType: f.dataType,
        options: f.options,
      })),
      fieldsError,
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
  contactByStable: Map<string, { id: string; phone: string | null }>;
}

async function loadMaps(): Promise<Maps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [unitsRes, buildingsRes, contactsRes] = await Promise.all([
    supabaseAdmin.from("external_id_map").select("crm_record_id, display_name, parent_crm_id").eq("scope", "unit"),
    supabaseAdmin.from("external_id_map").select("crm_record_id, display_name").eq("scope", "building"),
    supabaseAdmin.from("contact_id_map").select("stable_id, crm_contact_id, phone"),
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

  const contactByStable = new Map<string, { id: string; phone: string | null }>();
  for (const c of contactsRes.data ?? []) contactByStable.set(c.stable_id, { id: c.crm_contact_id, phone: c.phone });

  return { buildingByName, unitsByBuilding, contactByStable };
}

interface Resolved {
  rowNo: number;
  client: string;
  status: string;
  contactId: string | null;
  phone: string | null;
  unitId: string | null;
  unitLabel: string;
  price: number | null;
  why: string;
  conflict: string | null;
  raw: Record<string, unknown>;
}

function resolveRow(row: Record<string, unknown>, i: number, H: ReturnType<typeof headersOf>, m: Maps): Resolved | null {
  const rowNo = i + 2;
  const clientName = clean(H.client ? row[H.client] : "");
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

  const c = m.contactByStable.get(`name:${norm(clientName)}`);
  return {
    rowNo,
    client: clientName,
    status: clean(H.status ? row[H.status] : ""),
    contactId: c?.id ?? null,
    phone: c?.phone ?? null,
    unitId,
    unitLabel: `${bldName} ${unitRef ?? ""}`.trim(),
    price: H.price ? money(row[H.price]) : null,
    why,
    conflict,
    raw: row,
  };
}

// ---------------------------------------------------------------- preview

const RowSchema = z.record(z.string(), z.unknown());

export const previewOpportunityImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ rows: z.array(RowSchema).max(5000) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();

    const H = headersOf(data.rows[0] ?? {});
    const m = await loadMaps();

    let oppFields: OppField[] = [];
    try {
      oppFields = await loadOpportunityFields(client as never);
    } catch {
      oppFields = [];
    }
    const dealColumns = mapDealColumns(Object.keys(data.rows[0] ?? {}), oppFields);

    const statusCounts: Record<string, number> = {};
    let withClient = 0;
    let contactHit = 0;
    let unitHit = 0;
    let withPhone = 0;
    const unresolvedUnits: Array<{ row: number; key: string; why: string }> = [];
    const unresolvedContacts: Array<{ row: number; name: string }> = [];
    const conflicts: Array<{ row: number; detail: string }> = [];
    const claims = new Map<string, string[]>();

    for (const [i, row] of data.rows.entries()) {
      const status = clean(H.status ? row[H.status] : "");
      statusCounts[status || "(blank)"] = (statusCounts[status || "(blank)"] ?? 0) + 1;
      const r = resolveRow(row, i, H, m);
      if (!r) continue;
      withClient++;
      if (r.contactId) contactHit++;
      else if (unresolvedContacts.length < 30) unresolvedContacts.push({ row: r.rowNo, name: r.client });
      if (r.phone) withPhone++;
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

    const doubleClaimed = [...claims.entries()]
      .filter(([, rs]) => rs.length > 1)
      .map(([unitId, rows]) => ({ unitId, rows }))
      .slice(0, 20);

    return {
      totalRows: data.rows.length,
      headersFound: H,
      statusCounts,
      withClient,
      contactHit,
      unitHit,
      withPhone,
      importable: Math.min(contactHit, unitHit),
      dealColumns,
      opportunityFieldCount: oppFields.length,
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

    const defsRes = await client.request<{ associations?: Array<Record<string, unknown>> }>("GET", "/associations/", {
      query: { locationId: String(locationId), skip: 0, limit: 100 },
    });
    const lockDef = (defsRes.data?.associations ?? []).find((d) => norm(d.key) === norm("lockedreserved_units"));
    if (!lockDef?.id) {
      throw new Error(
        "No Locked/Reserved Units association is defined in GHL. Without it the stage map does nothing and every unit stays Available.",
      );
    }
    const unitIsFirst = norm(lockDef.firstObjectKey).includes("unit");

    const H = headersOf(data.rows[0] ?? {});
    const m = await loadMaps();
    const oppFields = await loadOpportunityFields(client as never).catch(() => [] as OppField[]);
    const dealColumns = mapDealColumns(Object.keys(data.rows[0] ?? {}), oppFields).filter((c) => c.fieldId);

    const queue: Resolved[] = [];
    for (const [i, row] of data.rows.entries()) {
      const r = resolveRow(row, i, H, m);
      if (!r) continue;
      if (!data.stageMap[norm(r.status)]) continue;
      queue.push(r);
    }

    const slice = queue.slice(data.offset, data.offset + data.limit);
    const results: Array<{ row: number; client: string; ok: boolean; detail: string }> = [];
    let verified = data.offset > 0;

    for (const r of slice) {
      try {
        if (!r.contactId) throw new Error(`no contact for "${r.client}" - import contacts first`);
        if (!r.unitId) throw new Error(r.why || "unit not resolved");

        const { data: st } = await supabaseAdmin
          .from("unit_state")
          .select("held_by_opportunity_id")
          .eq("unit_crm_id", r.unitId)
          .maybeSingle();
        if (st?.held_by_opportunity_id) {
          results.push({
            row: r.rowNo,
            client: r.client,
            ok: true,
            detail: `skipped - unit already held by ${st.held_by_opportunity_id}`,
          });
          continue;
        }

        // ---- payment / deal fields, against the REAL schema
        const customFields: Array<{ id: string; value: unknown }> = [];
        const warnings: string[] = [];
        for (const col of dealColumns) {
          const v = r.raw[col.header];
          if (isJunk(v)) continue;
          const f = oppFields.find((x) => x.id === col.fieldId);
          if (!f) continue;
          if (f.options.length > 0) {
            const exact = resolveOption(f, v);
            if (!exact) {
              warnings.push(`${f.name}: "${String(v)}" not in [${f.options.join(", ")}]`);
              continue;
            }
            customFields.push({ id: f.id, value: f.dataType === "MULTIPLE_OPTIONS" ? [exact] : exact });
          } else {
            customFields.push({ id: f.id, value: String(v).trim() });
          }
        }

        // Name = full contact name + full phone. No unit: it lives on the association.
        const namePhone = r.phone ? ` ${r.phone}` : "";
        const body: Record<string, unknown> = {
          pipelineId: data.pipelineId,
          locationId,
          name: `${r.client}${namePhone}`,
          pipelineStageId: data.stageMap[norm(r.status)],
          status: "open",
          contactId: r.contactId,
        };
        if (r.price) body.monetaryValue = r.price;
        if (customFields.length) body.customFields = customFields;

        const res = await client.request<Record<string, unknown>>("POST", "/opportunities/", { body });
        const d = (res.data ?? {}) as Record<string, unknown>;
        const o = (d.opportunity && typeof d.opportunity === "object" ? d.opportunity : d) as Record<string, unknown>;
        const oppId = typeof o.id === "string" ? o.id : null;
        if (!oppId) throw new Error("CRM did not return an opportunity id");

        // An unlocked deal is worse than no deal: a retry would create a second
        // one and orphan this card. So roll back rather than leave it.
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
          throw new Error(
            `lock failed, deal rolled back: ${assocErr instanceof Error ? assocErr.message : String(assocErr)}`,
          );
        }

        // VERIFY THE FIRST WRITE. GHL 200s an unknown custom-field payload and
        // drops it silently - without this, 186 deals import with no payment data.
        if (!verified && customFields.length > 0) {
          const back = await client.request<Record<string, unknown>>("GET", `/opportunities/${oppId}`);
          const bd = (back.data ?? {}) as Record<string, unknown>;
          const bo = (bd.opportunity && typeof bd.opportunity === "object" ? bd.opportunity : bd) as Record<
            string,
            unknown
          >;
          const got = Array.isArray(bo.customFields) ? (bo.customFields as Array<Record<string, unknown>>) : [];
          const landed = customFields.filter((cf) => got.some((g) => g.id === cf.id));
          if (landed.length === 0) {
            throw new Error(
              `ABORTED AFTER ONE ROW. Sent ${customFields.length} payment fields; GHL returned 200 but stored none. ` +
                `Fix the payload shape before importing 186 deals. Read back: ${JSON.stringify(got).slice(0, 250)}`,
            );
          }
          verified = true;
        }

        const applied = await applyOpportunityStageToUnit(client, oppId, r.unitId);
        const notes = [applied.outcome, ...(r.conflict ? [`WARNING ${r.conflict}`] : []), ...warnings];
        results.push({ row: r.rowNo, client: r.client, ok: true, detail: `${oppId} - ${notes.join(" - ")}` });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        results.push({ row: r.rowNo, client: r.client, ok: false, detail: msg.slice(0, 240) });
        if (/ABORTED AFTER ONE ROW/.test(raw)) break;
      }
    }

    const nextOffset = data.offset + slice.length;
    return {
      processed: slice.length,
      succeeded: results.filter((x) => x.ok).length,
      failed: results.filter((x) => !x.ok),
      results,
      dealFieldsMapped: dealColumns.length,
      totalDeals: queue.length,
      nextOffset,
      remaining: Math.max(0, queue.length - nextOffset),
    };
  });
