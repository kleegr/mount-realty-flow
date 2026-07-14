/**
 * Fetch opportunities from GHL and map contact/lead name → unit CRM id.
 * Server-only. Used by the Unit Report to display the lead that reserved a unit.
 */
import { createCrmClient } from "./client.server";
import { fetchOpportunityAssociations } from "./opportunities.server";

export type LeadStatus = "available" | "reserved" | "under_contract" | "sold" | "unknown";

export interface UnitLead {
  contactName: string | null;
  opportunityId: string;
  opportunityName: string | null;
  stageName: string | null;
  stageId: string | null;
  pipelineId: string | null;
  status: LeadStatus;
}

interface PipelineMap {
  reserved_ids: Set<string>;
  under_contract_ids: Set<string>;
  closed_ids: Set<string>;
  release_ids: Set<string>;
  reserved_names: Set<string>;
  under_contract_names: Set<string>;
  closed_names: Set<string>;
  release_names: Set<string>;
}

async function loadPipelineMap(): Promise<PipelineMap> {
  const empty: PipelineMap = {
    reserved_ids: new Set(), under_contract_ids: new Set(), closed_ids: new Set(), release_ids: new Set(),
    reserved_names: new Set(), under_contract_names: new Set(), closed_names: new Set(), release_names: new Set(),
  };
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin.from("crm_pipelines").select(
      "stage_reserved_id, stage_under_contract_id, stage_closed_id, stage_release_id, stage_reserved_name, stage_under_contract_name, stage_closed_name, stage_release_name",
    );
    for (const r of data ?? []) {
      if (r.stage_reserved_id) empty.reserved_ids.add(r.stage_reserved_id);
      if (r.stage_under_contract_id) empty.under_contract_ids.add(r.stage_under_contract_id);
      if (r.stage_closed_id) empty.closed_ids.add(r.stage_closed_id);
      if (r.stage_release_id) empty.release_ids.add(r.stage_release_id);
      if (r.stage_reserved_name) empty.reserved_names.add(r.stage_reserved_name.trim().toLowerCase());
      if (r.stage_under_contract_name) empty.under_contract_names.add(r.stage_under_contract_name.trim().toLowerCase());
      if (r.stage_closed_name) empty.closed_names.add(r.stage_closed_name.trim().toLowerCase());
      if (r.stage_release_name) empty.release_names.add(r.stage_release_name.trim().toLowerCase());
    }
  } catch { /* no config yet */ }
  return empty;
}

function classifyLead(stageId: string | null, stageName: string | null, m: PipelineMap): LeadStatus {
  if (stageId) {
    if (m.closed_ids.has(stageId)) return "sold";
    if (m.under_contract_ids.has(stageId)) return "under_contract";
    if (m.reserved_ids.has(stageId)) return "reserved";
    if (m.release_ids.has(stageId)) return "available";
  }
  if (stageName) {
    const s = stageName.trim().toLowerCase();
    if (m.closed_names.has(s)) return "sold";
    if (m.under_contract_names.has(s)) return "under_contract";
    if (m.reserved_names.has(s)) return "reserved";
    if (m.release_names.has(s)) return "available";
    if (s.includes("closed") || s === "sold" || s.includes("won")) return "sold";
    if (s.includes("contract")) return "under_contract";
    if (s.includes("reserved") || s.includes("lock")) return "reserved";
  }
  return "unknown";
}

const MAX_OPPS = 500;
const CONCURRENCY = 6;

function extractName(opp: Record<string, unknown>): string | null {
  const contact = opp["contact"] as Record<string, unknown> | undefined;
  if (contact && typeof contact === "object") {
    const n = contact["name"] ?? contact["fullName"] ?? contact["full_name"];
    if (typeof n === "string" && n.trim()) return n.trim();
    const first = contact["firstName"] ?? contact["first_name"];
    const last = contact["lastName"] ?? contact["last_name"];
    const joined = [first, last].filter((v) => typeof v === "string" && (v as string).trim()).join(" ").trim();
    if (joined) return joined;
    const email = contact["email"];
    if (typeof email === "string" && email.trim()) return email.trim();
  }
  const cn = opp["contactName"] ?? opp["contact_name"];
  if (typeof cn === "string" && cn.trim()) return cn.trim();
  return null;
}

export async function fetchUnitLeadsMap(): Promise<Map<string, UnitLead>> {
  const result = new Map<string, UnitLead>();
  let client;
  try {
    client = await createCrmClient();
  } catch (err) {
    console.warn("[unit-leads] CRM not configured:", err instanceof Error ? err.message : err);
    return result;
  }
  const locationId = client.config.location_id;
  if (!locationId) return result;

  // 1. Page through opportunities.
  const opps: Array<Record<string, unknown>> = [];
  let page = 1;
  while (opps.length < MAX_OPPS) {
    try {
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
    } catch (err) {
      console.warn("[unit-leads] opportunities/search failed:", err instanceof Error ? err.message : err);
      break;
    }
  }

  // 2. For each opp, resolve associated unit via associations endpoint (parallel with concurrency cap).
  let index = 0;
  async function worker() {
    while (true) {
      const i = index++;
      if (i >= opps.length) return;
      const opp = opps[i];
      const oppId = typeof opp["id"] === "string" ? (opp["id"] as string) : null;
      if (!oppId) continue;
      try {
        const assoc = await fetchOpportunityAssociations(client!, oppId);
        if (!assoc.unitCrmId) continue;
        if (result.has(assoc.unitCrmId)) continue;
        result.set(assoc.unitCrmId, {
          contactName: extractName(opp),
          opportunityId: oppId,
          opportunityName: typeof opp["name"] === "string" ? (opp["name"] as string) : null,
          stageName: typeof opp["stageName"] === "string"
            ? (opp["stageName"] as string)
            : (typeof opp["stage"] === "string" ? (opp["stage"] as string) : null),
        });
      } catch (err) {
        console.warn("[unit-leads] assoc failed for opp:", oppId, err instanceof Error ? err.message : err);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

  return result;
}
