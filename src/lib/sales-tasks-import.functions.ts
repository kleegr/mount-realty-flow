import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * SALES TASKS IMPORT (ClickUp export -> opportunities).
 *
 * The sheet is a ClickUp task export: one task per person, the buyer's name
 * in "Task Name" (often with unit codes or street addresses embedded, e.g.
 * "Avrum Lax CC-202" or "Yidel Rubinstein - 16 Houston unit 102"), phones in
 * three possible columns, emails in "Buyers Email", and ClickUp workflow
 * buckets in "Status".
 *
 * OWNER RULES:
 *  - status "groveview pending" WITH unit code(s) -> deal at Under Contract,
 *    ALL listed units locked under the one deal
 *  - statuses "rentel" and "listings" -> ignored
 *  - EVERYTHING else -> FIRST stage of the Local Market Pipeline
 *  - the four priority statuses also set the "Priority" dropdown on the deal
 *  - deal name = "{contact name} - {(xxx) xxx-xxxx}" like every other import
 *  - existing customers are UPDATED in place - never duplicated
 *  - ambiguous rows are NEVER imported blind; the page shows them with a
 *    per-row decision (same-as / new person / leave out) which the run
 *    receives as `resolutions`
 *  - everything of value on the task follows the person as one deduped note;
 *    the buyer's email lands on the contact record
 */

function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}
function clean(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}
function normPhone(v: unknown): string {
  let d = String(v ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);
  return d.length >= 7 ? d : "";
}
function prettyPhone(d: string): string {
  if (d.length === 10) return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  return d;
}
function cleanEmail(v: unknown): string {
  const s = clean(v);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : "";
}

const SKIP_STATUSES = new Set(["rentel", "listings"]);
const PRIORITY_LABELS: Record<string, string> = {
  "do first (non-negotiable)": "Do First (non-negotiable)",
  "high priority": "High Priority",
  "medium priority": "Medium Priority",
  "low priority": "Low Priority",
};

/** "A2-301-302-303 A1-304" -> [{b:'A2',u:'301'},{b:'A2',u:'302'},...,{b:'A1',u:'304'}] */
const CODE_RE = /\b([A-D]{1,2}\d?)[ ]?-?[ ]?(\d{3}(?:[ ]?-[ ]?\d{3})*)\b/gi;
function parseCodes(name: string): Array<{ b: string; u: string }> {
  const out: Array<{ b: string; u: string }> = [];
  for (const m of name.matchAll(CODE_RE)) {
    const b = m[1].toUpperCase();
    for (const u of m[2].split("-").map((x) => x.trim()).filter(Boolean)) {
      out.push({ b, u });
    }
  }
  return out;
}

/**
 * Street addresses embedded in task names ("57 Fort Worth 101",
 * "16 Houston unit 102") wreck contact matching and would create ugly
 * contact names. Strip the known street patterns and stray "unit NNN"
 * fragments before matching.
 */
const ADDR_RE = new RegExp(
  "\\b\\d{1,4}\\s+(?:fort\\s*worth|houston|dallas|duelk|lake\\s*shore|mangin|virginia|chesnut(?:\\s*drive)?|alamo|san\\s*marcos|hawthorne|roanoke|merri\\w*wold(?:\\s+(?:ln|lane)\\s*[ns]?)?|lone\\s*oak|kingsville|arlington|prospect|cook\\s*st\\w*|grove\\s*view)\\b(?:\\s*(?:unit\\s*)?\\d{1,4})?",
  "gi",
);
function stripNoise(name: string): string {
  return name
    .replace(CODE_RE, " ")
    .replace(ADDR_RE, " ")
    .replace(/\bunit\s*\d{1,4}\b/gi, " ")
    .replace(/(?:\s*[-,/]\s*){2,}/g, " ")
    .replace(/^[\s\-/,]+|[\s\-/,]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

interface ParsedTask {
  rowNo: number;
  displayName: string;
  status: string;
  mode: "locked" | "first" | "skip";
  skipWhy?: string;
  priorityLabel: string | null;
  phoneNorm: string;
  phoneRaw: string;
  email: string;
  note: string;
  noteProbe: string;
  codes: Array<{ b: string; u: string }>;
}

function parseTask(row: Record<string, unknown>, idx: number): ParsedTask | null {
  const name = clean(row["Task Name"]);
  if (!name) return null;
  const type = clean(row["Task Type"]);
  const status = clean(row["Status"]).toLowerCase();
  const phoneRaw =
    clean(row["Buyer's Number (phone)"]) || clean(row["Wife Buyer number (phone)"]) || clean(row["Wife Number (phone)"]);
  const email =
    cleanEmail(row["Buyers Email (email)"]) || cleanEmail(row["Buyers Email 2 (email)"]) || cleanEmail(row["buyers email (email)"]);
  const codes = parseCodes(name);
  const displayName = stripNoise(name) || name;

  let mode: ParsedTask["mode"];
  let skipWhy: string | undefined;
  if (type && type !== "Task") {
    mode = "skip";
    skipWhy = `task type "${type}"`;
  } else if (SKIP_STATUSES.has(status)) {
    mode = "skip";
    skipWhy = `status "${status}" is ignored`;
  } else if (status === "groveview pending" && codes.length > 0) {
    mode = "locked";
  } else {
    mode = "first";
  }

  // Compose ONE note carrying everything of value on the task.
  const comment = clean(row["Latest Comment"]).slice(0, 900);
  const lines: string[] = [];
  if (comment) lines.push(comment);
  const add = (label: string, v: unknown, max = 300) => {
    const s = clean(v).slice(0, max);
    if (s && s !== "[]") lines.push(`${label}: ${s}`);
  };
  add("Details", row["Task Content"], 500);
  add("Summary", row["Summary (text)"], 500);
  add("Progress", row["Progress Updates (text)"], 500);
  add("Assignee", String(row["Assignee"] ?? "").replace(/[\[\]]/g, ""));
  add("Follow up due", row["Due Date"]);
  add("Meeting", row["Meeting Date (date)"]);
  add("Contact method", row["Client Contact Method (drop down)"]);
  add("Legal name", row["Buyers Legal Name (short text)"]);
  add("Address", row["Buyers Address  (location)"]);
  add("Attorney", row["Buyers Attorney Name  (short text)"]);
  add("Attorney #", row["Buyers Attorney Number (phone)"]);
  add("Down payment", row["Down Payment  (currency)"]);
  const note = lines.length ? `Sales sheet [${status || "no status"}]:\n${lines.join("\n")}`.slice(0, 1800) : "";
  const noteProbe = (comment || lines[0] || "").slice(0, 60);

  return {
    rowNo: idx + 2,
    displayName,
    status,
    mode,
    skipWhy,
    priorityLabel: PRIORITY_LABELS[status] ?? null,
    phoneNorm: normPhone(phoneRaw),
    phoneRaw,
    email,
    note,
    noteProbe,
    codes: mode === "locked" ? codes : [],
  };
}

interface ContactRec {
  id: string;
  name: string;
  n: string;
  p: string;
}

async function loadContacts(): Promise<ContactRec[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("contact_id_map").select("crm_contact_id, display_name, phone");
  return (data ?? []).map((c) => ({
    id: String(c.crm_contact_id),
    name: String(c.display_name ?? ""),
    n: norm(c.display_name),
    p: normPhone(c.phone),
  }));
}

type Match =
  | { kind: "phone" | "name"; contact: ContactRec }
  | { kind: "ambiguous"; candidates: string[] }
  | { kind: "new" };

function matchContact(t: ParsedTask, contacts: ContactRec[], byPhone: Map<string, ContactRec>, byName: Map<string, ContactRec>): Match {
  if (t.phoneNorm) {
    const c = byPhone.get(t.phoneNorm);
    if (c) return { kind: "phone", contact: c };
  }
  const n = norm(t.displayName);
  if (n) {
    const c = byName.get(n);
    if (c) return { kind: "name", contact: c };
    if (n.length >= 5) {
      const cont = contacts.filter((c2) => c2.n.length >= 5 && (c2.n.includes(n) || n.includes(c2.n)));
      if (cont.length > 0) return { kind: "ambiguous", candidates: cont.slice(0, 4).map((c2) => c2.name) };
    }
  }
  return { kind: "new" };
}

/**
 * A per-row decision from the review UI:
 *   "new"          -> import as a brand-new person
 *   "same:<name>"  -> this is the existing contact with that display name
 *   anything else  -> leave the row out
 */
function applyResolution(
  m: Match,
  rowNo: number,
  resolutions: Record<string, string> | undefined,
  contacts: ContactRec[],
): Match | null {
  if (m.kind !== "ambiguous") return m;
  const dec = resolutions?.[String(rowNo)] ?? "";
  if (dec === "new") return { kind: "new" };
  if (dec.startsWith("same:")) {
    const want = dec.slice(5);
    const c = contacts.find((x) => x.name === want);
    if (c) return { kind: "name", contact: c };
  }
  return null; // leave out
}

const RowSchema = z.record(z.string(), z.unknown());

export const previewSalesTasks = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ rows: z.array(RowSchema).max(5000) }).parse(d))
  .handler(async ({ data }) => {
    const contacts = await loadContacts();
    const byPhone = new Map(contacts.filter((c) => c.p).map((c) => [c.p, c]));
    const byName = new Map(contacts.filter((c) => c.n).map((c) => [c.n, c]));

    const counts = {
      total: 0,
      locked: 0,
      lockedUnits: 0,
      firstStage: 0,
      skipped: 0,
      existing: 0,
      newContacts: 0,
      ambiguous: 0,
      missingPhone: 0,
      withPriority: 0,
      withComment: 0,
      withEmail: 0,
    };
    const ambiguousList: Array<{ row: number; name: string; candidates: string[] }> = [];
    const skippedList: Array<{ row: number; name: string; why: string }> = [];

    for (const [i, row] of data.rows.entries()) {
      const t = parseTask(row, i);
      if (!t) continue;
      counts.total++;
      if (t.mode === "skip") {
        counts.skipped++;
        if (skippedList.length < 30) skippedList.push({ row: t.rowNo, name: t.displayName, why: t.skipWhy ?? "" });
        continue;
      }
      const m = matchContact(t, contacts, byPhone, byName);
      if (m.kind === "ambiguous") {
        counts.ambiguous++;
        if (ambiguousList.length < 100) ambiguousList.push({ row: t.rowNo, name: t.displayName, candidates: m.candidates });
        continue;
      }
      if (m.kind === "new") counts.newContacts++;
      else counts.existing++;
      if (t.mode === "locked") {
        counts.locked++;
        counts.lockedUnits += t.codes.length;
      } else {
        counts.firstStage++;
      }
      if (!t.phoneNorm) counts.missingPhone++;
      if (t.priorityLabel) counts.withPriority++;
      if (t.note) counts.withComment++;
      if (t.email) counts.withEmail++;
    }

    return { counts, ambiguousList, skippedList };
  });

export const runSalesTasksChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        confirm: z.literal("IMPORT"),
        rows: z.array(RowSchema).max(5000),
        resolutions: z.record(z.string(), z.string()).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(10).default(8),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: rolesData } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", context.userId);
    const roles = (rolesData ?? []).map((r) => r.role);
    if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden: importer role required.");

    const { createCrmClient } = await import("./kleegr/client.server");
    const { applyOpportunityStageToUnit } = await import("./kleegr/release.server");
    const client = await createCrmClient();
    const locationId = String(client.config.location_id ?? "");

    // --- Pipeline: Local Market Pipeline, first stage + Under Contract stage.
    const pRes = await client.request<{ pipelines?: Array<Record<string, unknown>> }>("GET", "/opportunities/pipelines", {
      query: { locationId },
    });
    const pipe = (pRes.data?.pipelines ?? []).find((p) => /local\s*market/i.test(String(p.name ?? "")));
    if (!pipe?.id) throw new Error('Pipeline "Local Market Pipeline" not found in the CRM.');
    const pipelineId = String(pipe.id);
    const stages = (Array.isArray(pipe.stages) ? pipe.stages : []) as Array<Record<string, unknown>>;
    const firstStageId = String(stages[0]?.id ?? "");
    if (!firstStageId) throw new Error("Local Market Pipeline has no stages.");
    const { data: ruleRow } = await supabaseAdmin
      .from("crm_pipelines")
      .select("stage_under_contract_id")
      .eq("pipeline_id", pipelineId)
      .maybeSingle();
    const ucStageId =
      String(ruleRow?.stage_under_contract_id ?? "") ||
      String(stages.find((s) => /contract signed|unit locked|under contract/i.test(String(s.name ?? "")))?.id ?? "");
    if (!ucStageId) throw new Error("No Under Contract stage found for the Local Market Pipeline.");

    // --- Priority dropdown on the opportunity.
    let priorityField: { id: string; options: Map<string, string> } | null = null;
    try {
      const fRes = await client.request<{ customFields?: Array<Record<string, unknown>> }>(
        "GET",
        `/locations/${locationId}/customFields`,
        { query: { model: "opportunity" } },
      );
      const f = (fRes.data?.customFields ?? []).find((x) => norm(x.name) === "priority");
      if (f?.id) {
        const raw = (f.picklistOptions ?? f.picklistOptionValues ?? f.options) as unknown;
        const options = new Map<string, string>();
        if (Array.isArray(raw)) {
          for (const o of raw) {
            const v = typeof o === "string" ? o : o && typeof o === "object" ? String((o as Record<string, unknown>).value ?? (o as Record<string, unknown>).name ?? (o as Record<string, unknown>).label ?? "") : "";
            if (v) options.set(norm(v), v);
          }
        }
        priorityField = { id: String(f.id), options };
      }
    } catch {
      priorityField = null;
    }

    // --- Lock association.
    const defsRes = await client.request<{ associations?: Array<Record<string, unknown>> }>("GET", "/associations/", {
      query: { locationId, skip: 0, limit: 100 },
    });
    const lockDef = (defsRes.data?.associations ?? []).find((d) => norm(d.key) === norm("lockedreserved_units"));
    const unitIsFirst = lockDef ? norm(lockDef.firstObjectKey).includes("unit") : true;

    // --- Inventory maps (Groveview buildings + their units).
    const [{ data: bRows }, { data: uRows }] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("crm_record_id, display_name").eq("scope", "building").ilike("display_name", "Groveview%"),
      supabaseAdmin.from("external_id_map").select("crm_record_id, display_name, parent_crm_id").eq("scope", "unit"),
    ]);
    const buildings = (bRows ?? []).map((b) => ({ id: b.crm_record_id, name: String(b.display_name ?? ""), n: norm(b.display_name) }));
    const unitsByBuilding = new Map<string, Array<{ id: string; n: string }>>();
    for (const u of uRows ?? []) {
      if (!u.parent_crm_id) continue;
      const arr = unitsByBuilding.get(u.parent_crm_id) ?? [];
      arr.push({ id: u.crm_record_id, n: norm(u.display_name) });
      unitsByBuilding.set(u.parent_crm_id, arr);
    }
    const resolveUnit = (code: { b: string; u: string }): { unitId?: string; err?: string } => {
      const suffix = "building" + norm(code.b);
      const cand = buildings.filter((b) => b.n.endsWith(suffix));
      if (cand.length === 0) return { err: `no Groveview building ${code.b}` };
      const wantU = norm(code.u);
      const hits: string[] = [];
      for (const b of cand) {
        const us = (unitsByBuilding.get(b.id) ?? []).filter((u) => u.n.endsWith(wantU));
        if (us.length === 1) hits.push(us[0].id);
        else if (us.length > 1) return { err: `unit ${code.b}-${code.u} matches several units` };
      }
      if (hits.length === 1) return { unitId: hits[0] };
      if (hits.length === 0) return { err: `no unit ${code.u} in building ${code.b}` };
      return { err: `unit ${code.b}-${code.u} exists in more than one ${code.b} building` };
    };

    // --- Contacts.
    const contacts = await loadContacts();
    const byPhone = new Map(contacts.filter((c) => c.p).map((c) => [c.p, c]));
    const byName = new Map(contacts.filter((c) => c.n).map((c) => [c.n, c]));

    // --- Build the processing queue. Ambiguous rows enter ONLY with an
    //     explicit decision from the review UI; skip rows never do.
    const queue: Array<{ t: ParsedTask; match: Match }> = [];
    for (const [i, row] of data.rows.entries()) {
      const t = parseTask(row, i);
      if (!t || t.mode === "skip") continue;
      const m0 = matchContact(t, contacts, byPhone, byName);
      const m = applyResolution(m0, t.rowNo, data.resolutions, contacts);
      if (!m) continue;
      queue.push({ t, match: m });
    }

    const slice = queue.slice(data.offset, data.offset + data.limit);
    const results: Array<{ row: number; name: string; ok: boolean; action: string; detail: string }> = [];

    for (const { t, match } of slice) {
      try {
        // ---- Contact: reuse or create (email included where known).
        let contactId: string;
        let contactName: string;
        let contactPhone: string;
        const tags: string[] = [];
        if (match.kind === "new") {
          const body: Record<string, unknown> = { locationId, name: t.displayName };
          if (t.phoneRaw) body.phone = t.phoneRaw;
          if (t.email) body.email = t.email;
          const cRes = await client.request<Record<string, unknown>>("POST", "/contacts/upsert", { body });
          const cd = (cRes.data ?? {}) as Record<string, unknown>;
          const c = (cd.contact && typeof cd.contact === "object" ? cd.contact : cd) as Record<string, unknown>;
          contactId = String(c.id ?? "");
          if (!contactId) throw new Error("CRM did not return a contact id");
          contactName = t.displayName;
          contactPhone = t.phoneNorm;
          await supabaseAdmin
            .from("contact_id_map")
            .upsert(
              { stable_id: `name:${norm(t.displayName)}`, crm_contact_id: contactId, display_name: t.displayName, phone: t.phoneRaw || null } as never,
              { onConflict: "stable_id" },
            )
            .then(() => undefined, () => undefined);
        } else {
          contactId = match.contact.id;
          contactName = match.contact.name || t.displayName;
          contactPhone = match.contact.p || t.phoneNorm;
          // Fill a missing email on the existing contact - never overwrite one.
          if (t.email) {
            try {
              const gRes = await client.request<Record<string, unknown>>("GET", `/contacts/${contactId}`, {});
              const gd = (gRes.data ?? {}) as Record<string, unknown>;
              const gc = (gd.contact && typeof gd.contact === "object" ? gd.contact : gd) as Record<string, unknown>;
              if (!String(gc.email ?? "").trim()) {
                await client.request("PUT", `/contacts/${contactId}`, { body: { email: t.email } });
                tags.push("email filled");
              }
            } catch {
              /* best effort */
            }
          }
        }

        const pretty = prettyPhone(contactPhone);
        const dealName = pretty ? `${contactName} - ${pretty}` : contactName;

        // ---- Priority custom field payload.
        const customFields: Array<{ id: string; value: string }> = [];
        if (t.priorityLabel) {
          if (priorityField) {
            const resolved = priorityField.options.get(norm(t.priorityLabel)) ?? t.priorityLabel;
            customFields.push({ id: priorityField.id, value: resolved });
          } else {
            tags.push("no Priority field in CRM");
          }
        }

        // ---- Deal: reuse (update) or create.
        let oppId: string | null = null;
        try {
          const sr = await client.request<{ opportunities?: Array<Record<string, unknown>> }>("GET", "/opportunities/search", {
            query: { location_id: locationId, contact_id: contactId, limit: 20 },
          });
          const opps = Array.isArray(sr.data?.opportunities) ? sr.data.opportunities : [];
          const mine = opps.find((o) => String(o.pipelineId ?? o.pipeline_id ?? "") === pipelineId);
          oppId = mine && typeof mine.id === "string" ? mine.id : null;
        } catch {
          oppId = null;
        }

        let action: string;
        if (oppId) {
          const body: Record<string, unknown> = { name: dealName };
          if (customFields.length) body.customFields = customFields;
          if (t.mode === "locked") body.pipelineStageId = ucStageId;
          await client.request("PUT", `/opportunities/${oppId}`, { body });
          action = "Updated";
        } else {
          const body: Record<string, unknown> = {
            pipelineId,
            locationId,
            name: dealName,
            pipelineStageId: t.mode === "locked" ? ucStageId : firstStageId,
            status: "open",
            contactId,
          };
          if (customFields.length) body.customFields = customFields;
          const res = await client.request<Record<string, unknown>>("POST", "/opportunities/", { body });
          const d = (res.data ?? {}) as Record<string, unknown>;
          const o = (d.opportunity && typeof d.opportunity === "object" ? d.opportunity : d) as Record<string, unknown>;
          oppId = typeof o.id === "string" ? o.id : null;
          if (!oppId) throw new Error("CRM did not return an opportunity id");
          action = "Created";
        }

        // ---- Lock every listed unit under this one deal.
        if (t.mode === "locked") {
          for (const code of t.codes) {
            const r = resolveUnit(code);
            if (!r.unitId) {
              tags.push(`SKIPPED ${code.b}-${code.u}: ${r.err}`);
              continue;
            }
            const { data: st } = await supabaseAdmin
              .from("unit_state")
              .select("held_by_opportunity_id")
              .eq("unit_crm_id", r.unitId)
              .maybeSingle();
            const holder = st?.held_by_opportunity_id as string | undefined;
            if (holder && holder !== oppId) {
              let holderContact = "";
              try {
                const hRes = await client.request<Record<string, unknown>>("GET", `/opportunities/${holder}`, {});
                const hd = (hRes.data ?? {}) as Record<string, unknown>;
                const ho = (hd.opportunity && typeof hd.opportunity === "object" ? hd.opportunity : hd) as Record<string, unknown>;
                holderContact = String(ho.contactId ?? ho.contact_id ?? "");
              } catch {
                holderContact = ""; // dead holder -> take over
              }
              if (holderContact && holderContact !== contactId) {
                tags.push(`CONFLICT ${code.b}-${code.u}: held by a different buyer - untouched`);
                continue;
              }
              if (!holderContact) {
                await supabaseAdmin.from("unit_state").update({ held_by_opportunity_id: null }).eq("unit_crm_id", r.unitId);
              }
            }
            if (lockDef?.id) {
              await client
                .request("POST", "/associations/relations", {
                  body: {
                    locationId,
                    associationId: lockDef.id,
                    firstRecordId: unitIsFirst ? r.unitId : oppId,
                    secondRecordId: unitIsFirst ? oppId : r.unitId,
                  },
                })
                .then(() => undefined, () => undefined); // duplicate relation is fine
            }
            const applied = await applyOpportunityStageToUnit(client, oppId, r.unitId);
            tags.push(`${code.b}-${code.u} ${applied.outcome}`);
          }
        }

        // ---- One note carrying the task's comment + assignee + dates + extras.
        if (t.note) {
          try {
            const nRes = await client.request<{ notes?: Array<Record<string, unknown>> }>("GET", `/contacts/${contactId}/notes`, {});
            const existing = Array.isArray(nRes.data?.notes) ? nRes.data.notes : [];
            const already = t.noteProbe && existing.some((n) => String(n.body ?? "").includes(t.noteProbe));
            if (!already) {
              await client.request("POST", `/contacts/${contactId}/notes`, { body: { body: t.note } });
              tags.push("note added");
            }
          } catch {
            tags.push("note failed");
          }
        }

        if (!t.phoneNorm) tags.push("Missing Phone");
        results.push({ row: t.rowNo, name: t.displayName, ok: true, action, detail: tags.join(" - ") || "ok" });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const msg = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        results.push({ row: t.rowNo, name: t.displayName, ok: false, action: "Failed", detail: msg.slice(0, 220) });
      }
    }

    const nextOffset = data.offset + slice.length;
    return {
      processed: slice.length,
      created: results.filter((r) => r.action === "Created").length,
      updated: results.filter((r) => r.action === "Updated").length,
      failed: results.filter((r) => !r.ok).length,
      results,
      total: queue.length,
      nextOffset,
      remaining: Math.max(0, queue.length - nextOffset),
    };
  });
