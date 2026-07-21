import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * INVENTORY VIEW - read-only browser over the CRM custom objects.
 *
 * getInventoryTree: everything the page needs in one fast local read -
 * projects/buildings/units from external_id_map, live state from unit_state,
 * and per-unit interest (suggested + locked people) from unit_interest.
 *
 * syncUnitInterestChunk: rebuilds unit_interest from GHL association
 * relations, walking every opportunity in chunks (each deal's relations tell
 * us which units it has Suggested or Locked). Chunked so no single server
 * call runs long; the client loops until remaining === 0.
 */

function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export const getInventoryTree = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const [mapRes, stateRes, interestRes, cfgRes] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("scope, crm_record_id, display_name, parent_crm_id"),
      supabaseAdmin.from("unit_state").select("unit_crm_id, availability, stage, held_by_opportunity_id"),
      supabaseAdmin
        .from("unit_interest")
        .select("unit_crm_id, opportunity_id, kind, contact_id, contact_name, opportunity_name, stage_name, synced_at"),
      supabaseAdmin.from("crm_config").select("location_id").limit(1).maybeSingle(),
    ]);

    const rows = mapRes.data ?? [];
    const states = new Map((stateRes.data ?? []).map((s) => [s.unit_crm_id, s]));

    const projects = rows
      .filter((r) => r.scope === "project")
      .map((r) => ({ id: r.crm_record_id, name: r.display_name ?? "(unnamed project)" }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const buildings = rows
      .filter((r) => r.scope === "building")
      .map((r) => ({ id: r.crm_record_id, name: r.display_name ?? "(unnamed building)", projectId: r.parent_crm_id }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const units = rows
      .filter((r) => r.scope === "unit")
      .map((r) => {
        const st = states.get(r.crm_record_id);
        return {
          id: r.crm_record_id,
          name: r.display_name ?? "(unnamed unit)",
          buildingId: r.parent_crm_id,
          availability: st?.availability ?? "",
          stage: st?.stage ?? "",
          heldBy: st?.held_by_opportunity_id ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const interest = (interestRes.data ?? []).map((i) => ({
      unitId: i.unit_crm_id,
      oppId: i.opportunity_id,
      kind: i.kind as "suggested" | "locked",
      contactId: i.contact_id,
      contactName: i.contact_name,
      oppName: i.opportunity_name,
      stageName: i.stage_name,
    }));

    const lastSyncedAt = (interestRes.data ?? []).reduce<string | null>(
      (acc, i) => (acc && acc > i.synced_at ? acc : i.synced_at),
      null,
    );

    return {
      locationId: String(cfgRes.data?.location_id ?? ""),
      projects,
      buildings,
      units,
      interest,
      lastSyncedAt,
    };
  });

const CHUNK = 40;

export const syncUnitInterestChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ offset: z.number().int().min(0).default(0) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();
    const locationId = String(client.config.location_id ?? "");

    // Association definitions: which relation is a Lock, which is a Suggestion.
    const defsRes = await client.request<{ associations?: Array<Record<string, unknown>> }>("GET", "/associations/", {
      query: { locationId, skip: 0, limit: 100 },
    });
    const defs = defsRes.data?.associations ?? [];
    const lockedId = String(defs.find((d) => norm(d.key) === norm("lockedreserved_units"))?.id ?? "");
    const suggestedId = String(defs.find((d) => norm(d.key).includes("suggested"))?.id ?? "");
    if (!lockedId && !suggestedId) {
      return { processed: 0, added: 0, nextOffset: 0, remaining: 0, total: 0, note: "no lock/suggest associations defined" };
    }

    // Stage names for pretty labels.
    const stageNames = new Map<string, string>();
    try {
      const pRes = await client.request<{ pipelines?: Array<Record<string, unknown>> }>("GET", "/opportunities/pipelines", {
        query: { locationId },
      });
      for (const p of pRes.data?.pipelines ?? []) {
        for (const s of (Array.isArray(p.stages) ? p.stages : []) as Array<Record<string, unknown>>) {
          if (typeof s.id === "string") stageNames.set(s.id, String(s.name ?? ""));
        }
      }
    } catch {
      /* labels only */
    }

    // Known unit ids, so a relation's "other record" can be recognized as a unit.
    const { data: unitRows } = await supabaseAdmin
      .from("external_id_map")
      .select("crm_record_id")
      .eq("scope", "unit");
    const unitIds = new Set((unitRows ?? []).map((u) => u.crm_record_id));

    // Contact display names fallback.
    const { data: contactRows } = await supabaseAdmin.from("contact_id_map").select("crm_contact_id, display_name");
    const contactNames = new Map((contactRows ?? []).map((c) => [c.crm_contact_id, c.display_name ?? ""]));

    // The slice of opportunities this chunk covers.
    const pageSize = 100;
    const firstPage = Math.floor(data.offset / pageSize) + 1;
    const lastPage = Math.floor((data.offset + CHUNK - 1) / pageSize) + 1;
    const opps: Array<Record<string, unknown>> = [];
    let total = 0;
    for (let page = firstPage; page <= lastPage; page++) {
      const sr = await client.request<{ opportunities?: Array<Record<string, unknown>>; meta?: { total?: number }; total?: number }>(
        "GET",
        "/opportunities/search",
        { query: { location_id: locationId, limit: pageSize, page } },
      );
      total = sr.data?.meta?.total ?? sr.data?.total ?? total;
      const batch = Array.isArray(sr.data?.opportunities) ? sr.data.opportunities : [];
      const pageStart = (page - 1) * pageSize;
      for (const [i, o] of batch.entries()) {
        const abs = pageStart + i;
        if (abs >= data.offset && abs < data.offset + CHUNK) opps.push(o);
      }
      if (batch.length < pageSize) {
        total = total || pageStart + batch.length;
        break;
      }
    }

    // Fresh rebuild starts by clearing the mirror.
    if (data.offset === 0) {
      await supabaseAdmin.from("unit_interest").delete().neq("unit_crm_id", "");
    }

    type Row = {
      unit_crm_id: string;
      opportunity_id: string;
      kind: string;
      contact_id: string | null;
      contact_name: string | null;
      opportunity_name: string | null;
      stage_name: string | null;
    };
    const out: Row[] = [];

    const fetchRelations = async (opp: Record<string, unknown>) => {
      const oppId = typeof opp.id === "string" ? opp.id : "";
      if (!oppId) return;
      const contactId =
        (typeof opp.contactId === "string" && opp.contactId) ||
        (typeof opp.contact_id === "string" && opp.contact_id) ||
        (opp.contact && typeof opp.contact === "object" ? String((opp.contact as Record<string, unknown>).id ?? "") : "");
      const embeddedName =
        opp.contact && typeof opp.contact === "object"
          ? String((opp.contact as Record<string, unknown>).name ?? "").trim()
          : "";
      const contactName = embeddedName || contactNames.get(contactId) || null;
      const stageId = String(opp.pipelineStageId ?? opp.pipeline_stage_id ?? opp.stageId ?? "");
      const stageName = stageNames.get(stageId) ?? null;
      const oppName = String(opp.name ?? "").trim() || null;

      try {
        const rRes = await client.request<{ relations?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>>(
          "GET",
          `/associations/relations/${oppId}`,
          { query: { locationId, skip: 0, limit: 100 } },
        );
        const body = rRes.data as Record<string, unknown> | Array<Record<string, unknown>>;
        const relations = Array.isArray(body)
          ? body
          : ((body?.relations ?? (body as Record<string, unknown>)?.data ?? []) as Array<Record<string, unknown>>);
        for (const rel of Array.isArray(relations) ? relations : []) {
          const assocId = String(rel.associationId ?? rel.association_id ?? "");
          const kind = assocId === lockedId ? "locked" : assocId === suggestedId ? "suggested" : null;
          if (!kind) continue;
          const a = String(rel.firstRecordId ?? rel.first_record_id ?? "");
          const b = String(rel.secondRecordId ?? rel.second_record_id ?? "");
          const unitId = unitIds.has(a) ? a : unitIds.has(b) ? b : "";
          if (!unitId) continue;
          out.push({
            unit_crm_id: unitId,
            opportunity_id: oppId,
            kind,
            contact_id: contactId || null,
            contact_name: contactName,
            opportunity_name: oppName,
            stage_name: stageName,
          });
        }
      } catch {
        /* one deal failing shouldn't sink the sync */
      }
    };

    // Modest concurrency to stay friendly with rate limits.
    for (let i = 0; i < opps.length; i += 5) {
      await Promise.all(opps.slice(i, i + 5).map(fetchRelations));
    }

    if (out.length > 0) {
      await supabaseAdmin.from("unit_interest").upsert(out as never[], { onConflict: "unit_crm_id,opportunity_id,kind" });
    }

    const nextOffset = data.offset + opps.length;
    const remaining = Math.max(0, (total || nextOffset) - nextOffset);
    return { processed: opps.length, added: out.length, nextOffset, remaining, total: total || nextOffset };
  });
