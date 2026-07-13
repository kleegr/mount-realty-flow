/**
 * Server functions for the flexible import flow.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden: importer role required.");
}

// ---------- Upload + detect ----------

export const flexUpload = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    filename: z.string().min(1),
    fileBase64: z.string().min(1),
  }).parse(d))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { parseRawFile } = await import("./import/flex-parse.server");
    const { detectScopes, autoMapHeaders } = await import("./import/flex-mapping");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const bytes = Uint8Array.from(atob(data.fileBase64), (c) => c.charCodeAt(0)).buffer;
    const parsed = await parseRawFile({ name: data.filename, bytes });
    const detected = detectScopes(parsed.headers);
    const suggestedMap = autoMapHeaders(parsed.headers, detected);

    const { data: job, error } = await supabaseAdmin.from("import_jobs").insert({
      user_id: context.userId,
      filename: parsed.filename,
      file_hash: parsed.fileHash,
      mode: "flexible",
      status: "awaiting_confirm",
      row_count: parsed.rows.length,
      headers: parsed.headers,
      scopes: detected,
      column_map: suggestedMap as never,
      raw_rows: JSON.parse(JSON.stringify(parsed.rows)) as never,
    }).select("id").single();
    if (error) throw new Error(error.message);

    const preview: Array<Record<string, string>> = parsed.rows.slice(0, 20).map((r) => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(r)) out[k] = v == null ? "" : String(v);
      return out;
    });
    return {
      jobId: job.id as string,
      headers: parsed.headers,
      rowCount: parsed.rows.length,
      preview,
      detectedScopes: detected as string[],
      suggestedMap: suggestedMap as Record<string, Record<string, string>>,
    };
  });

// ---------- Confirm ----------

const optionsSchema = z.object({
  duplicateStrategy: z.enum(["skip", "update", "create_duplicate"]),
  duplicateKey: z.enum(["record_id", "external_id", "code", "name"]),
  missingParentProject: z.enum(["auto_create", "unassigned", "fail"]),
  missingParentBuilding: z.enum(["auto_create", "unassigned", "fail"]),
});

export const flexConfirm = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({
    jobId: z.string().uuid(),
    scopes: z.array(z.enum(["project", "building", "unit"])).min(1),
    columnMap: z.record(z.string(), z.record(z.string(), z.string())),
    options: optionsSchema,
  }).parse(d))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: job } = await supabaseAdmin.from("import_jobs").select("id, raw_rows, status").eq("id", data.jobId).maybeSingle();
    if (!job) throw new Error("Job not found");
    if (job.status !== "awaiting_confirm") throw new Error(`Job is ${job.status}, cannot run.`);
    const rawRows = job.raw_rows as unknown;
    const rows = Array.isArray(rawRows) ? (rawRows as Array<Record<string, unknown>>) : [];

    await supabaseAdmin.from("import_jobs").update({
      column_map: data.columnMap as never,
      scopes: data.scopes,
      options: data.options as never,
    }).eq("id", data.jobId);

    const { executeFlexImport } = await import("./import/flex-execute.server");
    const report = await executeFlexImport({
      jobId: data.jobId,
      scopes: data.scopes,
      rows,
      columnMap: data.columnMap,
      options: data.options,
    });
    return { report };
  });

// ---------- Undo ----------

export const flexUndo = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ jobId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");

    const { data: job } = await supabaseAdmin.from("import_jobs").select("id, undone_at, mode").eq("id", data.jobId).maybeSingle();
    if (!job) throw new Error("Job not found");
    if (job.undone_at) throw new Error("This import has already been undone.");

    const { data: items } = await supabaseAdmin
      .from("import_items").select("id, scope, undo_op, matched_crm_id")
      .eq("job_id", data.jobId).not("undo_op", "is", null)
      .order("id", { ascending: false });

    const client = await createCrmClient();
    const { requestObject, normalizeRecordProperties } = await import("./kleegr/object-config.server");
    let reversed = 0; let failed = 0; const errors: string[] = [];
    for (const it of items ?? []) {
      const op = it.undo_op as { kind: string; scope: string; crmId: string; properties?: Record<string, unknown> } | null;
      if (!op) continue;
      try {
        const scope = op.scope === "project" ? "project" : op.scope === "building" ? "building" : "unit";
        if (op.kind === "delete") {
          await requestObject(client, "DELETE", scope, `/records/${op.crmId}`);
        } else if (op.kind === "patch" && op.properties) {
          await requestObject(client, "PUT", scope, `/records/${op.crmId}`, { body: { properties: await normalizeRecordProperties(client, scope, op.properties) } });
        }
        reversed++;
      } catch (err) {
        failed++;
        errors.push(err instanceof Error ? err.message : String(err));
      }
    }

    await supabaseAdmin.from("import_jobs").update({ undone_at: new Date().toISOString() }).eq("id", data.jobId);
    return { reversed, failed, errors: errors.slice(0, 20) };
  });

// ---------- Failed rows CSV ----------

export const flexFailedCsv = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ jobId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: job } = await supabaseAdmin.from("import_jobs").select("raw_rows").eq("id", data.jobId).maybeSingle();
    const raw = job?.raw_rows as { failedCsv?: string } | null;
    return { csv: raw?.failedCsv ?? "" };
  });
