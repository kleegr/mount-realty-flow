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
import { normalizeRecordProperties, requestObject } from "./object-config.server";

export type Scope = "project" | "building" | "unit";

export interface UpsertResult {
  crmId: string;
  action: "created" | "updated";
  correlationId: string;
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
 *
 * NOTE: the CREATE and UPDATE payloads are normalized SEPARATELY, not shared.
 * GHL's PUT rejects the MULTIPLE_OPTIONS array shape that its POST accepts —
 * see needsArrayWrap() in object-config.server.ts.
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
  const locationId = client.config.location_id;
  if (!locationId) throw new Error("crm_config.location_id is not set");

  // Stamp external_import_id only for objects that expose that CRM field.
  const externalField = extIdField(scope);
  const rawProps = stripEmpty(
    externalField ? { ...properties, [externalField]: externalImportId } : { ...properties },
  );

  // 1) mapping
  let crmId = await lookupMapping(scope, externalImportId);

  // 2) CRM search by external id
  if (!crmId && externalField) {
    crmId = await searchRecordId(client, scope, locationId, { [externalField]: externalImportId });
  }

  // 3) fallback search
  if (!crmId && fallbackSearch) {
    crmId = await searchRecordId(client, scope, locationId, fallbackSearch);
  }

  if (crmId) {
    const updateProps = await normalizeRecordProperties(client, scope, rawProps, { forUpdate: true });
    const res = await requestObject(client, "PUT", scope, `/records/${crmId}`, {
      body: { properties: updateProps },
    });
    await saveMapping(scope, externalImportId, crmId, jobId);
    return { crmId, action: "updated", correlationId: res.correlationId };
  }

  const createProps = await normalizeRecordProperties(client, scope, rawProps);
  const res = await requestObject<{ record?: { id?: string }; id?: string }>(
    client,
    "POST",
    scope,
    `/records`,
    { body: { locationId, properties: createProps } },
  );
  const created = extractRecordId(res.data);
  if (!created) throw new Error(`CRM did not return an id after creating ${scope}`);
  await saveMapping(scope, externalImportId, created, jobId);
  return { crmId: created, action: "created", correlationId: res.correlationId };
}

async function searchRecordId(
  client: CrmClient,
  scope: Scope,
  locationId: string,
  match: Record<string, unknown>,
): Promise<string | null> {
  try {
    const res = await requestObject<{ records?: Array<{ id?: string }> }>(
      client,
      "POST",
      scope,
      `/records/search`,
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
  const res = await requestObject(client, `GET`, scope, `/records/${crmId}`);
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
