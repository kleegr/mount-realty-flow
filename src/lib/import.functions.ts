/**
 * Server functions for the Import Center.
 * Client-safe module — all `.server` imports happen inside handlers.
 */
import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";
import { buildCsvTemplate } from "./import/parse.server";

async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) {
    throw new Error("Forbidden: importer role required.");
  }
}

const uploadInput = z.object({
  filename: z.string().min(1),
  fileBase64: z.string().min(1),
});

export const uploadAndValidate = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => uploadInput.parse(data))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { parseInventoryFile } = await import("./import/parse.server");
    const { validateRows } = await import("./import/validate.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const bytes = Uint8Array.from(atob(data.fileBase64), (c) => c.charCodeAt(0)).buffer;
    const parsed = await parseInventoryFile({ name: data.filename, bytes });
    const validation = validateRows(parsed.rows);

    // Merge header issues as blocking errors
    for (const h of parsed.headerIssues) validation.errors.unshift({ level: "error", message: h });

    const status = validation.errors.length > 0 ? "awaiting_confirm" : "awaiting_confirm";
    const { data: job, error } = await supabaseAdmin
      .from("import_jobs")
      .insert({
        user_id: context.userId,
        filename: parsed.filename,
        file_hash: parsed.fileHash,
        mode: validation.mode,
        status,
        row_count: validation.totalRows,
        skipped: validation.skippedRows,
        warnings_count: validation.warnings.length,
        errors_count: validation.errors.length,
        validation_snapshot: JSON.parse(JSON.stringify(validation)),
      })
      .select("id")
      .single();
    if (error) throw new Error("Failed to create import job: " + error.message);

    // Persist per-item preview rows
    const items = [
      ...validation.projects.map((p, i) => ({
        job_id: job.id, row_number: null as unknown as number, import_row_id: p.projectImportId,
        scope: "project" as const, external_import_id: p.projectImportId,
        action: (p.errors.length ? "error" : "create") as "create" | "error",
        source: JSON.parse(JSON.stringify(p)) as never,
        proposed: JSON.parse(JSON.stringify(p.properties)) as never,
        messages: [...p.errors.map((m) => ({ level: "error", message: m })), ...p.warnings.map((m) => ({ level: "warning", message: m }))] as never,
      })),
      ...validation.buildings.map((b) => ({
        job_id: job.id, row_number: null as unknown as number, import_row_id: b.buildingImportId,
        scope: "building" as const, external_import_id: b.buildingImportId,
        action: (b.errors.length ? "error" : "create") as "create" | "error",
        source: JSON.parse(JSON.stringify(b)) as never,
        proposed: JSON.parse(JSON.stringify(b.properties)) as never,
        messages: [...b.errors.map((m) => ({ level: "error", message: m })), ...b.warnings.map((m) => ({ level: "warning", message: m }))] as never,
      })),
      ...validation.units.map((u) => ({
        job_id: job.id, row_number: null as unknown as number, import_row_id: u.importRowIds[0] ?? null,
        scope: "unit" as const, external_import_id: u.unitImportId,
        action: (u.errors.length ? "error" : "create") as "create" | "error",
        source: JSON.parse(JSON.stringify({ unitImportId: u.unitImportId, buildingImportId: u.buildingImportId, projectImportId: u.projectImportId, unitName: u.unitName, unitNumber: u.unitNumber, availability: u.availability, stage: u.stage })) as never,
        proposed: JSON.parse(JSON.stringify(u.properties)) as never,
        messages: [...u.errors.map((m) => ({ level: "error", message: m })), ...u.warnings.map((m) => ({ level: "warning", message: m }))] as never,
      })),
    ];
    if (items.length > 0) await supabaseAdmin.from("import_items").insert(items);

    return { jobId: job.id as string };
  });

export const confirmImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ jobId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { executeImport } = await import("./import/execute.server");
    const { data: job, error } = await supabaseAdmin
      .from("import_jobs")
      .select("id, status, validation_snapshot, user_id")
      .eq("id", data.jobId)
      .maybeSingle();
    if (error || !job) throw new Error("Import job not found");
    if (job.status !== "awaiting_confirm") throw new Error(`Job is not awaiting confirmation (status: ${job.status})`);
    const validation = job.validation_snapshot as never;
    const report = await executeImport(job.id, validation);
    return { report };
  });

export const getJob = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: unknown) => z.object({ jobId: z.string().uuid() }).parse(data))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const [{ data: job }, { data: items }] = await Promise.all([
      supabaseAdmin.from("import_jobs").select("*").eq("id", data.jobId).maybeSingle(),
      supabaseAdmin.from("import_items").select("*").eq("job_id", data.jobId).order("scope"),
    ]);
    if (!job) throw new Error("Job not found");
    return { job, items: items ?? [] };
  });

export const listJobs = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireImporter(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("import_jobs")
      .select("id, filename, mode, status, row_count, projects_created, projects_updated, buildings_created, buildings_updated, units_created, units_updated, errors_count, warnings_count, created_at, completed_at")
      .order("created_at", { ascending: false })
      .limit(50);
    return { jobs: data ?? [] };
  });

export const getCsvTemplate = createServerFn({ method: "GET" }).handler(async () => {
  return { csv: buildCsvTemplate() };
});
