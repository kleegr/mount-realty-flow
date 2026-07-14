/**
 * Live CRM reconciliation. Lists all record IDs currently in the CRM
 * for a given scope so callers can prune stale local mappings
 * (records deleted directly in the CRM stay in external_id_map otherwise).
 */
import { createCrmClient, type CrmClient } from "./client.server";
import { requestObject } from "./object-config.server";

export type Scope = "project" | "building" | "unit";

function extractRecords(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const nested = d.data && typeof d.data === "object" ? (d.data as Record<string, unknown>) : null;
  const arr = (d.records ?? d.items ?? d.results ?? nested?.records ?? nested?.items ?? d.data ?? []) as unknown;
  return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
}

export async function listLiveRecordIds(scope: Scope, client?: CrmClient): Promise<Set<string>> {
  const c = client ?? (await createCrmClient());
  const locationId = c.config.location_id;
  const ids = new Set<string>();
  if (!locationId) return ids;
  let page = 1;
  const pageLimit = 100;
  const maxPages = 500;
  while (page <= maxPages) {
    const res = await requestObject<unknown>(c, "POST", scope, `/records/search`, {
      body: { locationId, page, pageLimit, query: "" },
    });
    const records = extractRecords(res.data);
    if (records.length === 0) break;
    for (const r of records) {
      if (typeof r.id === "string") ids.add(r.id);
    }
    if (records.length < pageLimit) break;
    page++;
  }
  return ids;
}

/**
 * Delete external_id_map rows (and dependent unit_state) for records that
 * no longer exist in the CRM. Safe no-op if the CRM call fails.
 * Returns per-scope pruned counts.
 */
export async function reconcileScopes(scopes: Scope[]): Promise<Record<Scope, number>> {
  const pruned: Record<Scope, number> = { project: 0, building: 0, unit: 0 };
  let client: CrmClient;
  try {
    client = await createCrmClient();
  } catch (err) {
    console.warn("[reconcile] CRM not configured:", err instanceof Error ? err.message : err);
    return pruned;
  }
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

  for (const scope of scopes) {
    let live: Set<string>;
    try {
      live = await listLiveRecordIds(scope, client);
    } catch (err) {
      console.warn(`[reconcile] list ${scope} failed:`, err instanceof Error ? err.message : err);
      continue;
    }
    // Skip pruning if CRM returned zero records (avoid wiping on transient outage)
    if (live.size === 0) continue;

    const { data: local } = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id")
      .eq("scope", scope);
    const stale = (local ?? [])
      .map((r) => r.crm_record_id)
      .filter((id) => !live.has(id));
    if (stale.length === 0) continue;

    if (scope === "unit") {
      await supabaseAdmin.from("unit_state").delete().in("unit_crm_id", stale);
    }
    // Clear parent_crm_id refs so building/project deletes don't leave dangling FKs.
    if (scope !== "unit") {
      await supabaseAdmin
        .from("external_id_map")
        .update({ parent_crm_id: null })
        .in("parent_crm_id", stale);
    }
    const { error } = await supabaseAdmin
      .from("external_id_map")
      .delete()
      .eq("scope", scope)
      .in("crm_record_id", stale);
    if (!error) pruned[scope] = stale.length;
  }
  return pruned;
}
