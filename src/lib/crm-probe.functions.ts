import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * CRM PROBE — the groundwork for the Lazers contact + opportunity import.
 *
 * Two unknowns have to be settled BEFORE 750 API calls get written, not after
 * one dies at row 400:
 *
 *   1. FIELD SCHEMA. Contact custom fields live on a different API than the
 *      custom objects (Projects/Buildings/Units) this app already drives. The
 *      import needs the exact field ids/keys and — critically — the exact
 *      picklist option values. "Buyer" vs "buyer" is the difference between a
 *      clean run and 183 rows of 422s, which is precisely the bug class that
 *      broke the inventory import (property_type).
 *
 *   2. TOKEN SCOPES. Everything done in GHL so far is: read opportunities,
 *      read/write custom objects. The import needs contacts.write,
 *      opportunities.write and associations/relation.write — three permissions
 *      KLEEGR_CRM_TOKEN has never been asked for. If they're missing, the token
 *      must be regenerated, and that's a 30-minute discovery, not a 400-row one.
 *
 * WHY THE WRITE PROBE IS SAFE:
 *   - the test contact is deleted immediately
 *   - the test opportunity is created in a RELEASE stage (New Inquiry-type),
 *     which maps to Available — it cannot reserve anything — and is deleted
 *   - the association is created with the SUGGESTED label, which the engine now
 *     provably ignores end to end (see release.server.ts rule 1). A suggested
 *     unit is never locked, released, or touched.
 *   Nothing here can move real inventory even if every cleanup step failed.
 */

async function roles(userId: string): Promise<string[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  return (data ?? []).map((r) => r.role);
}

interface RawField {
  id?: string;
  name?: string;
  fieldKey?: string;
  dataType?: string;
  model?: string;
  picklistOptions?: unknown;
  picklistOptionValues?: unknown;
  options?: unknown;
}

export interface CrmField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
  model: string;
  options: string[];
}

function normOptions(f: RawField): string[] {
  const raw = f.picklistOptions ?? f.picklistOptionValues ?? f.options;
  if (!Array.isArray(raw)) return [];
  return raw
    .map((o) => {
      if (typeof o === "string") return o;
      if (o && typeof o === "object") {
        const r = o as Record<string, unknown>;
        const v = r.value ?? r.name ?? r.label ?? r.key;
        return typeof v === "string" ? v : null;
      }
      return null;
    })
    .filter((v): v is string => Boolean(v));
}

/**
 * Read-only. Dumps every Contact + Opportunity custom field with its exact
 * key and picklist values, so the importer can be mapped against reality
 * instead of against a screenshot.
 */
export const getCrmFieldSchema = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const r = await roles(context.userId);
    if (!r.includes("admin") && !r.includes("importer")) throw new Error("Forbidden: importer role required.");

    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();
    const locationId = client.config.location_id;
    if (!locationId) throw new Error("crm_config.location_id is not set.");

    try {
      const res = await client.request<{ customFields?: RawField[] }>(
        "GET",
        `/locations/${locationId}/customFields`,
        { query: { model: "all" } },
      );
      const all = Array.isArray(res.data?.customFields) ? res.data.customFields : [];
      const fields: CrmField[] = all.map((f) => ({
        id: String(f.id ?? ""),
        name: String(f.name ?? ""),
        fieldKey: String(f.fieldKey ?? ""),
        dataType: String(f.dataType ?? ""),
        model: String(f.model ?? ""),
        options: normOptions(f),
      }));
      return {
        ok: true as const,
        count: fields.length,
        contact: fields.filter((f) => /contact/i.test(f.model) || /^contact\./.test(f.fieldKey)),
        opportunity: fields.filter((f) => /opportunit/i.test(f.model) || /^opportunity\./.test(f.fieldKey)),
        other: fields.filter(
          (f) =>
            !/contact/i.test(f.model) &&
            !/^contact\./.test(f.fieldKey) &&
            !/opportunit/i.test(f.model) &&
            !/^opportunity\./.test(f.fieldKey),
        ),
      };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
        hint: "A 401/403 here means the token lacks locations/customFields.readonly.",
      };
    }
  });

interface Step {
  step: string;
  ok: boolean;
  detail: string;
}

/**
 * Exercises the three write scopes the import depends on, then cleans up.
 * Admin only, and deliberately explicit — never runs on page load.
 */
export const probeCrmWriteScopes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ confirm: z.literal("RUN") }).parse(d))
  .handler(async ({ context }) => {
    const r = await roles(context.userId);
    if (!r.includes("admin")) throw new Error("Forbidden: admin only.");

    const { createCrmClient } = await import("./kleegr/client.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const client = await createCrmClient();
    const locationId = client.config.location_id;
    if (!locationId) throw new Error("crm_config.location_id is not set.");

    const steps: Step[] = [];
    const stamp = Date.now();
    let contactId: string | null = null;
    let opportunityId: string | null = null;
    let relationId: string | null = null;

    const msg = (e: unknown) => {
      const raw = e instanceof Error ? e.message : String(e);
      return /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
    };

    // ---- 1. contacts.write
    try {
      const res = await client.request<Record<string, unknown>>("POST", "/contacts/", {
        body: {
          locationId,
          firstName: "Kleegr",
          lastName: `Probe ${stamp}`,
          source: "kleegr-probe",
          tags: ["kleegr-probe"],
        },
      });
      const d = (res.data ?? {}) as Record<string, unknown>;
      const c = (d.contact && typeof d.contact === "object" ? d.contact : d) as Record<string, unknown>;
      contactId = typeof c.id === "string" ? c.id : null;
      steps.push({ step: "contacts.write — create", ok: Boolean(contactId), detail: contactId ?? JSON.stringify(d).slice(0, 240) });
    } catch (err) {
      steps.push({ step: "contacts.write — create", ok: false, detail: msg(err) });
    }

    // ---- 2. opportunities.write (release stage only — cannot reserve anything)
    let pipelineId: string | null = null;
    let stageId: string | null = null;
    let stageName: string | null = null;
    try {
      const cat = await client.request<{ pipelines?: Array<Record<string, unknown>> }>(
        "GET",
        "/opportunities/pipelines",
        { query: { locationId } },
      );
      const pipes = cat.data?.pipelines ?? [];
      const { data: known } = await supabaseAdmin
        .from("crm_pipelines")
        .select("pipeline_id, pipeline_name, release_stage_names")
        .limit(20);
      const preferred = (known ?? []).find((k) => /local/i.test(String(k.pipeline_name ?? "")));
      const pipe =
        pipes.find((p) => typeof p.id === "string" && p.id === preferred?.pipeline_id) ?? pipes[0];
      pipelineId = typeof pipe?.id === "string" ? pipe.id : null;
      const stages = Array.isArray(pipe?.stages) ? (pipe.stages as Array<Record<string, unknown>>) : [];
      const releaseNames = (preferred?.release_stage_names ?? []) as string[];
      const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
      const releaseStage =
        stages.find((s) => releaseNames.some((n) => norm(n) === norm(s.name))) ?? stages[0];
      stageId = typeof releaseStage?.id === "string" ? releaseStage.id : null;
      stageName = typeof releaseStage?.name === "string" ? releaseStage.name : null;
      steps.push({
        step: "pipelines — read",
        ok: Boolean(pipelineId && stageId),
        detail: `${String(pipe?.name ?? "?")} → stage "${stageName ?? "?"}" (release stage, maps to Available)`,
      });
    } catch (err) {
      steps.push({ step: "pipelines — read", ok: false, detail: msg(err) });
    }

    if (contactId && pipelineId && stageId) {
      try {
        const res = await client.request<Record<string, unknown>>("POST", "/opportunities/", {
          body: {
            locationId,
            pipelineId,
            pipelineStageId: stageId,
            contactId,
            name: `Kleegr Probe ${stamp}`,
            status: "open",
          },
        });
        const d = (res.data ?? {}) as Record<string, unknown>;
        const o = (d.opportunity && typeof d.opportunity === "object" ? d.opportunity : d) as Record<string, unknown>;
        opportunityId = typeof o.id === "string" ? o.id : null;
        steps.push({
          step: "opportunities.write — create",
          ok: Boolean(opportunityId),
          detail: opportunityId ?? JSON.stringify(d).slice(0, 240),
        });
      } catch (err) {
        steps.push({ step: "opportunities.write — create", ok: false, detail: msg(err) });
      }
    } else {
      steps.push({ step: "opportunities.write — create", ok: false, detail: "skipped — no contact or pipeline" });
    }

    // ---- 3. associations/relation.write, via the SUGGESTED label (inert by design)
    let suggestedAssocId: string | null = null;
    let unitId: string | null = null;
    try {
      const res = await client.request<{ associations?: Array<Record<string, unknown>> }>("GET", "/associations/", {
        query: { locationId, skip: 0, limit: 100 },
      });
      const defs = res.data?.associations ?? [];
      const suggested = defs.find((d) => /suggest/i.test(String(d.key ?? "")));
      suggestedAssocId = typeof suggested?.id === "string" ? suggested.id : null;
      steps.push({
        step: "associations — read defs",
        ok: Boolean(suggestedAssocId),
        detail: suggestedAssocId ? `Suggested Units = ${suggestedAssocId}` : "Suggested association not found",
      });
    } catch (err) {
      steps.push({ step: "associations — read defs", ok: false, detail: msg(err) });
    }

    const { data: anyUnit } = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id")
      .eq("scope", "unit")
      .limit(1)
      .maybeSingle();
    unitId = anyUnit?.crm_record_id ?? null;

    if (opportunityId && suggestedAssocId && unitId) {
      try {
        const res = await client.request<Record<string, unknown>>("POST", "/associations/relations", {
          body: {
            locationId,
            associationId: suggestedAssocId,
            firstRecordId: opportunityId,
            secondRecordId: unitId,
          },
        });
        const d = (res.data ?? {}) as Record<string, unknown>;
        const rel = (d.relation && typeof d.relation === "object" ? d.relation : d) as Record<string, unknown>;
        relationId = typeof rel.id === "string" ? rel.id : null;
        steps.push({
          step: "associations/relation.write — create (Suggested, inert)",
          ok: Boolean(relationId),
          detail: relationId ? `${relationId} — unit ${unitId}` : JSON.stringify(d).slice(0, 300),
        });
      } catch (err) {
        steps.push({
          step: "associations/relation.write — create (Suggested, inert)",
          ok: false,
          detail: msg(err),
        });
      }
    } else {
      steps.push({
        step: "associations/relation.write — create (Suggested, inert)",
        ok: false,
        detail: "skipped — need an opportunity, the Suggested association, and at least one mapped unit",
      });
    }

    // ---- 4. does a relation carry a timestamp? (blocks the "date label added" feature)
    let relationSample: unknown = null;
    if (opportunityId) {
      try {
        const res = await client.request<{ relations?: unknown[] }>(
          "GET",
          `/associations/relations/${opportunityId}`,
          { query: { locationId, skip: 0, limit: 10 } },
        );
        relationSample = res.data?.relations ?? null;
        const asText = JSON.stringify(relationSample ?? {});
        steps.push({
          step: "relation shape — does it carry a date?",
          ok: true,
          detail: /createdAt|dateAdded|created_at/i.test(asText)
            ? "YES — a timestamp is present. Real association dates are possible, including history."
            : "NO timestamp field found. Association dates could only be tracked from the day we start watching.",
        });
      } catch (err) {
        steps.push({ step: "relation shape — does it carry a date?", ok: false, detail: msg(err) });
      }
    }

    // ---- cleanup, in reverse
    if (relationId) {
      try {
        await client.request("DELETE", `/associations/relations/${relationId}`, { query: { locationId } });
        steps.push({ step: "cleanup — relation", ok: true, detail: "deleted" });
      } catch (err) {
        steps.push({ step: "cleanup — relation", ok: false, detail: `${msg(err)} (harmless: Suggested is ignored by the engine)` });
      }
    }
    if (opportunityId) {
      try {
        await client.request("DELETE", `/opportunities/${opportunityId}`);
        steps.push({ step: "cleanup — opportunity", ok: true, detail: "deleted" });
      } catch (err) {
        steps.push({ step: "cleanup — opportunity", ok: false, detail: `${msg(err)} — DELETE MANUALLY: ${opportunityId}` });
      }
    }
    if (contactId) {
      try {
        await client.request("DELETE", `/contacts/${contactId}`);
        steps.push({ step: "cleanup — contact", ok: true, detail: "deleted" });
      } catch (err) {
        steps.push({ step: "cleanup — contact", ok: false, detail: `${msg(err)} — DELETE MANUALLY: ${contactId}` });
      }
    }

    await supabaseAdmin
      .from("audit_events")
      .insert({ kind: "crm_scope_probe", reason: `probe ${stamp}: ${steps.filter((s) => s.ok).length}/${steps.length} ok` })
      .then(() => undefined, () => undefined);

    return { steps, relationSample };
  });
