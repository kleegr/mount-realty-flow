/**
 * CRM → local mirror sync worker. Server-only.
 * Paginates through GHL custom-object records and upserts them into
 * external_id_map so the app knows about pre-existing CRM records
 * (i.e. records not created through the Import Center).
 */
import { createCrmClient, type CrmClient } from "@/lib/kleegr/client.server";
import { FIELDS } from "@/lib/kleegr/field-map";

export type SyncScope = "project" | "building" | "unit";

interface SyncCounters {
  total: number;
  processed: number;
  created: number;
  updated: number;
  errors: number;
  errorSummary: string[];
}

function objectKey(client: CrmClient, scope: SyncScope): string {
  return scope === "project"
    ? client.config.project_object_key
    : scope === "building"
      ? client.config.building_object_key
      : client.config.unit_object_key;
}

function extractRecords(data: unknown): Array<Record<string, unknown>> {
  if (!data || typeof data !== "object") return [];
  const d = data as Record<string, unknown>;
  const arr = (d.records ?? d.data ?? []) as unknown;
  return Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
}

function extractProps(rec: Record<string, unknown>): Record<string, unknown> {
  const p = (rec.properties ?? rec.data ?? {}) as Record<string, unknown>;
  return p && typeof p === "object" ? p : {};
}

function displayName(scope: SyncScope, props: Record<string, unknown>): string {
  if (scope === "project") return String(props[FIELDS.project.name] ?? "");
  if (scope === "building") return String(props[FIELDS.building.name] ?? "");
  const unit = String(props[FIELDS.unit.name] ?? "");
  const num = String(props[FIELDS.unit.number] ?? "");
  return unit || num ? `${unit || "Unit"}${num ? ` ${num}` : ""}`.trim() : "";
}

function codeFor(scope: SyncScope, props: Record<string, unknown>): string {
  if (scope === "project") return String(props[FIELDS.project.code] ?? "");
  if (scope === "building") return String(props[FIELDS.building.code] ?? "");
  return String(props[FIELDS.unit.number] ?? "");
}

function externalIdFor(scope: SyncScope, props: Record<string, unknown>): string {
  if (scope === "project") return String(props[FIELDS.project.external_import_id] ?? "");
  if (scope === "building") return String(props[FIELDS.building.external_import_id] ?? "");
  return String(props[FIELDS.unit.external_import_id] ?? "");
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
  const key = objectKey(client, scope);
  const locationId = client.config.location_id;
  if (!locationId) throw new Error("crm_config.location_id is not set");

  let page = 1;
  const pageLimit = 100;
  // Hard safety cap to avoid runaway loops on unbounded APIs.
  const maxPages = 500;

  while (page <= maxPages) {
    const res = await client.request<unknown>(
      "POST",
      `/objects/${key}/records/search`,
      { body: { locationId, page, pageLimit, query: {} } },
    );
    const records = extractRecords(res.data);
    if (records.length === 0) break;

    counters.total += records.length;

    const rows = records
      .map((rec) => {
        const crmId = typeof rec.id === "string" ? rec.id : null;
        if (!crmId) return null;
        const props = extractProps(rec);
        const extId = externalIdFor(scope, props) || `crm:${crmId}`;
        return {
          scope,
          external_import_id: extId,
          crm_record_id: crmId,
          display_name: displayName(scope, props) || null,
          code: codeFor(scope, props) || null,
          parent_crm_id: null as string | null,
          updated_at: new Date().toISOString(),
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length > 0) {
      // Bulk upsert; PostgREST returns the affected rows so we can distinguish created vs updated
      // by whether a row already existed for that (scope, external_import_id).
      const existingIds = new Set(
        (
          await supabaseAdmin
            .from("external_id_map")
            .select("crm_record_id")
            .eq("scope", scope)
            .in("crm_record_id", rows.map((r) => r.crm_record_id))
        ).data?.map((r) => r.crm_record_id) ?? [],
      );

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
