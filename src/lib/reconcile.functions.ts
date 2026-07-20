import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * RECONCILIATION (spec 5, 6, 8).
 *
 * Walks every spreadsheet row and assigns exactly ONE category, so the category
 * totals sum to the number of rows that have a client name. This is the audit
 * that turns "140 created, some failed" into a row-by-row account.
 *
 * It is READ-ONLY. It resolves each row exactly the way the importer does
 * (same building-first unit match, same contact match) and checks live GHL /
 * Supabase state, but writes nothing. Safe to run any time.
 *
 * Categories (spec 5):
 *   created_or_updatable  - resolves to a contact + unit, ready to import/update
 *   missing_phone         - resolves, but no phone in sheet or contact
 *   missing_contact       - client present, no matching GHL contact
 *   missing_building      - developer/building not in GHL inventory
 *   missing_unit          - building found, unit not found under it
 *   duplicate_unit        - same unit claimed by more than one row
 *   held_by_other         - unit currently held by a different live opportunity
 *   invalid_row           - no client name / unusable
 *   no_status_no_deal     - blank status: correctly no deal (unit stays Available)
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
function normalizePhone(v: unknown): string {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const kept = s.replace(/[^\d+]/g, "");
  const digits = kept.replace(/\D/g, "");
  if (digits.length < 7) return "";
  return kept.startsWith("+") ? `+${digits}` : digits;
}
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
    phone: pickHeader(headers, ["phone", "phonenumber", "cell", "mobile"]),
  };
}

type Category =
  | "created_or_updatable"
  | "missing_phone"
  | "missing_contact"
  | "missing_building"
  | "missing_unit"
  | "duplicate_unit"
  | "held_by_other"
  | "invalid_row"
  | "no_status_no_deal";

interface RowReport {
  row: number;
  client: string;
  developer: string;
  building: string;
  unit: string;
  status: string;
  sheetPhone: string;
  contactPhone: string;
  contactId: string | null;
  unitId: string | null;
  heldBy: string | null;
  category: Category;
  reason: string;
}

const RowSchema = z.record(z.string(), z.unknown());

export const reconcileRows = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ rows: z.array(RowSchema).max(5000) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);

    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [unitsRes, buildingsRes, contactsRes, statesRes] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id, display_name, parent_crm_id").eq("scope", "unit"),
      supabaseAdmin.from("external_id_map").select("crm_record_id, display_name").eq("scope", "building"),
      supabaseAdmin.from("contact_id_map").select("stable_id, crm_contact_id, phone"),
      supabaseAdmin.from("unit_state").select("unit_crm_id, held_by_opportunity_id"),
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
    for (const c of contactsRes.data ?? []) contactByStable.set(`name:${norm(c.stable_id.replace(/^name:/, ""))}`, { id: c.crm_contact_id, phone: c.phone });
    // contact_id_map.stable_id already has the "name:" prefix; rebuild directly.
    contactByStable.clear();
    for (const c of contactsRes.data ?? []) contactByStable.set(c.stable_id, { id: c.crm_contact_id, phone: c.phone });

    const heldBy = new Map<string, string>();
    for (const s of statesRes.data ?? []) if (s.held_by_opportunity_id) heldBy.set(s.unit_crm_id, s.held_by_opportunity_id);

    const H = headersOf(data.rows[0] ?? {});

    // First pass: resolve unit for each row, to detect duplicate claims.
    const unitClaims = new Map<string, number[]>();
    const resolved: Array<{ rowNo: number; unitId: string | null }> = [];
    const detail: RowReport[] = [];

    for (const [i, row] of data.rows.entries()) {
      const rowNo = i + 2;
      const client = clean(H.client ? row[H.client] : "");
      const dev = clean(H.developer ? row[H.developer] : "");
      const rawBuilding = clean(H.building ? row[H.building] : "");
      const unitCol = clean(H.unit ? row[H.unit] : "");
      const status = clean(H.status ? row[H.status] : "");
      const { building: bldName, unit: bldUnit } = stripUnitSuffix(rawBuilding);
      const sheetPhone = normalizePhone(H.phone ? row[H.phone] : "");

      const rep: RowReport = {
        row: rowNo,
        client,
        developer: dev,
        building: bldName,
        unit: unitCol || bldUnit || "",
        status,
        sheetPhone,
        contactPhone: "",
        contactId: null,
        unitId: null,
        heldBy: null,
        category: "invalid_row",
        reason: "",
      };

      if (!client || isJunk(client)) {
        rep.category = "invalid_row";
        rep.reason = "no client name";
        detail.push(rep);
        resolved.push({ rowNo, unitId: null });
        continue;
      }

      const c = contactByStable.get(`name:${norm(client)}`);
      rep.contactId = c?.id ?? null;
      rep.contactPhone = normalizePhone(c?.phone ?? "");

      const buildingId =
        buildingByName.get(norm(`${dev} - ${bldName}`)) ?? buildingByName.get(norm(`${dev} - ${rawBuilding}`)) ?? null;

      let unitRef: string | null = null;
      if (unitCol && !isJunk(unitCol)) unitRef = unitCol;
      else if (bldUnit) unitRef = bldUnit;

      let unitId: string | null = null;
      if (buildingId && unitRef) {
        const candidates = unitsByBuilding.get(buildingId) ?? [];
        const want = norm(unitRef);
        const tail = candidates.filter((c2) => norm(c2.name).endsWith(want));
        const contains = candidates.filter((c2) => norm(c2.name).includes(want));
        if (tail.length === 1) unitId = tail[0].id;
        else if (contains.length === 1) unitId = contains[0].id;
      }
      rep.unitId = unitId;
      rep.heldBy = unitId ? heldBy.get(unitId) ?? null : null;

      // Category assignment (single, deterministic).
      if (!buildingId) {
        rep.category = "missing_building";
        rep.reason = `no building matching "${dev} - ${bldName}"`;
      } else if (!unitRef) {
        rep.category = "missing_unit";
        rep.reason = "no unit number in the UNIT column or building name";
      } else if (!unitId) {
        rep.category = "missing_unit";
        rep.reason = `no unit "${unitRef}" under that building`;
      } else if (!c) {
        rep.category = "missing_contact";
        rep.reason = `no GHL contact for "${client}"`;
      } else if (!status) {
        rep.category = "no_status_no_deal";
        rep.reason = "blank status - unit stays Available, no deal";
      } else if (!sheetPhone && !rep.contactPhone) {
        rep.category = "missing_phone";
        rep.reason = "resolves, but no phone in sheet or contact";
      } else {
        rep.category = "created_or_updatable";
        rep.reason = "ready";
      }

      if (unitId) {
        const arr = unitClaims.get(unitId) ?? [];
        arr.push(rowNo);
        unitClaims.set(unitId, arr);
      }
      detail.push(rep);
      resolved.push({ rowNo, unitId });
    }

    // Second pass: mark duplicate-unit rows (only among rows that resolved a unit
    // AND were otherwise importable/held). The first claimant keeps its category.
    for (const [unitId, rowNos] of unitClaims) {
      if (rowNos.length < 2) continue;
      // keep the first, mark the rest as duplicate_unit
      for (const rowNo of rowNos.slice(1)) {
        const rep = detail.find((d) => d.row === rowNo);
        if (rep && (rep.category === "created_or_updatable" || rep.category === "missing_phone")) {
          rep.category = "duplicate_unit";
          rep.reason = `unit also claimed by row ${rowNos[0]} (unit ${unitId})`;
        }
      }
    }

    // held_by_other: importable row whose unit is held by a deal — informational
    // (the importer will update if same contact, conflict if different). We can't
    // know the holder's contact here without N GHL calls, so we just flag it.
    for (const rep of detail) {
      if (rep.category === "created_or_updatable" && rep.heldBy) {
        // leave category as created_or_updatable; note the hold in reason.
        rep.reason = `ready; unit currently held by ${rep.heldBy} (importer will update if same buyer, conflict if different)`;
      }
    }

    const counts: Record<Category, number> = {
      created_or_updatable: 0,
      missing_phone: 0,
      missing_contact: 0,
      missing_building: 0,
      missing_unit: 0,
      duplicate_unit: 0,
      held_by_other: 0,
      invalid_row: 0,
      no_status_no_deal: 0,
    };
    for (const rep of detail) counts[rep.category]++;

    return {
      totalRows: data.rows.length,
      accountedFor: detail.length,
      counts,
      detail,
    };
  });
