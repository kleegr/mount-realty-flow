/**
 * CRM custom-object operations: search by external ID / code, upsert Project/Building/Unit,
 * read-back verify. Server-only.
 *
 * NOTE: GHL Custom Objects API surface used here:
 *   POST /objects/{objectKeyOrId}/records/search  (body: { locationId, page, pageLimit, query, ... })
 *   POST /objects/{objectKeyOrId}/records         (body: { locationId, properties: {...} })
 *   PUT  /objects/{objectKeyOrId}/records/{id}    (body: { properties: {...} })
 *   GET  /objects/{objectKeyOrId}/records/{id}
 * Exact behavior can vary; the client returns raw responses so we tolerate shape drift.
 */
import { createCrmClient, type CrmClient } from "./client.server";
import { FIELDS } from "./field-map";

export type Scope = "project" | "building" | "unit";

export interface UpsertResult {
  crmId: string;
  action: "created" | "updated";
  correlationId: string;
}

function objectKey(client: CrmClient, scope: Scope): string {
  // GHL accepts {objectKeyOrId} in the path. Prefer the numeric object ID
  // when configured, because the `custom_objects.<name>` key varies per
  // location and often does not match what the workspace actually uses.
  const c = client.config as unknown as Record<string, string | null>;
  const pick = (id?: string | null, key?: string | null) => (id || key || "") as string;
  if (scope === "project") return pick(c.project_object_id, c.project_object_key);
  if (scope === "building") return pick(c.building_object_id, c.building_object_key);
  return pick(c.unit_object_id, c.unit_object_key);
}

function stripEmpty(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === "" || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// Look up a saved external → CRM record mapping
async function lookupMapping(scope: Scope, externalId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("external_id_map")
    .select("crm_record_id")
    .eq("scope", scope)
    .eq("external_import_id", externalId)
    .maybeSingle();
  return data?.crm_record_id ?? null;
}

async function saveMapping(scope: Scope, externalId: string, crmId: string, jobId?: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("external_id_map").upsert(
    { scope, external_import_id: externalId, crm_record_id: crmId, first_seen_job_id: jobId ?? null },
    { onConflict: "scope,external_import_id" },
  );
}

/**
 * Upsert a record. Match order:
 *  1. saved external_id mapping
 *  2. CRM search by external_import_id field
 *  3. CRM search by fallback (project/building code, or unit_number+building)
 */
export async function upsertRecord(params: {
  client: CrmClient;
  scope: Scope;
  externalImportId: string;
  fallbackSearch?: Record<string, unknown>;
  properties: Record<string, unknown>;
  jobId?: string;
}): Promise<UpsertResult> {
  const { client, scope, externalImportId, fallbackSearch, properties, jobId } = params;
  const key = objectKey(client, scope);
  const locationId = client.config.location_id;
  if (!locationId) throw new Error("crm_config.location_id is not set");

  // Stamp external_import_id only for objects that expose that CRM field.
  const externalField = extIdField(scope);
  const props = externalField ? { ...properties, [externalField]: externalImportId } : { ...properties };

  // 1) mapping
  let crmId = await lookupMapping(scope, externalImportId);

  // 2) CRM search by external id
  if (!crmId && externalField) {
    crmId = await searchRecordId(client, key, locationId, { [externalField]: externalImportId });
  }

  // 3) fallback search
  if (!crmId && fallbackSearch) {
    crmId = await searchRecordId(client, key, locationId, fallbackSearch);
  }

  if (crmId) {
    const res = await client.request("PUT", `/objects/${key}/records/${crmId}`, {
      body: { properties: props },
    });
    await saveMapping(scope, externalImportId, crmId, jobId);
    return { crmId, action: "updated", correlationId: res.correlationId };
  }

  const res = await client.request<{ record?: { id?: string }; id?: string }>(
    "POST",
    `/objects/${key}/records`,
    { body: { locationId, properties: props } },
  );
  const created = extractRecordId(res.data);
  if (!created) throw new Error(`CRM did not return an id after creating ${scope}`);
  await saveMapping(scope, externalImportId, created, jobId);
  return { crmId: created, action: "created", correlationId: res.correlationId };
}

async function searchRecordId(
  client: CrmClient,
  key: string,
  locationId: string,
  match: Record<string, unknown>,
): Promise<string | null> {
  try {
    const res = await client.request<{ records?: Array<{ id?: string }> }>(
      "POST",
      `/objects/${key}/records/search`,
      {
        body: {
          locationId,
          page: 1,
          pageLimit: 2,
          query: match,
        },
      },
    );
    const records = res.data?.records ?? [];
    if (records.length === 0) return null;
    if (records.length > 1) {
      // Ambiguous — refuse to guess
      throw new Error(
        `Ambiguous CRM match (${records.length} records) for ${JSON.stringify(match)}. Human resolution required.`,
      );
    }
    return records[0]?.id ?? null;
  } catch (err) {
    // If the search endpoint isn't available, fall back to null (create path)
    if (err instanceof Error && err.message.includes("Ambiguous")) throw err;
    console.warn("CRM search failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

export async function readRecord(client: CrmClient, scope: Scope, crmId: string) {
  const key = objectKey(client, scope);
  const res = await client.request(`GET`, `/objects/${key}/records/${crmId}`);
  return res.data;
}

function extIdField(scope: Scope): string | null {
  return scope === "project"
    ? FIELDS.project.external_import_id
    : scope === "building"
      ? FIELDS.building.external_import_id
      : null;
}

function extractRecordId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.id === "string") return d.id;
  const rec = d.record as Record<string, unknown> | undefined;
  if (rec && typeof rec.id === "string") return rec.id;
  return null;
}

export { createCrmClient };
