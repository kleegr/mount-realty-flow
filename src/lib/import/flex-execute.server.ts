/**
 * Flexible import executor.
 * Given rows + column_map + options, resolve identity, resolve parents, write to CRM,
 * append import_items, and return a report + failed-rows CSV blob.
 */
import { CrmError, type CrmClient } from "../kleegr/client.server";
import type { FlexScope } from "./flex-mapping";
import { FIELD_CATALOG, coerce } from "./flex-mapping";
import { createCrmClient } from "../kleegr/client.server";
import { readRecord } from "../kleegr/objects.server";
import { normalizeRecordProperties, requestObject } from "../kleegr/object-config.server";
import { associateByScopes } from "../kleegr/associations.server";
import { toCsv } from "./flex-parse.server";
import type { Database } from "@/integrations/supabase/types";

export type DuplicateStrategy = "skip" | "update" | "create_duplicate";
export type ParentBehavior = "auto_create" | "unassigned" | "fail";
export type DuplicateKey = "record_id" | "external_id" | "code" | "name";

export interface FlexOptions {
  duplicateStrategy: DuplicateStrategy;
  duplicateKey: DuplicateKey;
  missingParentProject: ParentBehavior;
  missingParentBuilding: ParentBehavior;
}

export interface FlexReport {
  status: "success" | "success_with_warnings" | "partial_failure" | "failed";
  imported: number;
  updated: number;
  skipped: number;
  failed: number;
  auto_created_projects: number;
  auto_created_buildings: number;
  duplicates_created: number;
  associations_ok: number;
  associations_failed: number;
  per_scope: Record<FlexScope, { created: number; updated: number; skipped: number; failed: number }>;
  errors: Array<{ scope: FlexScope; ref: string; message: string; rowNumber: number }>;
  warnings: string[];
}

type Row = Record<string, unknown>;
type ScopeMap = Record<string, string>; // header -> field key
type ColumnMap = Partial<Record<FlexScope, ScopeMap>>;
type ItemInsert = Database["public"]["Tables"]["import_items"]["Insert"];

export async function executeFlexImport(params: {
  jobId: string;
  scopes: FlexScope[];
  rows: Row[];
  columnMap: ColumnMap;
  options: FlexOptions;
}): Promise<FlexReport> {
  const { jobId, scopes, rows, columnMap, options } = params;
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("import_jobs").update({ status: "running", started_at: new Date().toISOString() }).eq("id", jobId);

  const client = await createCrmClient();

  const report: FlexReport = {
    status: "success",
    imported: 0, updated: 0, skipped: 0, failed: 0,
    auto_created_projects: 0, auto_created_buildings: 0, duplicates_created: 0,
    associations_ok: 0, associations_failed: 0,
    per_scope: {
      project: { created: 0, updated: 0, skipped: 0, failed: 0 },
      building: { created: 0, updated: 0, skipped: 0, failed: 0 },
      unit: { created: 0, updated: 0, skipped: 0, failed: 0 },
    },
    errors: [],
    warnings: [],
  };

  // Pairs discovered during the row loop; processed after all upserts complete.
  const assocPairs: Array<{ parent: FlexScope; parentId: string; child: FlexScope; childId: string }> = [];

  const items: ItemInsert[] = [];
  const failedRows: Array<Record<string, unknown>> = [];

  // Per-file caches: scope -> logical key -> CRM ID
  const cache: Record<FlexScope, { byExternalId: Map<string, string>; byName: Map<string, string>; byCode: Map<string, string> }> = {
    project: { byExternalId: new Map(), byName: new Map(), byCode: new Map() },
    building: { byExternalId: new Map(), byName: new Map(), byCode: new Map() },
    unit: { byExternalId: new Map(), byName: new Map(), byCode: new Map() },
  };

  // Process scopes in parent-first order
  const scopeOrder: FlexScope[] = ["project", "building", "unit"].filter((s) => scopes.includes(s as FlexScope)) as FlexScope[];

  for (const scope of scopeOrder) {
    const scopeMap = columnMap[scope];
    if (!scopeMap || Object.keys(scopeMap).length === 0) continue;

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const rowNumber = i + 2;
      try {
        const { properties, ids, parentRefs } = extractRow(scope, row, scopeMap);

        // Skip rows that have no meaningful data for this scope
        if (!ids.record_id && !ids.external_id && !ids.name && !ids.code && Object.keys(properties).length === 0) continue;

        // Require at least one identity field (name / code / external id / record id) to create or update.
        // Otherwise CRM will reject with "required property missing" (e.g. building_name).
        const hasIdentity = Boolean(ids.record_id || ids.external_id || ids.name || ids.code);
        if (!hasIdentity) {
          report.skipped++;
          report.per_scope[scope].skipped++;
          items.push(makeItem(jobId, scope, ids, "skip", "skip", null, properties, null,
            [{ level: "warning", message: `Row skipped: no ${scope} name / code / external id provided.` }],
            null, null, null));
          continue;
        }


        // Resolve parent CRM IDs
        const parentCrm: Record<FlexScope, string | null> = { project: null, building: null, unit: null };
        let parentResolution: string | null = null;

        if (scope === "building" && parentRefs.project) {
          const resolved = await resolveParent(client, supabaseAdmin, "project", parentRefs.project, cache.project);
          if (resolved.crmId) {
            parentCrm.project = resolved.crmId;
            parentResolution = resolved.source;
          } else if (options.missingParentProject === "auto_create") {
            const created = await autoCreateParent(client, "project", parentRefs.project);
            parentCrm.project = created;
            parentResolution = "auto_created";
            report.auto_created_projects++;
            items.push(makeItem(jobId, "project", parentRefs.project, "auto_create_parent", "auto_create_parent", "existing", { name: parentRefs.project.name }, null, [], created, null, null));
          } else if (options.missingParentProject === "fail") {
            throw new Error(`Parent project "${parentRefs.project.name ?? parentRefs.project.code ?? parentRefs.project.external_id ?? parentRefs.project.record_id}" not found.`);
          } else {
            parentResolution = "unassigned";
          }
        }
        if (scope === "unit") {
          if (parentRefs.building) {
            const resolved = await resolveParent(client, supabaseAdmin, "building", parentRefs.building, cache.building);
            if (resolved.crmId) {
              parentCrm.building = resolved.crmId;
              parentResolution = resolved.source;
            } else if (options.missingParentBuilding === "auto_create") {
              parentCrm.building = await autoCreateParent(client, "building", parentRefs.building);
              parentResolution = "auto_created";
              report.auto_created_buildings++;
              items.push(makeItem(jobId, "building", parentRefs.building, "auto_create_parent", "auto_create_parent", "existing", { name: parentRefs.building.name }, null, [], parentCrm.building, null, null));
            } else if (options.missingParentBuilding === "fail") {
              throw new Error(`Parent building "${parentRefs.building.name ?? parentRefs.building.code ?? parentRefs.building.external_id ?? parentRefs.building.record_id}" not found.`);
            } else {
              parentResolution = "unassigned";
            }
          }
          if (parentRefs.project) {
            const resolved = await resolveParent(client, supabaseAdmin, "project", parentRefs.project, cache.project);
            if (resolved.crmId) parentCrm.project = resolved.crmId;
          }
        }

        // Duplicate detection
        const existing = await resolveIdentity(supabaseAdmin, scope, ids, options.duplicateKey);
        let resolution: "create" | "update" | "skip" | "create_duplicate";
        let action: "create" | "update" | "skip" | "create_duplicate";
        let crmId: string | null = existing;
        let previous: Record<string, unknown> | null = null;
        let undoOp: unknown = null;

        if (existing) {
          if (options.duplicateStrategy === "skip") {
            resolution = action = "skip";
            report.skipped++;
            report.per_scope[scope].skipped++;
            items.push(makeItem(jobId, scope, ids, action, resolution, parentResolution, properties, existing, [], null, null, null));
            continue;
          }
          if (options.duplicateStrategy === "create_duplicate") {
            crmId = await createRecord(client, scope, properties, ids);
            resolution = action = "create_duplicate";
            report.duplicates_created++;
            report.per_scope[scope].created++;
            report.imported++;
            undoOp = { kind: "delete", scope, crmId };
          } else {
            // update, unless the saved local CRM mapping points at a record that no longer exists.
            const previousResult = await tryReadPrevious(client, scope, existing);
            previous = previousResult.properties;
            if (previousResult.missing) {
              await removeStaleMap(supabaseAdmin, scope, existing, ids);
              crmId = await createRecord(client, scope, properties, ids);
              resolution = action = "create";
              report.imported++;
              report.per_scope[scope].created++;
              undoOp = { kind: "delete", scope, crmId };
            } else {
              await updateRecord(client, scope, existing, properties);
              resolution = action = "update";
              report.updated++;
              report.per_scope[scope].updated++;
              undoOp = { kind: "patch", scope, crmId: existing, properties: previous };
            }
          }
        } else {
          crmId = await createRecord(client, scope, properties, ids);
          resolution = action = "create";
          report.imported++;
          report.per_scope[scope].created++;
          undoOp = { kind: "delete", scope, crmId };
        }

        // Store mapping so later rows / undo can find it
        if (crmId) {
          await saveMap(supabaseAdmin, scope, crmId, ids, jobId);
          if (ids.external_id) cache[scope].byExternalId.set(ids.external_id, crmId);
          if (ids.name) cache[scope].byName.set(ids.name.toLowerCase(), crmId);
          if (ids.code) cache[scope].byCode.set(ids.code.toLowerCase(), crmId);

          // Queue associations Project→Building and Building→Unit for this row.
          if (scope === "building" && parentCrm.project) {
            assocPairs.push({ parent: "project", parentId: parentCrm.project, child: "building", childId: crmId });
          }
          if (scope === "unit") {
            if (parentCrm.building) assocPairs.push({ parent: "building", parentId: parentCrm.building, child: "unit", childId: crmId });
            if (parentCrm.project) assocPairs.push({ parent: "project", parentId: parentCrm.project, child: "unit", childId: crmId });
          }
        }

        items.push(makeItem(jobId, scope, ids, action, resolution, parentResolution, properties, crmId, [], null, undoOp, null));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.failed++;
        report.per_scope[scope].failed++;
        report.errors.push({ scope, ref: JSON.stringify(row).slice(0, 80), message, rowNumber });
        items.push(makeItem(jobId, scope, {}, "error", "error", null, {}, null, [{ level: "error", message }], null, null, message));
        failedRows.push({ ...row, _error: message, _scope: scope, _row: rowNumber });
      }
    }
  }

  // Bulk insert items
  if (items.length > 0) {
    // Insert in batches to avoid payload limits
    for (let i = 0; i < items.length; i += 200) {
      await supabaseAdmin.from("import_items").insert(items.slice(i, i + 200));
    }
  }

  // Determine status
  if (report.failed > 0 && report.imported + report.updated === 0) report.status = "failed";
  else if (report.failed > 0) report.status = "partial_failure";
  else if (report.duplicates_created > 0 || report.auto_created_projects + report.auto_created_buildings > 0) report.status = "success_with_warnings";
  else report.status = "success";

  await supabaseAdmin.from("import_jobs").update({
    status: report.status,
    completed_at: new Date().toISOString(),
    projects_created: report.per_scope.project.created,
    projects_updated: report.per_scope.project.updated,
    buildings_created: report.per_scope.building.created,
    buildings_updated: report.per_scope.building.updated,
    units_created: report.per_scope.unit.created,
    units_updated: report.per_scope.unit.updated,
    auto_created_projects: report.auto_created_projects,
    auto_created_buildings: report.auto_created_buildings,
    failed_count: report.failed,
    errors_count: report.failed,
    skipped: report.skipped,
    report: JSON.parse(JSON.stringify(report)),
    error_message: report.errors[0]?.message ?? null,
  }).eq("id", jobId);

  // Save failed rows CSV without overwriting the original source rows.
  if (failedRows.length > 0) {
    const headers = [...new Set(failedRows.flatMap((r) => Object.keys(r)))];
    const csv = toCsv(headers, failedRows);
    await supabaseAdmin.from("import_jobs").update({ report: { ...report, failedCsv: csv } as never }).eq("id", jobId);
  }

  return report;
}

// ---------- helpers ----------

interface Ids { record_id?: string; external_id?: string; name?: string; code?: string; number?: string }
interface ExtractOut { properties: Record<string, unknown>; ids: Ids; parentRefs: Partial<Record<FlexScope, Ids>> }

function extractRow(scope: FlexScope, row: Row, scopeMap: ScopeMap): ExtractOut {
  const properties: Record<string, unknown> = {};
  const ids: Ids = {};
  const parentRefs: Partial<Record<FlexScope, Ids>> = {};

  for (const [header, fieldKey] of Object.entries(scopeMap)) {
    const raw = row[header];
    if (raw === undefined || raw === null || raw === "") continue;
    const field = FIELD_CATALOG[scope].find((f) => f.key === fieldKey);
    if (!field) continue;

    if (field.role === "parent_ref" && field.parentScope) {
      const existing = parentRefs[field.parentScope] ?? {};
      const val = String(raw).trim();
      const normalizedHeader = header.toLowerCase().replace(/[_\-?]+/g, " ");
      if (/^[a-zA-Z0-9]{20,}$/.test(val) && /\b(record|crm|id)\b/.test(normalizedHeader)) existing.record_id = val;
      else if (normalizedHeader.includes("import id") || normalizedHeader.includes("external id")) existing.external_id = val;
      else if (normalizedHeader.includes("code")) existing.code = val;
      else if (normalizedHeader.includes("name")) existing.name = val;
      else {
        existing.external_id ??= val;
        existing.code ??= val;
        existing.name ??= val;
      }
      parentRefs[field.parentScope] = existing;
      continue;
    }

    let value = coerce(raw, field.type);
    if (value === null) continue;

    // Enum normalization: case-insensitive match against allowed list.
    // If the value doesn't match, drop it (GHL rejects unknown picklist values).
    if (field.enum && typeof value === "string") {
      const match = field.enum.find((opt) => opt.toLowerCase() === String(value).toLowerCase().trim());
      if (!match) {
        console.warn(`[flex-import] Dropping unknown ${scope}.${field.key} value: "${value}" (allowed: ${field.enum.join(", ")})`);
        continue;
      }
      value = match;
    }

    // Multi-select fields must be sent to GHL as arrays.
    const MULTI_SELECT_KEYS = new Set(["property_type"]);
    const outValue: unknown = MULTI_SELECT_KEYS.has(field.key)
      ? (Array.isArray(value) ? value : String(value).split(",").map((s) => s.trim()).filter(Boolean))
      : value;

    if (field.role === "record_id") ids.record_id = String(value);
    else if (field.role === "external_id") { ids.external_id = String(value); if (field.crmField) properties[field.crmField] = outValue; }
    else if (field.role === "name") { ids.name = String(value); if (field.crmField) properties[field.crmField] = outValue; }
    else if (field.role === "code") { ids.code = String(value); if (field.crmField) properties[field.crmField] = outValue; }
    else if (field.crmField) {
      properties[field.crmField] = outValue;
      if (field.key === "number") ids.number = String(value);
    }
  }
  return { properties, ids, parentRefs };
}

async function resolveIdentity(
  supabaseAdmin: SupabaseAdmin,
  scope: FlexScope,
  ids: Ids,
  key: DuplicateKey,
): Promise<string | null> {
  if (key === "record_id" && ids.record_id) return ids.record_id;
  if (key === "external_id" && ids.external_id) {
    const { data } = await supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", scope).eq("external_import_id", ids.external_id).maybeSingle();
    if (data?.crm_record_id) return data.crm_record_id;
  }
  if (key === "code" && ids.code) {
    const { data } = await supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", scope).eq("code", ids.code).limit(1).maybeSingle();
    if (data?.crm_record_id) return data.crm_record_id;
  }
  if (key === "name" && ids.name) {
    const { data } = await supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", scope).ilike("display_name", ids.name).limit(1).maybeSingle();
    if (data?.crm_record_id) return data.crm_record_id;
  }
  // Also try sibling identity fields so reruns after a partial import update existing records.
  if (ids.record_id) return ids.record_id;
  if (key !== "external_id" && ids.external_id) {
    const { data } = await supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", scope).eq("external_import_id", ids.external_id).maybeSingle();
    if (data?.crm_record_id) return data.crm_record_id;
  }
  if (key !== "code" && ids.code) {
    const { data } = await supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", scope).eq("code", ids.code).limit(1).maybeSingle();
    if (data?.crm_record_id) return data.crm_record_id;
  }
  if (key !== "name" && ids.name) {
    const { data } = await supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", scope).ilike("display_name", ids.name).limit(1).maybeSingle();
    if (data?.crm_record_id) return data.crm_record_id;
  }
  return null;
}

async function resolveParent(
  client: CrmClient,
  supabaseAdmin: SupabaseAdmin,
  scope: FlexScope,
  ref: Ids,
  cache: { byExternalId: Map<string, string>; byName: Map<string, string>; byCode: Map<string, string> },
): Promise<{ crmId: string | null; source: string }> {
  if (ref.record_id) return { crmId: ref.record_id, source: "existing" };
  if (ref.external_id) {
    if (cache.byExternalId.has(ref.external_id)) return { crmId: cache.byExternalId.get(ref.external_id)!, source: "same_file" };
    const { data } = await supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", scope).eq("external_import_id", ref.external_id).maybeSingle();
    if (data?.crm_record_id) return { crmId: data.crm_record_id, source: "existing" };
  }
  if (ref.code) {
    if (cache.byCode.has(ref.code.toLowerCase())) return { crmId: cache.byCode.get(ref.code.toLowerCase())!, source: "same_file" };
    const { data } = await supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", scope).eq("code", ref.code).limit(1).maybeSingle();
    if (data?.crm_record_id) return { crmId: data.crm_record_id, source: "existing" };
  }
  if (ref.name) {
    if (cache.byName.has(ref.name.toLowerCase())) return { crmId: cache.byName.get(ref.name.toLowerCase())!, source: "same_file" };
    const { data } = await supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", scope).ilike("display_name", ref.name).limit(1).maybeSingle();
    if (data?.crm_record_id) return { crmId: data.crm_record_id, source: "existing" };
  }
  return { crmId: null, source: "unassigned" };
}

async function autoCreateParent(client: CrmClient, scope: FlexScope, ref: Ids): Promise<string> {
  const nameField = FIELD_CATALOG[scope].find((f) => f.role === "name")?.crmField;
  const codeField = FIELD_CATALOG[scope].find((f) => f.role === "code")?.crmField;
  const extField = FIELD_CATALOG[scope].find((f) => f.role === "external_id")?.crmField;
  const properties: Record<string, unknown> = {};
  if (nameField && ref.name) properties[nameField] = ref.name;
  if (codeField && ref.code) properties[codeField] = ref.code;
  if (extField && ref.external_id) properties[extField] = ref.external_id;
  const normalized = await normalizeRecordProperties(client, scope, properties);
  const res = await requestObject<{ record?: { id?: string }; id?: string }>(
    client, "POST", scope, `/records`,
    { body: { locationId: client.config.location_id, properties: normalized } },
  );
  const id = extractId(res.data);
  if (!id) throw new Error(`Auto-create ${scope}: no id returned`);
  return id;
}

function stripEmpty(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === "" || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

async function createRecord(client: CrmClient, scope: FlexScope, properties: Record<string, unknown>, _ids: Ids): Promise<string> {
  const normalized = await normalizeRecordProperties(client, scope, stripEmpty(properties));
  const res = await requestObject<{ record?: { id?: string }; id?: string }>(
    client, "POST", scope, `/records`,
    { body: { locationId: client.config.location_id, properties: normalized } },
  );
  const id = extractId(res.data);
  if (!id) throw new Error(`Create ${scope}: CRM did not return an id`);
  return id;
}

async function updateRecord(client: CrmClient, scope: FlexScope, crmId: string, properties: Record<string, unknown>) {
  const normalized = await normalizeRecordProperties(client, scope, stripEmpty(properties));
  if (Object.keys(normalized).length === 0) return;
  await requestObject(client, "PUT", scope, `/records/${crmId}`, { body: { properties: normalized } });
}

async function removeStaleMap(supabaseAdmin: SupabaseAdmin, scope: FlexScope, crmId: string, ids: Ids) {
  let query = supabaseAdmin.from("external_id_map").delete().eq("scope", scope).eq("crm_record_id", crmId);
  if (ids.external_id) query = query.eq("external_import_id", ids.external_id);
  const { error } = await query;
  if (error) console.warn(`Failed to remove stale ${scope} mapping ${crmId}: ${error.message}`);
}

async function tryReadPrevious(
  client: CrmClient,
  scope: FlexScope,
  crmId: string,
): Promise<{ properties: Record<string, unknown> | null; missing: boolean }> {
  try {
    const data = await readRecord(client, scope, crmId);
    const rec = (data as { record?: { properties?: unknown } })?.record ?? data;
    const props = (rec as { properties?: unknown })?.properties;
    return { properties: (props ?? null) as Record<string, unknown> | null, missing: false };
  } catch (err) {
    if (err instanceof CrmError && err.status === 404 && /record with id/i.test(err.message)) {
      return { properties: null, missing: true };
    }
    throw err;
  }
}

async function saveMap(supabaseAdmin: SupabaseAdmin, scope: FlexScope, crmId: string, ids: Ids, jobId: string) {
  if (!ids.external_id && !ids.name && !ids.code) return;
  // Prefer external_id as the key; else synthesize from name/code
  const externalId = ids.external_id ?? `crm:${crmId}`;
  await supabaseAdmin.from("external_id_map").upsert({
    scope,
    external_import_id: externalId,
    crm_record_id: crmId,
    first_seen_job_id: jobId,
    display_name: ids.name ?? null,
    code: ids.code ?? null,
  }, { onConflict: "scope,external_import_id" });
}

function extractId(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (typeof d.id === "string") return d.id;
  const rec = d.record as Record<string, unknown> | undefined;
  if (rec && typeof rec.id === "string") return rec.id;
  return null;
}

function makeItem(
  jobId: string, scope: FlexScope, ids: Ids,
  action: "create" | "update" | "skip" | "error" | "create_duplicate" | "auto_create_parent",
  resolution: string, parentResolution: string | null,
  properties: Record<string, unknown>, crmId: string | null,
  messages: Array<{ level: string; message: string }>, matched: string | null,
  undoOp: unknown, errorMessage: string | null,
): ItemInsert {
  return {
    job_id: jobId,
    scope,
    external_import_id: ids.external_id ?? ids.name ?? ids.record_id ?? null,
    action: action as never,
    matched_crm_id: matched ?? crmId ?? null,
    source: JSON.parse(JSON.stringify(ids)) as never,
    proposed: JSON.parse(JSON.stringify(properties)) as never,
    messages: JSON.parse(JSON.stringify(messages)) as never,
    resolution,
    parent_resolution: parentResolution,
    undo_op: undoOp ? (JSON.parse(JSON.stringify(undoOp)) as never) : null,
    error_message: errorMessage,
  };
}

type SupabaseAdmin = typeof import("@/integrations/supabase/client.server").supabaseAdmin;
