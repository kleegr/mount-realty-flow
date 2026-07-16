import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * CONTACT IMPORT — Lazers Realty. Contacts only; opportunities untouched.
 *
 * 1. SCHEMA-DRIVEN, NOT HARDCODED. Field keys and picklist values are read live
 *    from GHL at run time and matched case/punctuation-insensitively, so a sheet
 *    saying "buyer" resolves to whatever the option literally is ("Buyer") and we
 *    send that exact string back. The property_type bug class, designed out.
 *
 * 2. THE ID MAP IS THE RESUME STATE. A stable_id in contact_id_map means that
 *    person is done. No cursor. ~150 sequential CRM calls will outlive a
 *    serverless invocation, so the job must be re-runnable by construction.
 *
 * 3. THE FIRST WRITE IS VERIFIED, THEN THE RUN COMMITS. GHL 200s an unknown
 *    custom-field payload and silently drops it. Without a read-back the happy
 *    path is "149 contacts imported", every one missing the father names,
 *    discovered a week later. Verification failure aborts after ONE row.
 *
 * 4. CONTACT DETAILS ARE SANITISED, NOT TRUSTED. The first run put 143/149
 *    through and lost six to bad inputs: three rows had non-address text in the
 *    email column ("email must be an email"), three had two phone numbers in one
 *    cell ("the string supplied is too long to be a phone number"). A spreadsheet
 *    column is a suggestion, not a typed field — so both are now parsed, and a
 *    value that can't be salvaged is dropped WITH a recorded warning rather than
 *    failing the whole person. A bad phone should never cost you a contact.
 */

const CHUNK_MAX = 25;

// ---------------------------------------------------------------- helpers

/** Loose key for matching: case, spaces and punctuation all ignored. */
function norm(s: unknown): string {
  return String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function normEmail(s: unknown): string {
  return String(s ?? "").trim().toLowerCase();
}

/** Last 10 digits — tolerates +1, dashes, parens, spaces. For MATCHING only. */
function normPhone(s: unknown): string {
  const d = String(s ?? "").replace(/\D+/g, "");
  return d.length > 10 ? d.slice(-10) : d;
}

function cleanName(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

/** Excel junk that must never reach the CRM as a value. */
function isJunk(v: unknown): boolean {
  const s = String(v ?? "").trim();
  if (!s) return true;
  return /^(#value!|#ref!|#n\/a|#div\/0!|#name\?|null|undefined|n\/a|-)$/i.test(s);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/**
 * The email column holds whatever someone typed: a real address, two addresses,
 * a note, a phone number. Take the first thing that is actually an address;
 * otherwise drop it and say so. Never hand GHL something it will 422 on.
 */
function pickEmail(raw: unknown): { value: string | null; warning?: string } {
  const s = String(raw ?? "").trim();
  if (!s || isJunk(s)) return { value: null };
  const parts = s.split(/[;,\s/|]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  const valid = parts.filter((p) => EMAIL_RE.test(p));
  if (valid.length === 0) return { value: null, warning: `email "${s}" is not a valid address — left blank` };
  if (valid.length > 1) return { value: valid[0], warning: `email: kept "${valid[0]}" of ${valid.length} in "${s}"` };
  return { value: valid[0] };
}

/**
 * Same problem, worse: "845-555-1234 / 845-555-9999" is 20 digits and GHL
 * rejects the lot. Split on the separators people actually use, take the first
 * usable number, and emit E.164 so there's no ambiguity about country code.
 */
function pickPhone(raw: unknown): { value: string | null; warning?: string } {
  const s = String(raw ?? "").trim();
  if (!s || isJunk(s)) return { value: null };

  const parts = s.split(/[\/;,|\n]|\bor\b|\band\b/i).map((x) => x.trim()).filter(Boolean);
  const candidates: string[] = [];
  for (const part of parts.length ? parts : [s]) {
    const d = part.replace(/\D+/g, "");
    if (d.length >= 10 && d.length <= 15) candidates.push(d);
  }

  if (candidates.length === 0) {
    // One unbroken run of digits containing several numbers, e.g. "84555512348455559999".
    const all = s.replace(/\D+/g, "");
    if (all.length >= 10 && all.length <= 15) candidates.push(all);
    else if (all.length > 15) {
      return { value: `+1${all.slice(0, 10)}`, warning: `phone "${s}" ran together — kept the first 10 digits` };
    }
  }

  if (candidates.length === 0) return { value: null, warning: `phone "${s}" has no usable number — left blank` };

  let d = candidates[0];
  if (d.length === 11 && d.startsWith("1")) d = d.slice(1);

  const extra = candidates.length > 1 ? `phone: kept the first of ${candidates.length} numbers in "${s}"` : undefined;
  if (d.length === 10) return { value: `+1${d}`, warning: extra };
  if (d.length > 10 && d.length <= 15) return { value: `+${d}`, warning: extra };
  return { value: null, warning: `phone "${s}" is not a usable number — left blank` };
}

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = cleanName(full).split(" ").filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts.slice(0, -1).join(" "), lastName: parts[parts.length - 1] };
}

async function roles(userId: string): Promise<string[]> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  return (data ?? []).map((r) => r.role);
}

async function requireImporter(userId: string) {
  const r = await roles(userId);
  if (!r.includes("admin") && !r.includes("importer")) throw new Error("Forbidden: importer role required.");
  return r;
}

// ---------------------------------------------------------------- schema

interface ContactField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
  options: string[];
}

async function loadContactFields(client: {
  config: { location_id: string | null };
  request: <T>(m: "GET", p: string, o?: { query?: Record<string, string> }) => Promise<{ data: T }>;
}): Promise<ContactField[]> {
  const locationId = client.config.location_id;
  if (!locationId) throw new Error("crm_config.location_id is not set.");
  const res = await client.request<{ customFields?: Array<Record<string, unknown>> }>(
    "GET",
    `/locations/${locationId}/customFields`,
    { query: { model: "contact" } },
  );
  const all = Array.isArray(res.data?.customFields) ? res.data.customFields : [];
  return all
    .filter((f) => {
      const model = String(f.model ?? "");
      const key = String(f.fieldKey ?? "");
      return /contact/i.test(model) || /^contact\./.test(key);
    })
    .map((f) => {
      const rawOpts = (f.picklistOptions ?? f.picklistOptionValues ?? f.options) as unknown;
      const options = Array.isArray(rawOpts)
        ? rawOpts
            .map((o) => {
              if (typeof o === "string") return o;
              if (o && typeof o === "object") {
                const r = o as Record<string, unknown>;
                const v = r.value ?? r.name ?? r.label ?? r.key;
                return typeof v === "string" ? v : null;
              }
              return null;
            })
            .filter((v): v is string => Boolean(v))
        : [];
      return {
        id: String(f.id ?? ""),
        name: String(f.name ?? ""),
        fieldKey: String(f.fieldKey ?? ""),
        dataType: String(f.dataType ?? ""),
        options,
      };
    });
}

/** Resolve a sheet value against a picklist's REAL options, exactly as spelled. */
function resolveOption(field: ContactField, value: unknown): string | null {
  const n = norm(value);
  if (!n) return null;
  return field.options.find((o) => norm(o) === n) ?? null;
}

const BUILTINS = [
  { key: "name", aliases: ["clientname", "name", "fullname", "buyer", "buyername", "client"] },
  { key: "email", aliases: ["email", "emailaddress", "mail"] },
  { key: "phone", aliases: ["phone", "phonenumber", "cell", "mobile", "tel", "telephone"] },
  { key: "stable_id", aliases: ["id", "clientid", "personid", "contactid", "stableid", "cid"] },
] as const;

/**
 * Headers that describe a DEAL, not a person.
 *
 * The sheet is one row per unit, so these values DIFFER across the six rows
 * belonging to one buyer. Collapsing them onto a contact keeps the first and
 * silently discards the rest — the same "two writers, one field" fault that
 * produced Total 4 / Available 7 on the inventory import.
 *
 * Skipped EVEN WHEN a same-named contact field exists. GHL ships a contact
 * field called "Notes", which is exactly the trap.
 */
const DEAL_LEVEL = new Set([
  "notes",
  "datesigned",
  "executed",
  "downpayment",
  "paidamount",
  "remaningd",
  "remainingd",
  "remaining",
  "remainingpayment",
  "receipt",
  "receiptnumber",
  "paymenttype",
  "gavetoowner",
  "followup",
  "commtobillpaid",
  "commission",
  "paid",
  "saleprice",
  "duedate",
  "invoicesent",
  "invoicelink",
]);

export interface MappedColumn {
  header: string;
  target: string;
  targetLabel: string;
  kind: "builtin" | "custom" | "ignored";
  dataType?: string;
  options?: string[];
}

function buildMapping(headers: string[], fields: ContactField[]): MappedColumn[] {
  return headers.map((h) => {
    const n = norm(h);
    const b = BUILTINS.find((x) => x.aliases.includes(n));
    if (b) return { header: h, target: b.key, targetLabel: b.key, kind: "builtin" as const };

    // Checked BEFORE the custom-field lookup, on purpose: a matching contact
    // field is not evidence that the column is person-level.
    if (DEAL_LEVEL.has(n)) {
      return {
        header: h,
        target: "",
        targetLabel: "— deal-level · belongs on the opportunity —",
        kind: "ignored" as const,
      };
    }

    const f = fields.find((x) => norm(x.name) === n || norm(x.fieldKey.replace(/^contact\./, "")) === n);
    if (f) {
      return { header: h, target: f.id, targetLabel: f.name, kind: "custom" as const, dataType: f.dataType, options: f.options };
    }
    return { header: h, target: "", targetLabel: "— not imported —", kind: "ignored" as const };
  });
}

// ---------------------------------------------------------------- preview

const RowSchema = z.record(z.string(), z.unknown());

export const previewContactImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ rows: z.array(RowSchema).max(5000) }).parse(d))
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { createCrmClient } = await import("./kleegr/client.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const client = await createCrmClient();
    const fields = await loadContactFields(client as never);

    const headers = Object.keys(data.rows[0] ?? {});
    const mapping = buildMapping(headers, fields);

    const nameCol = mapping.find((m) => m.target === "name")?.header ?? null;
    const emailCol = mapping.find((m) => m.target === "email")?.header ?? null;
    const phoneCol = mapping.find((m) => m.target === "phone")?.header ?? null;
    const idCol = mapping.find((m) => m.target === "stable_id")?.header ?? null;

    const people = new Map<string, { name: string; email: string; phone: string; rows: number }>();
    let noName = 0;
    let badEmail = 0;
    let badPhone = 0;
    for (const row of data.rows) {
      const name = cleanName(nameCol ? row[nameCol] : "");
      if (!name || isJunk(name)) {
        noName++;
        continue;
      }
      const stable = idCol && !isJunk(row[idCol]) ? String(row[idCol]).trim() : `name:${norm(name)}`;
      const prev = people.get(stable);
      const e = emailCol ? pickEmail(row[emailCol]) : { value: null as string | null };
      const ph = phoneCol ? pickPhone(row[phoneCol]) : { value: null as string | null };
      if (emailCol && !isJunk(row[emailCol]) && !e.value) badEmail++;
      if (phoneCol && !isJunk(row[phoneCol]) && !ph.value) badPhone++;
      people.set(stable, {
        name: prev?.name || name,
        email: prev?.email || e.value || "",
        phone: prev?.phone || ph.value || "",
        rows: (prev?.rows ?? 0) + 1,
      });
    }

    const stableIds = [...people.keys()];
    const { data: done } = await supabaseAdmin
      .from("contact_id_map")
      .select("stable_id")
      .in("stable_id", stableIds.slice(0, 1000));
    const alreadyDone = new Set((done ?? []).map((d) => d.stable_id));

    return {
      ok: true as const,
      totalRows: data.rows.length,
      rowsWithoutName: noName,
      unusableEmails: badEmail,
      unusablePhones: badPhone,
      distinctPeople: people.size,
      alreadyImported: [...alreadyDone].length,
      toImport: stableIds.filter((s) => !alreadyDone.has(s)).length,
      noContactInfo: [...people.values()].filter((p) => !p.email && !p.phone).length,
      usingDerivedIds: !idCol,
      mapping,
      availableFields: fields.map((f) => ({ id: f.id, name: f.name, dataType: f.dataType, options: f.options })),
      sample: [...people.entries()].slice(0, 8).map(([id, p]) => ({ stableId: id, ...p })),
    };
  });

// ---------------------------------------------------------------- execute

const OverrideSchema = z.object({ header: z.string(), target: z.string() });

export const runContactImportChunk = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        jobId: z.string().uuid(),
        rows: z.array(RowSchema).max(5000),
        overrides: z.array(OverrideSchema).default([]),
        contactType: z.string().optional(),
        limit: z.number().int().min(1).max(CHUNK_MAX).default(CHUNK_MAX),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);
    const { createCrmClient } = await import("./kleegr/client.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const client = await createCrmClient();
    const locationId = client.config.location_id;
    const fields = await loadContactFields(client as never);

    const headers = Object.keys(data.rows[0] ?? {});
    const mapping = buildMapping(headers, fields);
    for (const o of data.overrides) {
      const m = mapping.find((x) => x.header === o.header);
      if (!m) continue;
      const f = fields.find((x) => x.id === o.target);
      const b = BUILTINS.find((x) => x.key === o.target);
      if (f) Object.assign(m, { target: f.id, targetLabel: f.name, kind: "custom", dataType: f.dataType, options: f.options });
      else if (b) Object.assign(m, { target: b.key, targetLabel: b.key, kind: "builtin" });
      else Object.assign(m, { target: "", targetLabel: "— not imported —", kind: "ignored" });
    }

    const col = (t: string) => mapping.find((m) => m.target === t)?.header ?? null;
    const nameCol = col("name");
    const emailCol = col("email");
    const phoneCol = col("phone");
    const idCol = col("stable_id");
    if (!nameCol) throw new Error("No column is mapped to the contact name. Nothing can be imported.");

    // Collapse rows -> people. First non-empty value wins; later rows only fill
    // gaps, so Friedman's six rows become one contact. This is exactly why
    // DEAL_LEVEL columns are excluded above — for those, "first wins" is silent
    // data loss rather than deduplication.
    interface Person {
      stableId: string;
      name: string;
      email: string;
      phone: string;
      custom: Record<string, unknown>;
      warnings: string[];
    }
    const people = new Map<string, Person>();
    for (const row of data.rows) {
      const name = cleanName(nameCol ? row[nameCol] : "");
      if (!name || isJunk(name)) continue;
      const stableId = idCol && !isJunk(row[idCol]) ? String(row[idCol]).trim() : `name:${norm(name)}`;
      const p: Person = people.get(stableId) ?? { stableId, name, email: "", phone: "", custom: {}, warnings: [] };

      if (!p.email && emailCol) {
        const e = pickEmail(row[emailCol]);
        if (e.value) p.email = e.value;
        if (e.warning && !p.warnings.includes(e.warning)) p.warnings.push(e.warning);
      }
      if (!p.phone && phoneCol) {
        const ph = pickPhone(row[phoneCol]);
        if (ph.value) p.phone = ph.value;
        if (ph.warning && !p.warnings.includes(ph.warning)) p.warnings.push(ph.warning);
      }

      for (const m of mapping) {
        if (m.kind !== "custom") continue;
        const v = row[m.header];
        if (isJunk(v)) continue;
        if (p.custom[m.target] === undefined) p.custom[m.target] = v;
      }
      people.set(stableId, p);
    }

    const allIds = [...people.keys()];
    const { data: done } = await supabaseAdmin.from("contact_id_map").select("stable_id").in("stable_id", allIds.slice(0, 1000));
    const doneSet = new Set((done ?? []).map((d) => d.stable_id));
    const queue = allIds.filter((id) => !doneSet.has(id)).slice(0, data.limit);

    const results: Array<{ stableId: string; name: string; ok: boolean; action: string; detail: string }> = [];
    let verified = false;

    for (const stableId of queue) {
      const p = people.get(stableId)!;
      try {
        let existingId: string | null = null;
        let matchedBy = "created";
        for (const [q, how] of [
          [p.email, "email"],
          [p.phone, "phone"],
          [p.name, "name"],
        ] as const) {
          if (existingId || !q) continue;
          try {
            const s = await client.request<{ contacts?: Array<Record<string, unknown>> }>("GET", "/contacts/", {
              query: { locationId: String(locationId), query: String(q), limit: 20 },
            });
            const hits = s.data?.contacts ?? [];
            const hit = hits.find((c) => {
              if (how === "email") return normEmail(c.email) === p.email;
              if (how === "phone") return normPhone(c.phone) === normPhone(p.phone);
              const full = cleanName(c.contactName ?? `${c.firstName ?? ""} ${c.lastName ?? ""}`);
              return norm(full) === norm(p.name);
            });
            if (hit && typeof hit.id === "string") {
              existingId = hit.id;
              matchedBy = how;
            }
          } catch {
            /* search failure is not fatal — fall through to create */
          }
        }

        const customFields: Array<{ id: string; value: unknown }> = [];
        const warnings: string[] = [...p.warnings];
        for (const [fieldId, raw] of Object.entries(p.custom)) {
          const f = fields.find((x) => x.id === fieldId);
          if (!f) continue;
          if (f.options.length > 0) {
            const exact = resolveOption(f, raw);
            if (!exact) {
              warnings.push(`${f.name}: "${String(raw)}" is not one of [${f.options.join(", ")}]`);
              continue;
            }
            customFields.push({ id: f.id, value: f.dataType === "MULTIPLE_OPTIONS" ? [exact] : exact });
          } else {
            customFields.push({ id: f.id, value: String(raw).trim() });
          }
        }

        // Contact Type only on NEW contacts — never silently flip an existing
        // Seller to Buyer just because they appear in this sheet.
        if (!existingId && data.contactType) {
          const ctField = fields.find(
            (f) => norm(f.fieldKey) === norm("contact.contact_type") || norm(f.name) === norm("Contact Type"),
          );
          if (ctField) {
            const exact = resolveOption(ctField, data.contactType);
            if (exact) customFields.push({ id: ctField.id, value: ctField.dataType === "MULTIPLE_OPTIONS" ? [exact] : exact });
            else warnings.push(`Contact Type: "${data.contactType}" is not one of [${ctField.options.join(", ")}]`);
          }
        }

        const { firstName, lastName } = splitName(p.name);
        const body: Record<string, unknown> = {
          locationId,
          firstName,
          lastName,
          name: p.name,
          source: "kleegr-lazers-import",
        };
        // Only ever sent when they survived parsing. An unusable value is a
        // warning on the record, never a failed contact.
        if (p.email) body.email = p.email;
        if (p.phone) body.phone = p.phone;
        if (customFields.length) body.customFields = customFields;
        if (!p.email && !p.phone) body.tags = ["needs-contact-info"];

        let contactId = existingId;
        if (existingId) {
          await client.request("PUT", `/contacts/${existingId}`, { body: { ...body, locationId: undefined } });
        } else {
          const res = await client.request<Record<string, unknown>>("POST", "/contacts/", { body });
          const d = (res.data ?? {}) as Record<string, unknown>;
          const c = (d.contact && typeof d.contact === "object" ? d.contact : d) as Record<string, unknown>;
          contactId = typeof c.id === "string" ? c.id : null;
        }
        if (!contactId) throw new Error("CRM did not return a contact id.");

        // VERIFY THE FIRST WRITE, then trust the rest.
        if (!verified && customFields.length > 0) {
          const back = await client.request<Record<string, unknown>>("GET", `/contacts/${contactId}`);
          const d = (back.data ?? {}) as Record<string, unknown>;
          const c = (d.contact && typeof d.contact === "object" ? d.contact : d) as Record<string, unknown>;
          const got = Array.isArray(c.customFields) ? (c.customFields as Array<Record<string, unknown>>) : [];
          const landed = customFields.filter((cf) => got.some((g) => g.id === cf.id));
          if (landed.length === 0) {
            throw new Error(
              `ABORTED AFTER ONE ROW. Sent ${customFields.length} custom fields; GHL returned 200 but stored none. ` +
                `The customFields payload shape is wrong — fix that before importing 149 people. ` +
                `Read back: ${JSON.stringify(got).slice(0, 300)}`,
            );
          }
          verified = true;
        }

        await supabaseAdmin.from("contact_id_map").upsert(
          {
            stable_id: stableId,
            crm_contact_id: contactId,
            display_name: p.name,
            email: p.email || null,
            phone: p.phone || null,
            matched_by: matchedBy,
            job_id: data.jobId,
            notes: warnings.length ? warnings.join(" | ") : null,
            updated_at: new Date().toISOString(),
          },
          { onConflict: "stable_id" },
        );

        results.push({
          stableId,
          name: p.name,
          ok: true,
          action: existingId ? `matched by ${matchedBy}` : "created",
          detail: warnings.length ? `${contactId} — ${warnings.join(" | ")}` : contactId,
        });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const clean = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
        results.push({ stableId, name: p.name, ok: false, action: "error", detail: clean });
        if (/ABORTED AFTER ONE ROW/.test(raw)) break;
      }
    }

    const { count } = await supabaseAdmin
      .from("contact_id_map")
      .select("stable_id", { count: "exact", head: true })
      .in("stable_id", allIds.slice(0, 1000));

    return {
      processed: results.length,
      imported: count ?? 0,
      totalPeople: allIds.length,
      remaining: Math.max(0, allIds.length - (count ?? 0)),
      results,
    };
  });

// ---------------------------------------------------------------- undo

export const undoContactImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ jobId: z.string().uuid(), confirm: z.literal("UNDO") }).parse(d))
  .handler(async ({ data, context }) => {
    const r = await roles(context.userId);
    if (!r.includes("admin")) throw new Error("Forbidden: admin only.");

    const { createCrmClient } = await import("./kleegr/client.server");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const client = await createCrmClient();

    // Only delete what THIS job created. Contacts we merely matched onto
    // already existed and are not ours to remove.
    const { data: rows } = await supabaseAdmin
      .from("contact_id_map")
      .select("stable_id, crm_contact_id, display_name")
      .eq("job_id", data.jobId)
      .eq("matched_by", "created");

    let deleted = 0;
    const failures: string[] = [];
    for (const row of rows ?? []) {
      try {
        await client.request("DELETE", `/contacts/${row.crm_contact_id}`);
        await supabaseAdmin.from("contact_id_map").delete().eq("stable_id", row.stable_id);
        deleted++;
      } catch (err) {
        failures.push(`${row.display_name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await supabaseAdmin
      .from("audit_events")
      .insert({ kind: "contact_import_undo", reason: `job ${data.jobId}: deleted ${deleted}` })
      .then(() => undefined, () => undefined);

    return { deleted, failures };
  });
