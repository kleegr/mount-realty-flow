import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";


async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer") && !roles.includes("viewer")) {
    throw new Error("Forbidden");
  }
}

export type UnitStatus = "available" | "reserved" | "under_contract" | "sold" | "unknown";

export interface UnitReportRow {
  unitCrmId: string;
  unitName: string;
  unitCode: string | null;
  buildingCrmId: string | null;
  buildingName: string | null;
  status: UnitStatus;
  availability: string | null;
  stage: string | null;
  contactName: string | null;
  opportunityId: string | null;
  updatedAt: string | null;
}

function classify(availability: string | null, stage: string | null): UnitStatus {
  const s = (stage ?? "").trim().toLowerCase();
  const a = (availability ?? "").trim().toLowerCase();
  if (s === "closed/sold" || s === "sold" || s === "closed" || a.includes("sold") || a.includes("closed")) return "sold";
  if (s === "under contract" || (a.includes("under") && a.includes("contract"))) return "under_contract";
  if (s === "reserved/locked" || s === "reserved" || s === "locked" || a.includes("reserved") || a.includes("locked")) return "reserved";
  if (a === "available" || a === "" || a === "not available") return a === "available" || a === "" ? "available" : "unknown";
  return "unknown";
}

function statusToState(status: UnitStatus): { availability: string; stage: string } {
  switch (status) {
    case "sold": return { availability: "Not Available", stage: "Closed/Sold" };
    case "under_contract": return { availability: "Not Available", stage: "Under Contract" };
    case "reserved": return { availability: "Not Available", stage: "Reserved/Locked" };
    case "available": return { availability: "Available", stage: "" };
    default: return { availability: "", stage: "" };
  }
}

function extractContactName(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const candidates = [
    r["contact_name"], r["contactName"], r["full_name"], r["fullName"], r["name"],
    r["lead_name"], r["leadName"],
  ];
  for (const c of candidates) if (typeof c === "string" && c.trim()) return c.trim();
  const contact = r["contact"] as Record<string, unknown> | undefined;
  if (contact && typeof contact === "object") {
    const cn = contact["name"] ?? contact["full_name"] ?? contact["fullName"];
    if (typeof cn === "string" && cn.trim()) return cn.trim();
    const first = contact["first_name"] ?? contact["firstName"];
    const last = contact["last_name"] ?? contact["lastName"];
    const joined = [first, last].filter((v) => typeof v === "string" && (v as string).trim()).join(" ").trim();
    if (joined) return joined;
  }
  const first = r["first_name"] ?? r["firstName"];
  const last = r["last_name"] ?? r["lastName"];
  const joined = [first, last].filter((v) => typeof v === "string" && (v as string).trim()).join(" ").trim();
  return joined || null;
}

export const getUnitReport = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ refresh: z.boolean().optional() }).optional().parse(d) ?? {})
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const refresh = data?.refresh === true;

    // SELF-HEAL runs from this page too — this is the page people actually
    // watch. Throttled internally (one real run per ~2 minutes), so the 30s
    // polling loop stays cheap. It prunes deleted records, mirrors every
    // unit's ACTUAL availability/stage from the CRM, and releases any unit
    // whose holding opportunity is deleted / lost / moved to a release stage /
    // no longer holds the Locked association. THE REPORT BELOW IS RENDERED
    // FROM THE HEALED STATE.
    try {
      const { selfHealCrmState } = await import("@/lib/kleegr/release.server");
      await selfHealCrmState(false);
    } catch (err) {
      console.warn("[report] self-heal failed:", err instanceof Error ? err.message : err);
    }


    const [unitsRes, buildingsRes, statesRes, webhooksRes] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id, display_name, code, parent_crm_id").eq("scope", "unit"),
      supabaseAdmin.from("external_id_map").select("crm_record_id, display_name, code").eq("scope", "building"),
      supabaseAdmin.from("unit_state").select("unit_crm_id, availability, stage, updated_at"),
      supabaseAdmin.from("webhook_events").select("unit_crm_id, opportunity_id, raw, received_at").not("unit_crm_id", "is", null).order("received_at", { ascending: false }).limit(2000),
    ]);

    const buildingMap = new Map<string, { name: string; code: string | null }>();
    for (const b of buildingsRes.data ?? []) {
      buildingMap.set(b.crm_record_id, { name: b.display_name ?? "(unnamed)", code: b.code });
    }

    const stateMap = new Map<string, { availability: string | null; stage: string | null; updated_at: string | null }>();
    for (const s of statesRes.data ?? []) {
      stateMap.set(s.unit_crm_id, { availability: s.availability, stage: s.stage, updated_at: s.updated_at });
    }

    // latest contact per unit (from webhook events, if any)
    const contactMap = new Map<string, { contactName: string | null; opportunityId: string | null }>();
    for (const w of webhooksRes.data ?? []) {
      if (!w.unit_crm_id || contactMap.has(w.unit_crm_id)) continue;
      contactMap.set(w.unit_crm_id, {
        contactName: extractContactName(w.raw),
        opportunityId: w.opportunity_id ?? null,
      });
    }

    // Enrich with live CRM opportunities → contact/lead name + live status per unit.
    // Only on explicit refresh; on auto-loads we serve the cached snapshot fast.
    // NOTE: this can both LOCK (deal sits in a locking stage) and RELEASE (deal
    // sits in a release stage) now that classifyLead knows the full release
    // list — previously it could only ever lock, which made the report a
    // one-way ratchet.
    if (refresh) {
      const liveStatus = new Map<string, UnitStatus>();
      try {
        const { fetchUnitLeadsMap } = await import("@/lib/kleegr/opportunity-leads.server");
        const leads = await fetchUnitLeadsMap();
        for (const [unitId, lead] of leads) {
          const existing = contactMap.get(unitId);
          if (!existing?.contactName && lead.contactName) {
            contactMap.set(unitId, { contactName: lead.contactName, opportunityId: lead.opportunityId });
          }
          if (lead.status && lead.status !== "unknown") {
            liveStatus.set(unitId, lead.status);
          }
        }
      } catch (err) {
        console.warn("[report] lead enrichment failed:", err instanceof Error ? err.message : err);
      }

      const stateUpserts: Array<{ unit_crm_id: string; availability: string; stage: string }> = [];
      for (const [unitId, status] of liveStatus) {
        const prev = stateMap.get(unitId);
        // Sold is terminal for automated paths — never let live enrichment undo it.
        if ((prev?.stage ?? "").trim() === "Closed/Sold" && status !== "sold") continue;
        const prevStatus = classify(prev?.availability ?? null, prev?.stage ?? null);
        if (prevStatus === status) continue;
        const target = statusToState(status);
        stateUpserts.push({ unit_crm_id: unitId, ...target });
        stateMap.set(unitId, { ...target, updated_at: new Date().toISOString() });
      }
      if (stateUpserts.length > 0) {
        await supabaseAdmin.from("unit_state").upsert(stateUpserts, { onConflict: "unit_crm_id" });
      }
    }


    const rows: UnitReportRow[] = (unitsRes.data ?? []).map((u) => {
      const state = stateMap.get(u.crm_record_id);
      const contact = contactMap.get(u.crm_record_id);
      const building = u.parent_crm_id ? buildingMap.get(u.parent_crm_id) : null;
      return {
        unitCrmId: u.crm_record_id,
        unitName: u.display_name ?? "(unnamed)",
        unitCode: u.code,
        buildingCrmId: u.parent_crm_id,
        buildingName: building?.name ?? null,
        status: classify(state?.availability ?? null, state?.stage ?? null),
        availability: state?.availability ?? null,
        stage: state?.stage ?? null,
        contactName: contact?.contactName ?? null,
        opportunityId: contact?.opportunityId ?? null,
        updatedAt: state?.updated_at ?? null,
      };
    });

    const totals = { available: 0, reserved: 0, under_contract: 0, sold: 0, unknown: 0, total: rows.length };
    for (const r of rows) totals[r.status]++;

    rows.sort((a, b) => a.unitName.localeCompare(b.unitName));
    return { rows, totals };
  });
