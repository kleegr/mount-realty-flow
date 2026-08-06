/**
 * CRM → local mirror sync worker. Server-only.
 * Paginates through GHL custom-object records and upserts them into
 * external_id_map so the app knows about pre-existing CRM records
 * (i.e. records not created through the Import Center).
 *
 * HARD-WON RULES (2026-08-06 incident - a sync flattened the whole tree):
 *  1. NEVER write parent_crm_id: null in the record upsert. Parents are
 *     rebuilt from CRM associations in a separate pass (below); blindly
 *     nulling them collapsed every project into "Unassigned".
 *  2. NEVER re-key a record that is already mapped. Records created by the
 *     Import Center carry keys like "eden-edge-b1-101" in external_id_map
 *     but not necessarily in their CRM properties; keying by properties
 *     alone created duplicate crm:{id} rows for the same record. Always
 *     reuse the existing row's key for a known crm_record_id.
 */
import { createCrmClient, type CrmClient } from "@/lib/kleegr/client.server";
import { FIELDS } from "@/lib/kleegr/field-map";
import { requestObject } from "@/lib/kleegr/object-config.server";

export type SyncScope = "project" | "building" | "unit";

interface SyncCounters {
  total: number;
  processed: number;
  created: number;
  updated: number;
  errors: number;
  errorSummary: string[];
}

function extractRecords(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const nestedData = d.data && typeof d.data === "object" ? (d.data as Record<string, unknown>) : null;
  const arr = (d.records ?? d.items ?? d.results ?? nestedData?.records ?? nestedData?.items ?? d.data ?? []) as unknown;
  return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
}

function extractProps(rec: Record<string, unknown>): Record<string, unknown> {
  const p = (rec.properties ?? rec.data ?? {}) as Record<string, unknown>;
  return p && typeof p === "object" ? p : {};
}

function readProp(props: Record<string, unknown>, key: string): unknown {
  if (key in props) return props[key];
  const suffix = `.${key}`;
  for (const [k, v] of Object.entries(props)) {
    if (k.endsWith(suffix)) return v;
  }
  return undefined;
}

function displayName(scope: SyncScope, props: Record<string, unknown>): string {
  if (scope === "project") return String(readProp(props, FIELDS.project.name) ?? "");
  if (scope === "building") return String(readProp(props, FIELDS.building.name) ?? "");
  const unit = String(readProp(props, FIELDS.unit.name) ?? "");
  const num = String(readProp(props, FIELDS.unit.number) ?? "");
  return unit || num ? `${unit || "Unit"}${num ? ` ${num}` : ""}`.trim() : "";
}

function codeFor(scope: SyncScope, props: Record<string, unknown>): string {
  if (scope === "project") return String(readProp(props, FIELDS.project.code) ?? "");
  if (scope === "building") return String(readProp(props, FIELDS.building.code) ?? "");
  return String(readProp(props, FIELDS.unit.number) ?? "");
}

function externalIdFor(scope: SyncScope, props: Record<string, unknown>): string {
  if (scope === "project") return String(readProp(props, FIELDS.project.external_import_id) ?? "");
  if (scope === "building") return String(readProp(props, FIELDS.building.external_import_id) ?? "");
  return String(readProp(props, FIELDS.unit.external_import_id) ?? "");
}

function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

async function updateJob(
  jobId: string,
  patch: Partial<{
    total: number;
    processed: number;
    created_count: number;
    updated_count: number;
    error_count: number;
    status: string;
    finished_at: string;
    error_summary: string;
  }>,
) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  await supabaseAdmin.from("sync_jobs").update(patch).eq("id", jobId);
}

async function syncScope(jobId: string, scope: SyncScope, counters: SyncCounters): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const client = await createCrmClient();
  const locationId = client.config.location_id;
  if (!locationId) throw new Error("crm_config.location_id is not set");

  let page = 1;
  const pageLimit = 100;
  // Hard safety cap to avoid runaway loops on unbounded APIs.
  const maxPages = 500;

  while (page <= maxPages) {
    const res = await requestObject<unknown>(
      client,
      "POST",
      scope,
      `/records/search`,
      { body: { locationId, page, pageLimit, query: "" } },
    );
    const records = extractRecords(res.data);
    if (records.length === 0) break;

    counters.total += records.length;

    const crmIds = records.map((r) => (typeof r.id === "string" ? r.id : "")).filter(Boolean);

    // Existing rows for these records: their keys MUST be reused (rule 2).
    const { data: existingRows } = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id, external_import_id")
      .eq("scope", scope)
      .in("crm_record_id", crmIds);
    const keyByCrm = new Map((existingRows ?? []).map((r) => [r.crm_record_id, r.external_import_id]));

    const rows = records
      .map((rec) => {
        const crmId = typeof rec.id === "string" ? rec.id : null;
        if (!crmId) return null;
        const props = extractProps(rec);
        const extId = keyByCrm.get(crmId) ?? externalIdFor(scope, props) ?? "";
        return {
          scope,
          external_import_id: extId || `crm:${crmId}`,
          crm_record_id: crmId,
          display_name: displayName(scope, props) || null,
          code: codeFor(scope, props) || null,
          // parent_crm_id deliberately NOT written here (rule 1).
          updated_at: new Date().toISOString(),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length > 0) {
      const existingIds = new Set((existingRows ?? []).map((r) => r.crm_record_id));

      const { error } = await supabaseAdmin.from("external_id_map").upsert(rows, {
        onConflict: "scope,external_import_id",
      });
      if (error) {
        counters.errors += rows.length;
        counters.errorSummary.push(error.message.slice(0, 200));
      } else {
        for (const r of rows) {
          if (existingIds.has(r.crm_record_id)) counters.updated++;
          else counters.created++;
        }
      }

      if (scope === "unit") {
        const unitStateRows = records
          .map((rec) => {
            const crmId = typeof rec.id === "string" ? rec.id : null;
            if (!crmId) return null;
            const props = extractProps(rec);
            return {
              unit_crm_id: crmId,
              availability: normalizeAvailability(readProp(props, FIELDS.unit.availability)),
              stage: normalizeStage(readProp(props, FIELDS.unit.stage)),
            };
          })
          .filter((r): r is NonNullable<typeof r> => r !== null);

        if (unitStateRows.length > 0) {
          const { error: usError } = await supabaseAdmin
            .from("unit_state")
            .upsert(unitStateRows, { onConflict: "unit_crm_id" });
          if (usError) {
            counters.errors += unitStateRows.length;
            counters.errorSummary.push(`unit state cache: ${usError.message}`.slice(0, 200));
          }
        }
      }
    }

    counters.processed += records.length;
    await updateJob(jobId, {
      total: counters.total,
      processed: counters.processed,
      created_count: counters.created,
      updated_count: counters.updated,
      error_count: counters.errors,
    });

    if (records.length < pageLimit) break;
    page++;
  }
}

function normalizeAvailability(value: unknown): string | null {
  const raw = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
  const key = raw.trim().toLowerCase().replace(/[\s_/-]+/g, "");
  if (!key) return null;
  if (key === "available") return "Available";
  if (key === "notavailable") return "Not Available";
  return raw.trim();
}
function normalizeStage(value: unknown): string | null {
  const raw = Array.isArray(value) ? String(value[0] ?? "") : String(value ?? "");
  const key = raw.trim().toLowerCase().replace(/[\s_/-]+/g, "");
  if (!key) return null;
  if (key === "available") return "Available";
  if (key === "reservedlocked") return "Reserved/Locked";
  if (key === "undercontract") return "Under Contract";
  if (key === "closedsold") return "Closed/Sold";
  return raw.trim();
}

/**
 * Rebuild parent links from the CRM's own associations. One relations call
 * per building answers BOTH questions: which project owns the building, and
 * which units the building owns.
 */
async function fillParentsFromAssociations(client: CrmClient, counters: SyncCounters): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const locationId = String(client.config.location_id ?? "");

  const defsRes = await client.request<{ associations?: Array<Record<string, unknown>> }>("GET", "/associations/", {
    query: { locationId, skip: 0, limit: 100 },
  });
  const defs = defsRes.data?.associations ?? [];
  const p2b = defs.find((d) => norm(d.key).includes("project") && norm(d.key).includes("building"));
  const b2u = defs.find((d) => norm(d.key).includes("building") && norm(d.key).includes("unit"));
  const p2bId = String(p2b?.id ?? "");
  const b2uId = String(b2u?.id ?? "");
  if (!p2bId && !b2uId) {
    counters.errorSummary.push("no project/building/unit association definitions found - parents not rebuilt");
    return;
  }

  const [{ data: buildingRows }, { data: projectRows }, { data: unitRows }] = await Promise.all([
    supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", "building"),
    supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", "project"),
    supabaseAdmin.from("external_id_map").select("crm_record_id").eq("scope", "unit"),
  ]);
  const buildingIds = (buildingRows ?? []).map((r) => r.crm_record_id);
  const projectIds = new Set((projectRows ?? []).map((r) => r.crm_record_id));
  const unitIds = new Set((unitRows ?? []).map((r) => r.crm_record_id));

  const buildingParent = new Map<string, string>();
  const unitParent = new Map<string, string>();

  const walkBuilding = async (bId: string) => {
    try {
      const rRes = await client.request<{ relations?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
        "GET",
        `/associations/relations/${bId}`,
        { query: { locationId, skip: 0, limit: 200 } },
      );
      const body = rRes.data as Record<string, unknown> | Array<Record<string, unknown>>;
      const relations = Array.isArray(body)
        ? body
        : ((body?.relations ?? (body as Record<string, unknown>)?.data ?? []) as Array<Record<string, unknown>>);
      for (const rel of Array.isArray(relations) ? relations : []) {
        const assocId = String(rel.associationId ?? rel.association_id ?? "");
        const a = String(rel.firstRecordId ?? rel.first_record_id ?? "");
        const b = String(rel.secondRecordId ?? rel.second_record_id ?? "");
        const other = a === bId ? b : a;
        if (!other) continue;
        if (assocId === p2bId && projectIds.has(other)) buildingParent.set(bId, other);
        else if (assocId === b2uId && unitIds.has(other)) unitParent.set(other, bId);
      }
    } catch {
      counters.errors++;
    }
  };

  for (let i = 0; i < buildingIds.length; i += 5) {
    await Promise.all(buildingIds.slice(i, i + 5).map(walkBuilding));
  }

  // Write parents grouped by parent value to keep the update count small.
  const byParentB = new Map<string, string[]>();
  for (const [b, p] of buildingParent) {
    const arr = byParentB.get(p) ?? [];
    arr.push(b);
    byParentB.set(p, arr);
  }
  for (const [p, bs] of byParentB) {
    await supabaseAdmin.from("external_id_map").update({ parent_crm_id: p }).eq("scope", "building").in("crm_record_id", bs);
  }
  const byParentU = new Map<string, string[]>();
  for (const [u, b] of unitParent) {
    const arr = byParentU.get(b) ?? [];
    arr.push(u);
    byParentU.set(b, arr);
  }
  for (const [b, us] of byParentU) {
    for (let i = 0; i < us.length; i += 200) {
      await supabaseAdmin.from("external_id_map").update({ parent_crm_id: b }).eq("scope", "unit").in("crm_record_id", us.slice(i, i + 200));
    }
  }
}

export async function runSync(jobId: string, scope: SyncScope | "all"): Promise<void> {
  const counters: SyncCounters = {
    total: 0, processed: 0, created: 0, updated: 0, errors: 0, errorSummary: [],
  };
  const scopes: SyncScope[] = scope === "all" ? ["project", "building", "unit"] : [scope];

  try {
    for (const s of scopes) {
      try {
        await syncScope(jobId, s, counters);
      } catch (err) {
        counters.errors++;
        counters.errorSummary.push(
          `${s}: ${err instanceof Error ? err.message : String(err)}`.slice(0, 250),
        );
      }
    }

    // Rebuild the hierarchy from CRM associations after the records land.
    try {
      const client = await createCrmClient();
      await fillParentsFromAssociations(client, counters);
    } catch (err) {
      counters.errors++;
      counters.errorSummary.push(`parents: ${err instanceof Error ? err.message : String(err)}`.slice(0, 250));
    }

    const status = counters.errors === 0 ? "success" : counters.processed > 0 ? "partial" : "failed";
    await updateJob(jobId, {
      status,
      finished_at: new Date().toISOString(),
      total: counters.total,
      processed: counters.processed,
      created_count: counters.created,
      updated_count: counters.updated,
      error_count: counters.errors,
      error_summary: counters.errorSummary.join(" | ").slice(0, 2000) || null,
    } as never);
  } catch (err) {
    await updateJob(jobId, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error_summary: (err instanceof Error ? err.message : String(err)).slice(0, 2000),
      total: counters.total,
      processed: counters.processed,
      created_count: counters.created,
      updated_count: counters.updated,
      error_count: counters.errors + 1,
    });
  }
}
