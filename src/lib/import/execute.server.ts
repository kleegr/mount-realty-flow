/**
 * Execute a confirmed Import Job.
 * - Locks the job (status='running')
 * - Upserts Project → Buildings → Units
 * - Creates associations
 * - Recalculates rollups
 * - Writes report
 */
import type { ValidationResult } from "./validate.server";
import { createCrmClient, upsertRecord } from "../kleegr/objects.server";
import { associateRecords } from "../kleegr/associations.server";
import { summarize, writeBuildingRollup, writeProjectRollup } from "../kleegr/rollups.server";

export interface ExecuteReport {
  correlationId: string;
  status: "success" | "success_with_warnings" | "partial_failure" | "failed";
  projects_created: number;
  projects_updated: number;
  buildings_created: number;
  buildings_updated: number;
  units_created: number;
  units_updated: number;
  associations_ok: number;
  associations_failed: number;
  rollup_ok: number;
  rollup_failed: number;
  errors: Array<{ scope: string; ref: string; message: string }>;
  warnings: string[];
  started_at: string;
  completed_at: string;
}

export async function executeImport(jobId: string, validation: ValidationResult): Promise<ExecuteReport> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const correlationId = crypto.randomUUID();
  const started = new Date().toISOString();

  await supabaseAdmin.from("import_jobs").update({ status: "running", started_at: started }).eq("id", jobId);

  const report: ExecuteReport = {
    correlationId,
    status: "success",
    projects_created: 0, projects_updated: 0,
    buildings_created: 0, buildings_updated: 0,
    units_created: 0, units_updated: 0,
    associations_ok: 0, associations_failed: 0,
    rollup_ok: 0, rollup_failed: 0,
    errors: [], warnings: [],
    started_at: started,
    completed_at: started,
  };

  try {
    const client = await createCrmClient();

    // Map external → CRM id for this run
    const projectCrm = new Map<string, string>();
    const buildingCrm = new Map<string, string>();
    const unitCrm = new Map<string, { crmId: string; buildingImportId: string; projectImportId: string; availability: string; stage: string }>();

    // 1) Projects
    for (const p of validation.projects) {
      try {
        const res = await upsertRecord({
          client, scope: "project", externalImportId: p.projectImportId,
          fallbackSearch: p.code ? { project_code: p.code } : undefined,
          properties: p.properties, jobId,
        });
        projectCrm.set(p.projectImportId, res.crmId);
        if (res.action === "created") report.projects_created++; else report.projects_updated++;
      } catch (err) {
        report.errors.push({ scope: "project", ref: p.projectImportId, message: msg(err) });
      }
    }

    // 2) Buildings
    for (const b of validation.buildings) {
      try {
        const res = await upsertRecord({
          client, scope: "building", externalImportId: b.buildingImportId,
          fallbackSearch: b.code ? { building_code: b.code } : undefined,
          properties: b.properties, jobId,
        });
        buildingCrm.set(b.buildingImportId, res.crmId);
        if (res.action === "created") report.buildings_created++; else report.buildings_updated++;
      } catch (err) {
        report.errors.push({ scope: "building", ref: b.buildingImportId, message: msg(err) });
      }
    }

    // 3) Units
    for (const u of validation.units) {
      try {
        const res = await upsertRecord({
          client, scope: "unit", externalImportId: u.unitImportId,
          fallbackSearch: u.unitNumber && u.buildingImportId
            ? { unit_number: u.unitNumber }
            : undefined,
          properties: u.properties, jobId,
        });
        unitCrm.set(u.unitImportId, {
          crmId: res.crmId,
          buildingImportId: u.buildingImportId,
          projectImportId: u.projectImportId,
          availability: u.availability,
          stage: u.stage,
        });
        if (res.action === "created") report.units_created++; else report.units_updated++;
      } catch (err) {
        report.errors.push({ scope: "unit", ref: u.unitImportId, message: msg(err) });
      }
    }

    // 4) Associations
    for (const b of validation.buildings) {
      const bId = buildingCrm.get(b.buildingImportId);
      const pId = b.projectImportId ? projectCrm.get(b.projectImportId) : null;
      if (bId && pId) {
        const r = await associateRecords(client, pId, bId, "project_to_building");
        if (r.ok) report.associations_ok++; else {
          report.associations_failed++;
          report.warnings.push(`Project↔Building association failed for ${b.buildingImportId}: ${r.message}`);
        }
      }
    }
    for (const u of validation.units) {
      const uId = unitCrm.get(u.unitImportId)?.crmId;
      const bId = u.buildingImportId ? buildingCrm.get(u.buildingImportId) : null;
      if (uId && bId) {
        const r = await associateRecords(client, bId, uId, "building_to_unit");
        if (r.ok) report.associations_ok++; else {
          report.associations_failed++;
          report.warnings.push(`Building↔Unit association failed for ${u.unitImportId}: ${r.message}`);
        }
      }
    }

    // 5) Rollups (Building then Project) using the units we just wrote
    const unitsByBuilding = new Map<string, Array<{ availability: string; stage: string }>>();
    const unitsByProject = new Map<string, Array<{ availability: string; stage: string }>>();
    for (const u of unitCrm.values()) {
      if (u.buildingImportId) {
        const arr = unitsByBuilding.get(u.buildingImportId) ?? [];
        arr.push({ availability: u.availability, stage: u.stage });
        unitsByBuilding.set(u.buildingImportId, arr);
      }
      if (u.projectImportId) {
        const arr = unitsByProject.get(u.projectImportId) ?? [];
        arr.push({ availability: u.availability, stage: u.stage });
        unitsByProject.set(u.projectImportId, arr);
      }
    }
    for (const [bImport, us] of unitsByBuilding) {
      const crmId = buildingCrm.get(bImport);
      if (!crmId) continue;
      try { await writeBuildingRollup(client, crmId, summarize(us)); report.rollup_ok++; }
      catch (err) { report.rollup_failed++; report.warnings.push(`Building rollup failed for ${bImport}: ${msg(err)}`); }
    }
    for (const [pImport, us] of unitsByProject) {
      const crmId = projectCrm.get(pImport);
      if (!crmId) continue;
      try { await writeProjectRollup(client, crmId, summarize(us)); report.rollup_ok++; }
      catch (err) { report.rollup_failed++; report.warnings.push(`Project rollup failed for ${pImport}: ${msg(err)}`); }
    }

    // 6) Determine outcome
    if (report.errors.length > 0) {
      const totalItems = validation.projects.length + validation.buildings.length + validation.units.length;
      report.status = report.errors.length === totalItems ? "failed" : "partial_failure";
    } else if (report.warnings.length > 0 || report.associations_failed > 0 || report.rollup_failed > 0) {
      report.status = "success_with_warnings";
    } else {
      report.status = "success";
    }
  } catch (err) {
    report.status = "failed";
    report.errors.push({ scope: "job", ref: jobId, message: msg(err) });
  }

  report.completed_at = new Date().toISOString();

  await supabaseAdmin.from("import_jobs").update({
    status: report.status,
    completed_at: report.completed_at,
    projects_created: report.projects_created,
    projects_updated: report.projects_updated,
    buildings_created: report.buildings_created,
    buildings_updated: report.buildings_updated,
    units_created: report.units_created,
    units_updated: report.units_updated,
    warnings_count: (validation.warnings.length + report.warnings.length),
    errors_count: report.errors.length,
    report: report as unknown as Record<string, unknown>,
    error_message: report.errors[0]?.message ?? null,
  }).eq("id", jobId);

  return report;
}

function msg(err: unknown) { return err instanceof Error ? err.message : String(err); }
