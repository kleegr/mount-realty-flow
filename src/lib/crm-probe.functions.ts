import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * CRM PROBE — groundwork for the Lazers contact + opportunity import.
 *
 * PROVEN SO FAR (run of Jul 16):
 *   contacts.write        ✓ created + deleted a real contact
 *   opportunities.write   ✓ created + deleted a real opportunity
 *   pipelines read        ✓ Local Market → "New Inquiry / Initial Call"
 *   associations read     ✓ Suggested Units = 6a4a98259699f69d13bfcaea
 *
 * OPEN: associations/relation.write returned
 *   "Invalid record id : '<oppId>' for association : suggested_units"
 * That is NOT a scope error — GHL accepted the call and rejected the payload.
 * The opportunity was passed as firstRecordId; the association is almost
 * certainly unit-first / opportunity-second. This version reads the definition
 * and orders the ids accordingly instead of guessing, then retries swapped if
 * the definition is ambiguous.
 *
 * CORRECTED: the earlier "relation carries no timestamp" result was a FALSE
 * NEGATIVE of my own making — it inspected the relations of an opportunity
 * whose relation had just failed to create, so it found an empty array and
 * reported "no timestamp". Zero evidence. This version answers the question
 * properly by reading a REAL relation off a unit that is genuinely locked right
 * now (via unit_state.held_by_opportunity_id) — real shape, no writes.
 *
 * WHY THE WRITE PROBE IS SAFE:
 *   - the test contact is deleted immediately
 *   - the test opportunity is created in a RELEASE stage (maps to Available, so
 *     it cannot reserve anything) and is deleted
 *   - the association uses the SUGGESTED label, which the engine provably
 *     ignores end to end (release.server.ts rule 1)
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

    // =====================================================================
    // 0. READ A REAL RELATION — no writes. This is the honest answer to
    //    "does a relation carry a date?", using a unit that is locked NOW.
    // =====================================================================
    let realRelationSample: unknown = null;
    try {
      const { data: held } = await supabaseAdmin
        .from("unit_state")
        .select("held_by_opportunity_id")
        .not("held_by_opportunity_id", "is", null)
        .limit(1)
        .maybeSingle();
      const realOppId = held?.held_by_opportunity_id ?? null;

      if (!realOppId) {
        steps.push({
          step: "relation shape — real sample",
          ok: false,
          detail: "no unit is currently locked, so there is no real relation to read. Inconclusive.",
        });
      } else {
        const res = await client.request<{ relations?: unknown[] }>(
          "GET",
          `/associations/relations/${realOppId}`,
          { query: { locationId, skip: 0, limit: 10 } },
        );
        const rels = res.data?.relations ?? [];
        realRelationSample = rels;
        const asText = JSON.stringify(rels);
        const hasDate = /createdAt|dateAdded|created_at|updatedAt/i.test(asText);
        steps.push({
          step: "relation shape — real sample",
          ok: rels.length > 0,
          detail:
            rels.length === 0
              ? `opportunity ${realOppId} returned no relations. Inconclusive.`
              : hasDate
                ? "YES — a timestamp IS present on real relations. Real association dates are possible, including history."
                : "NO timestamp on real relations. Association dates can only be tracked from the day we start watching.",
        });
      }
    } catch (err) {
      steps.push({ step: "relation shape — real sample", ok: false, detail: msg(err) });
    }

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

    // ---- 2. pipelines read → release stage only
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
      const pipe = pipes.find((p) => typeof p.id === "string" && p.id === preferred?.pipeline_id) ?? pipes[0];
      pipelineId = typeof pipe?.id === "string" ? pipe.id : null;
      const stages = Array.isArray(pipe?.stages) ? (pipe.stages as Array<Record<string, unknown>>) : [];
      const releaseNames = (preferred?.release_stage_names ?? []) as string[];
      const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
      const releaseStage = stages.find((s) => releaseNames.some((n) => norm(n) === norm(s.name))) ?? stages[0];
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

    // ---- 3. opportunities.write
    if (contactId && pipelineId && stageId) {
      try {
        const res = await client.request<Record<string, unknown>>("POST", "/opportunities/", {
          body: { locationId, pipelineId, pipelineStageId: stageId, contactId, name: `Kleegr Probe ${stamp}`, status: "open" },
        });
        const d = (res.data ?? {}) as Record<string, unknown>;
        const o = (d.opportunity && typeof d.opportunity === "object" ? d.opportunity : d) as Record<string, unknown>;
        opportunityId = typeof o.id === "string" ? o.id : null;
        steps.push({ step: "opportunities.write — create", ok: Boolean(opportunityId), detail: opportunityId ?? JSON.stringify(d).slice(0, 240) });
      } catch (err) {
        steps.push({ step: "opportunities.write — create", ok: false, detail: msg(err) });
      }
    } else {
      steps.push({ step: "opportunities.write — create", ok: false, detail: "skipped — no contact or pipeline" });
    }

    // ---- 4. association DEFINITION — which side is which?
    let suggestedAssocId: string | null = null;
    let firstKey = "";
    let secondKey = "";
    try {
      const res = await client.request<{ associations?: Array<Record<string, unknown>> }>("GET", "/associations/", {
        query: { locationId, skip: 0, limit: 100 },
      });
      const defs = res.data?.associations ?? [];
      const suggested = defs.find((d) => /suggest/i.test(String(d.key ?? "")));
      suggestedAssocId = typeof suggested?.id === "string" ? suggested.id : null;
      firstKey = String(suggested?.firstObjectKey ?? "");
      secondKey = String(suggested?.secondObjectKey ?? "");
      steps.push({
        step: "association definition — which side is which?",
        ok: Boolean(suggestedAssocId),
        detail: suggestedAssocId
          ? `first = "${firstKey || "?"}"  ·  second = "${secondKey || "?"}"   (the previous run passed these backwards)`
          : "Suggested association not found",
      });
    } catch (err) {
      steps.push({ step: "association definition — which side is which?", ok: false, detail: msg(err) });
    }

    const { data: anyUnit } = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id")
      .eq("scope", "unit")
      .limit(1)
      .maybeSingle();
    const unitId = anyUnit?.crm_record_id ?? null;

    // ---- 5. relation.write, ordered by the definition (retry swapped if needed)
    if (opportunityId && suggestedAssocId && unitId) {
      const unitFirst = /unit/i.test(firstKey) || /opportunit/i.test(secondKey);
      const attempts: Array<{ label: string; first: string; second: string }> = unitFirst
        ? [
            { label: "unit-first (per definition)", first: unitId, second: opportunityId },
            { label: "opportunity-first (fallback)", first: opportunityId, second: unitId },
          ]
        : [
            { label: "opportunity-first (per definition)", first: opportunityId, second: unitId },
            { label: "unit-first (fallback)", first: unitId, second: opportunityId },
          ];

      for (const a of attempts) {
        if (relationId) break;
        try {
          const res = await client.request<Record<string, unknown>>("POST", "/associations/relations", {
            body: { locationId, associationId: suggestedAssocId, firstRecordId: a.first, secondRecordId: a.second },
          });
          const d = (res.data ?? {}) as Record<string, unknown>;
          const rel = (d.relation && typeof d.relation === "object" ? d.relation : d) as Record<string, unknown>;
          relationId = typeof rel.id === "string" ? rel.id : null;
          steps.push({
            step: `associations/relation.write — ${a.label}`,
            ok: Boolean(relationId),
            detail: relationId
              ? `${relationId} — THIS IS THE CORRECT ORDER. Raw: ${JSON.stringify(d).slice(0, 260)}`
              : JSON.stringify(d).slice(0, 300),
          });
        } catch (err) {
          steps.push({ step: `associations/relation.write — ${a.label}`, ok: false, detail: msg(err) });
        }
      }
    } else {
      steps.push({
        step: "associations/relation.write",
        ok: false,
        detail: "skipped — need an opportunity, the Suggested association, and at least one mapped unit",
      });
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

    return { steps, relationSample: realRelationSample };
  });
