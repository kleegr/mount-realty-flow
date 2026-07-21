/**
 * Live CRM reconciliation.
 *
 *  - listLiveRecordIds / reconcileScopes: prune local mappings for records that
 *    were deleted directly in the CRM.
 *  - syncUnitStatesFromCrm: mirror each Unit's ACTUAL availability/stage from
 *    the CRM into unit_state, which is what the dashboard renders.
 *
 * The CRM record is the source of truth for a unit's state: it is what the
 * stage webhook writes and what a human edits by hand in GHL. Without the
 * mirror step below, a unit flipped to Available directly in the CRM would
 * still show as Reserved on the dashboard forever — nothing else ever re-reads
 * it (reconcileScopes only prunes; the leads map is derived from opportunities,
 * so a unit with no opportunity is never visited at all).
 */
import { createCrmClient, type CrmClient } from "./client.server";
import { FIELDS } from "./field-map";
import { requestObject } from "./object-config.server";

export type Scope = "project" | "building" | "unit";

function extractRecords(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const nested = d.data && typeof d.data === "object" ? (d.data as Record<string, unknown>) : null;
  const arr = (d.records ?? d.items ?? d.results ?? nested?.records ?? nested?.items ?? d.data ?? []) as unknown;
  return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
}

/** Page through every record of a scope, returning the raw record objects. */
export async function listLiveRecords(scope: Scope, client?: CrmClient): Promise<Array<Record<string, unknown>>> {
  const c = client ?? (await createCrmClient());
  const locationId = c.config.location_id;
  const out: Array<Record<string, unknown>> = [];
  if (!locationId) return out;
  let page = 1;
  const pageLimit = 100;
  const maxPages = 500;
  while (page <= maxPages) {
    const res = await requestObject<unknown>(c, "POST", scope, `/records/search`, {
      body: { locationId, page, pageLimit, query: "" },
    });
    const records = extractRecords(res.data);
    if (records.length === 0) break;
    out.push(...records);
    if (records.length < pageLimit) break;
    page++;
  }
  return out;
}

export async function listLiveRecordIds(scope: Scope, client?: CrmClient): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const r of await listLiveRecords(scope, client)) {
    if (typeof r.id === "string") ids.add(r.id);
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

// ============================================================================
// Unit state mirror
// ============================================================================

export interface UnitStateSyncResult {
  scanned: number;
  updated: number;
  freed: number;
  skipped: string | null;
}

/** Property lookup that tolerates both "stage" and "custom_objects.units.stage". */
export function readProp(props: Record<string, unknown>, key: string): unknown {
  if (key in props) return props[key];
  const suffix = `.${key}`;
  for (const [k, v] of Object.entries(props)) {
    if (k.endsWith(suffix)) return v;
  }
  return undefined;
}

export function propsOf(record: Record<string, unknown>): Record<string, unknown> | null {
  const direct = record.properties;
  if (direct && typeof direct === "object") return direct as Record<string, unknown>;
  const nested = record.record as Record<string, unknown> | undefined;
  if (nested?.properties && typeof nested.properties === "object") {
    return nested.properties as Record<string, unknown>;
  }
  return null;
}

function normalizeUnitStage(value: unknown): string {
  const raw = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
  const key = raw.trim().toLowerCase().replace(/[\s_/-]+/g, "");
  if (key === "available") return "Available";
  if (key === "reservedlocked") return "Reserved/Locked";
  if (key === "undercontract") return "Under Contract";
  if (key === "closedsold") return "Closed/Sold";
  return raw.trim();
}

function normalizeAvailability(value: unknown): string {
  const raw = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
  const key = raw.trim().toLowerCase().replace(/[\s_/-]+/g, "");
  if (key === "available") return "Available";
  if (key === "notavailable") return "Not Available";
  return raw.trim();
}

/**
 * Read every Unit record from the CRM and write its availability/stage into
 * unit_state. This is what makes a manual edit in GHL (Not Available ->
 * Available) show up on the dashboard.
 *
 * Guards:
 *  - a CRM failure, or a response with zero units, aborts without writing
 *    anything (a transient outage must never mass-flip inventory)
 *  - records whose availability can't be parsed are skipped, never blanked
 *  - only rows that actually differ are written
 */
export async function syncUnitStatesFromCrm(client?: CrmClient): Promise<UnitStateSyncResult> {
  const result: UnitStateSyncResult = { scanned: 0, updated: 0, freed: 0, skipped: null };

  let c: CrmClient;
  try {
    c = client ?? (await createCrmClient());
  } catch (err) {
    result.skipped = `CRM not configured: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  let records: Array<Record<string, unknown>>;
  try {
    records = await listLiveRecords("unit", c);
  } catch (err) {
    result.skipped = `unit list failed: ${err instanceof Error ? err.message : String(err)}`;
    return result;
  }

  // Zero units back from the CRM is far more likely to be an outage or an auth
  // problem than a genuinely empty inventory. Never act on it.
  if (records.length === 0) {
    result.skipped = "CRM returned no unit records; leaving the mirror untouched";
    return result;
  }
  result.scanned = records.length;

  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data: existing } = await supabaseAdmin
    .from("unit_state")
    .select("unit_crm_id, availability, stage");
  const prev = new Map((existing ?? []).map((r) => [r.unit_crm_id, r]));

  const upserts: Array<{ unit_crm_id: string; availability: string; stage: string }> = [];
  const freedIds: string[] = [];

  for (const record of records) {
    const id = typeof record.id === "string" ? record.id : null;
    if (!id) continue;
    const props = propsOf(record);
    if (!props) continue;

    const availability = normalizeAvailability(readProp(props, FIELDS.unit.availability));
    const stage = normalizeUnitStage(readProp(props, FIELDS.unit.stage));

    // Don't blank a unit just because this response didn't carry its fields.
    if (!availability && !stage) continue;

    const before = prev.get(id);
    if (before && (before.availability ?? "") === availability && (before.stage ?? "") === stage) continue;

    upserts.push({ unit_crm_id: id, availability, stage });
    if (!stage && availability === "Available") freedIds.push(id);
  }

  if (upserts.length === 0) return result;

  const { error } = await supabaseAdmin.from("unit_state").upsert(upserts, { onConflict: "unit_crm_id" });
  if (error) {
    result.skipped = `unit_state write failed: ${error.message}`;
    return result;
  }
  result.updated = upserts.length;

  // A unit that is Available again is held by nobody. Best-effort: the column
  // only exists once the ownership migration has been run.
  if (freedIds.length > 0) {
    await supabaseAdmin
      .from("unit_state")
      .update({ held_by_opportunity_id: null })
      .in("unit_crm_id", freedIds)
      .then(
        () => undefined,
        () => undefined,
      );
    result.freed = freedIds.length;
  }

  return result;
}
