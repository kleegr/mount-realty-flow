import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * OPPORTUNITY IMPORT.
 *
 * TWO KINDS OF ROW (owner spec):
 *  - STATUS rows (Under Contract / Reserved / Closed): deal at the mapped
 *    stage + unit LOCKED (Locked/Reserved association) + payment fields. The
 *    unit's own status follows the deal.
 *  - BLANK-STATUS rows with a client: an interested buyer, not a commitment.
 *    Deal at New Inquiry / Initial Call + unit attached as SUGGESTED (not
 *    locked). The unit stays Available. One inquiry deal per contact - blank
 *    rows for the same buyer add more suggested units to the same deal, and
 *    re-runs never duplicate it.
 *
 * RE-RUNNABLE. A locked unit already held is decided by WHO holds it:
 *  same buyer -> update in place; different live buyer -> conflict, touch
 *  nothing; dead holder -> clear stale hold and create fresh.
 *
 * THE NAME is "{contact name} - {phone}" from the GHL CONTACT (sheet phone as
 * fallback), phone in US format e.g. (347) 786-0323.
 *
 * PAYMENT FIELDS map by name/alias; first write is read back (GHL 200s and
 * silently drops unknown payloads). Blank cells never erase existing values.
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

/** Digits-and-plus phone, for COMPARISON. Empty if nothing usable. */
function normalizePhone(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const kept = s.replace(/[^\d+]/g, "");
  const digits = kept.replace(/\D/g, "");
  if (digits.length < 7) return "";
  return kept.startsWith("+") ? `+${digits}` : digits;
}

/** US display format: 3477860323 / 13477860323 / +1347... -> (347) 786-0323. */
function formatUsPhone(normalized: string): string {
  if (!normalized) return "";
  const hadPlus = normalized.startsWith("+");
  let digits = normalized.replace(/\D/g, "");
  if (digits.length === 11 && digits.startsWith("1")) digits = digits.slice(1);
  if (digits.length === 10) {
    return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  }
  return hadPlus ? `+${digits}` : digits;
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
    phone: pickHeader(headers, ["phone", "phonenumber", "cell", "mobile"]),
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

const DEAL_ALIASES: Record<string, string> = {
  remaningd: "Remaining Payment",
  remaining: "Remaining Payment",
  remainingd: "Remaining Payment",
  remainingpayment: "Remaining Payment",
  downpayment: "Down Payment",
  paidamount: "Paid Amount",
  datesigned: "Date Signed",
  executed: "Executed",
  duedate: "Due Date",
};

function mapDealColumns(headers: string[], fields: OppField[]): OppColumnMap[] {
  return headers
    .filter((h) => !STRUCTURAL.has(norm(h)) && norm(h))
    .map((h) => {
      const n = norm(h);
      const aliasTarget = DEAL_ALIASES[n];
      const f = fields.find((x) => {
        const byName = norm(x.name) === n || norm(x.fieldKey.replace(/^opportunity\./, "")) === n;
        const byAlias = aliasTarget ? norm(x.name) === norm(aliasTarget) : false;
        return byName || byAlias;
      });
      return {
        header: h,
        fieldId: f?.id ?? null,
        fieldName: f?.name ?? "(no matching opportunity field)",
        dataType: f?.dataType ?? null,
      };
    });
}

/** ISO-ify a date-ish string for a GHL DATE field. Returns null if unparseable. */
function toIsoDate(v: unknown): string | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return new Date(t).toISOString().slice(0, 10);
}

/** Convert a sheet value to the shape a given GHL field wants, or null to skip. */
function fieldValueFor(f: OppField, v: unknown): unknown | null {
  if (isJunk(v)) return null;
  if (f.options.length > 0) {
    const exact = resolveOption(f, v);
    if (!exact) return null;
    return f.dataType === "MULTIPLE_OPTIONS" ? [exact] : exact;
  }
  if (/date/i.test(f.dataType)) {
    return toIsoDate(v);
  }
  if (/monet/i.test(f.dataType) || /numer/i.test(f.dataType)) {
    const n = Number(String(v).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return String(v).trim();
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

    const firstStages = pipelines.map((p) => ({
      pipelineId: p.id,
      pipelineName: p.name,
      firstStage: p.stages[0] ?? null,
    }));

    return {
      locationId: String(locationId ?? ""),
      pipelines,
      firstStages,
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
  contactByStable: Map<string, { id: string; phone: string | null; name: string | null }>;
}

async function loadMaps(): Promise<Maps> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const [unitsRes, buildingsRes, contactsRes] = await Promise.all([
    supabaseAdmin.from("external_id_map").select("crm_record_id, display_name, parent_crm_id").eq("scope", "unit"),
    supabaseAdmin.from("external_id_map").select("crm_record_id, display_name").eq("scope", "building"),
    supabaseAdmin.from("contact_id_map").select("stable_id, crm_contact_id, phone, display_name"),
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

  const contactByStable = new Map<string, { id: string; phone: string | null; name: string | null }>();
  for (const c of contactsRes.data ?? []) {
    const rec = c as Record<string, unknown>;
    contactByStable.set(String(rec.stable_id), {
      id: String(rec.crm_contact_id),
      phone: (rec.phone as string | null) ?? null,
      name: (rec.display_name as string | null) ?? null,
    });
  }

  return { buildingByName, unitsByBuilding, contactByStable };
}

interface Resolved {
  rowNo: number;
  client: string;
  contactName: string | null;
  status: string;
  contactId: string | null;
  sheetPhone: string;
  contactPhone: string;
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
    contactName: c?.name ?? null,
    status: clean(H.status ? row[H.status] : ""),
    contactId: c?.id ?? null,
    sheetPhone: normalizePhone(H.phone ? row[H.phone] : ""),
    contactPhone: normalizePhone(c?.phone ?? ""),
    unitId,
    unitLabel: `${bldName} ${unitRef ?? ""}`.trim(),
    price: H.price ? money(row[H.price]) : null,
    why,
    conflict,
    raw: row,
  };
}

/**
 * Deal name = the CONTACT's name + the CONTACT's phone as they appear on the
 * GHL contact (owner spec). Sheet values are only fallbacks for missing
 * contact data. Phone shown in US format.
 */
function buildName(r: Resolved): { name: string; missingPhone: boolean } {
  const displayName = (r.contactName ?? "").trim() || r.client;
  const rawPhone = r.contactPhone || r.sheetPhone;
  const pretty = formatUsPhone(rawPhone);
  return { name: pretty ? `${displayName} - ${pretty}` : displayName, missingPhone: !pretty };
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
    let missingPhone = 0;
    let blankStatusInquiries = 0;
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
      if (!r.status) blankStatusInquiries++;
      if (r.contactId) contactHit++;
      else if (unresolvedContacts.length < 40) unresolvedContacts.push({ row: r.rowNo, name: r.client });
      const { missingPhone: mp } = buildName(r);
      if (mp) missingPhone++;
      else withPhone++;
      if (r.conflict && conflicts.length < 40) conflicts.push({ row: r.rowNo, detail: r.conflict });
      if (r.unitId) {
        unitHit++;
        if (r.status) {
          const arr = claims.get(r.unitId) ?? [];
          arr.push(`row ${r.rowNo}: ${r.client}`);
          claims.set(r.unitId, arr);
        }
      } else if (unresolvedUnits.length < 40) {
        unresolvedUnits.push({ row: r.rowNo, key: r.unitLabel, why: r.why });
      }
    }

    const doubleClaimed = [...claims.entries()]
      .filter(([, rs]) => rs.length > 1)
      .map(([unitId, rows]) => ({ unitId, rows }))
      .slice(0, 30);

    return {
      totalRows: data.rows.length,
      headersFound: H,
      statusCounts,
      withClient,
      contactHit,
      unitHit,
      withPhone,
      missingPhone,
      blankStatusInquiries,
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
        // Stage for blank-status client rows (New Inquiry / Initial Call).
        // When absent, blank-status rows are skipped (legacy behaviour).
        newInquiryStageId: z.string().optional(),
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

    // Suggested association - the browsing label for New Inquiry rows.
    const suggestDef = (defsRes.data?.associations ?? []).find((d) => norm(d.key).includes("suggested"));
    const suggestUnitIsFirst = suggestDef ? norm(suggestDef.firstObjectKey).includes("unit") : true;

    const H = headersOf(data.rows[0] ?? {});
    const m = await loadMaps();
    const oppFields = await loadOpportunityFields(client as never).catch(() => [] as OppField[]);
    const dealColumns = mapDealColumns(Object.keys(data.rows[0] ?? {}), oppFields).filter((c) => c.fieldId);

    type QueueItem = Resolved & { mode: "locked" | "inquiry" };
    const queue: QueueItem[] = [];
    for (const [i, row] of data.rows.entries()) {
      const r = resolveRow(row, i, H, m);
      if (!r) continue;
      const stageId = data.stageMap[norm(r.status)];
      if (stageId) queue.push({ ...r, mode: "locked" });
      else if (!r.status && data.newInquiryStageId) queue.push({ ...r, mode: "inquiry" });
      // Unknown non-blank statuses are skipped, as before.
    }

    const slice = queue.slice(data.offset, data.offset + data.limit);
    const results: Array<{ row: number; client: string; ok: boolean; action: string; detail: string }> = [];
    let verified = data.offset > 0;

    const buildCustomFields = (r: Resolved): { fields: Array<{ id: string; value: unknown }>; warnings: string[] } => {
      const fields: Array<{ id: string; value: unknown }> = [];
      const warnings: string[] = [];
      for (const col of dealColumns) {
        const f = oppFields.find((x) => x.id === col.fieldId);
        if (!f) continue;
        const val = fieldValueFor(f, r.raw[col.header]);
        if (val === null) {
          if (!isJunk(r.raw[col.header])) warnings.push(`${f.name}: could not use "${String(r.raw[col.header])}"`);
          continue;
        }
        fields.push({ id: f.id, value: val });
      }
      return { fields, warnings };
    };

    /** Find this contact's existing deal at the New Inquiry stage (re-run safety). */
    const findExistingInquiry = async (contactId: string): Promise<string | null> => {
      try {
        const sr = await client.request<{ opportunities?: Array<Record<string, unknown>> }>(
          "GET",
          "/opportunities/search",
          { query: { location_id: String(locationId), contact_id: contactId, limit: 20 } },
        );
        const opps = Array.isArray(sr.data?.opportunities) ? sr.data.opportunities : [];
        const match = opps.find(
          (o) =>
            String(o.pipelineId ?? o.pipeline_id ?? "") === data.pipelineId &&
            String(o.pipelineStageId ?? o.stageId ?? o.pipeline_stage_id ?? "") === data.newInquiryStageId,
        );
        return match && typeof match.id === "string" ? match.id : null;
      } catch {
        return null; // search failure -> create (worst case a re-run makes one duplicate inquiry, visible in report)
      }
    };

    for (const r of slice) {
      try {
        if (!r.contactId) throw new Error(`no contact for "${r.client}" - import contacts first`);

        const { name: dealName, missingPhone } = buildName(r);

        // ================= INQUIRY (blank status): New Inquiry + Suggested =================
        if (r.mode === "inquiry") {
          let oppId = await findExistingInquiry(r.contactId);
          let action = "Inquiry updated";
          if (!oppId) {
            const body: Record<string, unknown> = {
              pipelineId: data.pipelineId,
              locationId,
              name: dealName,
              pipelineStageId: data.newInquiryStageId,
              status: "open",
              contactId: r.contactId,
            };
            const res = await client.request<Record<string, unknown>>("POST", "/opportunities/", { body });
            const d = (res.data ?? {}) as Record<string, unknown>;
            const o = (d.opportunity && typeof d.opportunity === "object" ? d.opportunity : d) as Record<string, unknown>;
            oppId = typeof o.id === "string" ? o.id : null;
            if (!oppId) throw new Error("CRM did not return an opportunity id");
            action = "Inquiry created";
          } else {
            await client.request("PUT", `/opportunities/${oppId}`, { body: { name: dealName } });
          }

          // Attach the unit as SUGGESTED (not locked). Duplicate relations are
          // fine to ignore - the label either exists or gets created.
          let suggestNote = "no unit to suggest";
          if (r.unitId && suggestDef?.id) {
            await client
              .request("POST", "/associations/relations", {
                body: {
                  locationId,
                  associationId: suggestDef.id,
                  firstRecordId: suggestUnitIsFirst ? r.unitId : oppId,
                  secondRecordId: suggestUnitIsFirst ? oppId : r.unitId,
                },
              })
              .then(
                () => { suggestNote = "suggested unit attached"; },
                () => { suggestNote = "suggested (already attached)"; },
              );
          } else if (r.unitId && !suggestDef?.id) {
            suggestNote = "NO Suggested association defined in GHL - unit not attached";
          }

          const tags = [suggestNote, ...(missingPhone ? ["Missing Phone"] : [])];
          results.push({ row: r.rowNo, client: r.client, ok: true, action, detail: `${oppId} - ${tags.join(" - ")}` });
          continue;
        }

        // ================= LOCKED (status rows) =================
        if (!r.unitId) throw new Error(r.why || "unit not resolved");

        const { fields: customFields, warnings } = buildCustomFields(r);

        const { data: st } = await supabaseAdmin
          .from("unit_state")
          .select("held_by_opportunity_id")
          .eq("unit_crm_id", r.unitId)
          .maybeSingle();
        const holder = st?.held_by_opportunity_id as string | undefined;

        if (holder) {
          let holderDeal: Record<string, unknown> | null = null;
          try {
            const hRes = await client.request<Record<string, unknown>>("GET", `/opportunities/${holder}`, {});
            const hd = (hRes.data ?? {}) as Record<string, unknown>;
            holderDeal = (hd.opportunity && typeof hd.opportunity === "object" ? hd.opportunity : hd) as Record<
              string,
              unknown
            >;
          } catch (err) {
            const status = (err as { status?: number })?.status;
            if (status !== 404 && status !== 400) throw err;
            holderDeal = null;
          }

          if (holderDeal) {
            const holderContact =
              (typeof holderDeal.contactId === "string" && holderDeal.contactId) ||
              (typeof holderDeal.contact_id === "string" && holderDeal.contact_id) ||
              (holderDeal.contact && typeof holderDeal.contact === "object"
                ? String((holderDeal.contact as Record<string, unknown>).id ?? "")
                : "");

            if (holderContact && holderContact !== r.contactId) {
              results.push({
                row: r.rowNo,
                client: r.client,
                ok: false,
                action: "Conflict",
                detail: `unit held by a DIFFERENT opportunity ${holder} (contact ${holderContact}); this row is contact ${r.contactId}. Manual resolution required.`,
              });
              continue;
            }

            const body: Record<string, unknown> = { name: dealName };
            if (r.price) body.monetaryValue = r.price;
            if (customFields.length) body.customFields = customFields;
            await client.request("PUT", `/opportunities/${holder}`, { body });

            const tags = [
              ...(missingPhone ? ["Missing Phone"] : []),
              ...(r.conflict ? [`WARNING ${r.conflict}`] : []),
              ...warnings,
            ];
            results.push({
              row: r.rowNo,
              client: r.client,
              ok: true,
              action: "Updated Existing Opportunity",
              detail: `${holder} -> "${dealName}"${tags.length ? ` - ${tags.join(" - ")}` : ""}`,
            });
            continue;
          }

          await supabaseAdmin
            .from("unit_state")
            .update({ held_by_opportunity_id: null })
            .eq("unit_crm_id", r.unitId);
        }

        // ---- Create a new deal + lock. ----
        const body: Record<string, unknown> = {
          pipelineId: data.pipelineId,
          locationId,
          name: dealName,
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
                `Read back: ${JSON.stringify(got).slice(0, 250)}`,
            );
          }
          verified = true;
        }

        const applied = await applyOpportunityStageToUnit(client, oppId, r.unitId);
        const tags = [
          applied.outcome,
          ...(missingPhone ? ["Missing Phone"] : []),
          ...(r.conflict ? [`WARNING ${r.conflict}`] : []),
          ...warnings,
        ];
        results.push({
          row: r.rowNo,
          client: r.client,
          ok: true,
          action: "Opportunity created",
          detail: `${oppId} - ${tags.join(" - ")}`,
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        results.push({ row: r.rowNo, client: r.client, ok: false, action: "Failed", detail: msg.slice(0, 240) });
        if (/ABORTED AFTER ONE ROW/.test(raw)) break;
      }
    }

    const nextOffset = data.offset + slice.length;
    return {
      processed: slice.length,
      succeeded: results.filter((x) => x.ok).length,
      created: results.filter((x) => x.action === "Opportunity created").length,
      updated: results.filter((x) => x.action === "Updated Existing Opportunity").length,
      inquiries: results.filter((x) => x.action.startsWith("Inquiry")).length,
      conflicts: results.filter((x) => x.action === "Conflict").length,
      failed: results.filter((x) => !x.ok),
      results,
      dealFieldsMapped: dealColumns.length,
      totalDeals: queue.length,
      nextOffset,
      remaining: Math.max(0, queue.length - nextOffset),
    };
  });
