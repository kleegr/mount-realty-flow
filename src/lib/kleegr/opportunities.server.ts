/**
 * Fetch an Opportunity's associated Unit / Building from GHL.
 *
 * When the stage-change webhook fires, GHL's picker doesn't expose Association
 * merge tags on many plans — so we look them up server-side using the CRM API.
 *
 * Strategy (defensive — tolerates GHL API shape drift):
 *   1. GET /associations/relations/{opportunityId} → list of related record IDs
 *   2. For each related record, we know the associated object key (unit or building)
 *      because we saved it in external_id_map when syncing.
 *   3. Return the first matching Unit CRM ID (preferred) or Building CRM ID.
 */
import type { CrmClient } from "./client.server";
import { requestObject } from "./object-config.server";

export interface OpportunityAssociations {
  unitCrmId: string | null;
  buildingCrmId: string | null;
  raw?: unknown;
}

export async function fetchOpportunityAssociations(
  client: CrmClient,
  opportunityId: string,
): Promise<OpportunityAssociations> {
  const locationId = client.config.location_id;
  if (!locationId) return { unitCrmId: null, buildingCrmId: null };

  // Try the associations endpoint first
  const relatedIds = await fetchRelatedRecordIds(client, opportunityId, locationId);

  if (relatedIds.length === 0) {
    return { unitCrmId: null, buildingCrmId: null };
  }

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  // Match related IDs to our external_id_map (populated by Sync from CRM)
  const { data: mapped } = await supabaseAdmin
    .from("external_id_map")
    .select("scope, crm_record_id")
    .in("crm_record_id", relatedIds);

  let unitCrmId: string | null = null;
  let buildingCrmId: string | null = null;
  for (const row of mapped ?? []) {
    if (row.scope === "unit" && !unitCrmId) unitCrmId = row.crm_record_id;
    if (row.scope === "building" && !buildingCrmId) buildingCrmId = row.crm_record_id;
  }

  // Fallback: probe each related ID against the Unit / Building custom-object endpoints
  if (!unitCrmId && !buildingCrmId) {
    for (const id of relatedIds) {
      const scope = await probeRecordScope(client, id);
      if (scope === "unit") { unitCrmId = id; break; }
      if (scope === "building" && !buildingCrmId) buildingCrmId = id;
    }
  }

  return { unitCrmId, buildingCrmId };
}

async function fetchRelatedRecordIds(
  client: CrmClient,
  opportunityId: string,
  locationId: string,
): Promise<string[]> {
  // GHL: GET /associations/relations/{recordId}
  try {
    const res = await client.request<unknown>(
      "GET",
      `/associations/relations/${opportunityId}`,
      { query: { locationId, skip: 0, limit: 100 } },
    );
    return extractRelatedIds(res.data, opportunityId);
  } catch (err) {
    console.warn(
      "[opportunities] associations lookup failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

/** Walk an unknown GHL response, extracting IDs that are NOT the opportunity itself. */
function extractRelatedIds(data: unknown, opportunityId: string): string[] {
  const ids = new Set<string>();
  const seen = new WeakSet<object>();
  function walk(node: unknown): void {
    if (!node) return;
    if (typeof node === "string") return;
    if (typeof node !== "object") return;
    if (seen.has(node as object)) return;
    seen.add(node as object);
    if (Array.isArray(node)) { node.forEach(walk); return; }
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (
        typeof v === "string" &&
        v.length >= 10 &&
        v !== opportunityId &&
        /Id$/i.test(k) &&
        !/pipeline|stage|location|workflow|contact|assigned|created|updated/i.test(k)
      ) {
        ids.add(v);
      }
      walk(v);
    }
  }
  walk(data);
  return Array.from(ids);
}

/** Try reading a record ID against Unit and Building endpoints; return which one it belongs to. */
async function probeRecordScope(
  client: CrmClient,
  recordId: string,
): Promise<"unit" | "building" | null> {
  try {
    await requestObject(client, "GET", "unit", `/records/${recordId}`);
    return "unit";
  } catch { /* not a unit */ }
  try {
    await requestObject(client, "GET", "building", `/records/${recordId}`);
    return "building";
  } catch { /* not a building */ }
  return null;
}
