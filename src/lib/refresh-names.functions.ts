import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * REFRESH OPPORTUNITY NAMES.
 *
 * The import names each deal "{contact full name} {phone}". But the importer
 * SKIPS a unit already locked, so once a deal exists its name is frozen - adding
 * a phone to the contact later never flows onto the card. This tool fixes that
 * WITHOUT deleting or re-importing: it walks the deals in a pipeline, reads each
 * one's linked contact fresh from GHL, rebuilds the name, and PUTs it back only
 * when it actually changed.
 *
 * SAFE: rename only. No deletes, no new records, no association changes. A deal
 * with no linked contact, or whose name is already correct, is left untouched.
 *
 * The phone comes from the CONTACT, which is the durable home for it. So the
 * workflow is: add missing phones to contacts in GHL -> run this -> names update.
 */

async function requireImporter(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
  const roles = (data ?? []).map((r) => r.role);
  if (!roles.includes("admin") && !roles.includes("importer")) throw new Error("Forbidden: importer role required.");
}

function clean(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function shortErr(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? raw;
  return m.slice(0, 200);
}

/** Build "{full name} {phone}" from a contact record, phone optional. */
function contactName(contact: Record<string, unknown>): string {
  const first = clean(contact.firstName ?? contact.first_name);
  const last = clean(contact.lastName ?? contact.last_name);
  const full =
    clean(contact.contactName ?? contact.name ?? contact.full_name) || clean(`${first} ${last}`) || "";
  const phone = clean(contact.phone ?? contact.phoneNumber);
  return phone ? `${full} ${phone}`.trim() : full;
}

export const refreshOpportunityNames = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        confirm: z.literal("REFRESH"),
        pipelineId: z.string().min(1),
        dryRun: z.boolean().default(true),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(20).default(15),
      })
      .parse(d),
  )
  .handler(async ({ data, context }) => {
    await requireImporter(context.userId);

    const { createCrmClient } = await import("./kleegr/client.server");
    const client = await createCrmClient();
    const locationId = String(client.config.location_id);

    // Page the pipeline's deals. Renaming does not change membership, so a
    // stable offset walk is safe here (unlike deletion).
    const search = await client.request<{
      opportunities?: Array<Record<string, unknown>>;
      meta?: { total?: number };
      total?: number;
    }>("GET", "/opportunities/search", {
      query: {
        location_id: locationId,
        pipeline_id: data.pipelineId,
        limit: data.limit,
        // GHL search paginates by startAfterId in some versions; offset via
        // page is approximated by skip when supported.
        skip: data.offset,
      },
    });

    const list = Array.isArray(search.data?.opportunities) ? search.data.opportunities : [];
    const total = search.data?.meta?.total ?? search.data?.total ?? list.length;

    const results: Array<{ oppId: string; from: string; to: string; action: string }> = [];

    for (const o of list) {
      const oppId = typeof o.id === "string" ? o.id : "";
      if (!oppId) continue;
      const currentName = clean(o.name);
      const contactId =
        (typeof o.contactId === "string" && o.contactId) ||
        (typeof o.contact_id === "string" && o.contact_id) ||
        (o.contact && typeof o.contact === "object" ? String((o.contact as Record<string, unknown>).id ?? "") : "");

      if (!contactId) {
        results.push({ oppId, from: currentName, to: currentName, action: "no linked contact - skipped" });
        continue;
      }

      try {
        const cRes = await client.request<Record<string, unknown>>("GET", `/contacts/${contactId}`, {});
        const cd = (cRes.data ?? {}) as Record<string, unknown>;
        const contact = (cd.contact && typeof cd.contact === "object" ? cd.contact : cd) as Record<string, unknown>;
        const desired = contactName(contact);

        if (!desired) {
          results.push({ oppId, from: currentName, to: currentName, action: "contact has no name - skipped" });
          continue;
        }
        if (desired === currentName) {
          results.push({ oppId, from: currentName, to: desired, action: "already correct" });
          continue;
        }

        if (data.dryRun) {
          results.push({ oppId, from: currentName, to: desired, action: "would rename" });
          continue;
        }

        await client.request("PUT", `/opportunities/${oppId}`, {
          body: { name: desired },
        });
        results.push({ oppId, from: currentName, to: desired, action: "renamed" });
      } catch (err) {
        results.push({ oppId, from: currentName, to: currentName, action: `error: ${shortErr(err)}` });
      }
    }

    const nextOffset = data.offset + list.length;
    return {
      dryRun: data.dryRun,
      total,
      processed: list.length,
      renamed: results.filter((r) => r.action === "renamed").length,
      wouldRename: results.filter((r) => r.action === "would rename").length,
      alreadyCorrect: results.filter((r) => r.action === "already correct").length,
      skipped: results.filter((r) => /skipped/.test(r.action)).length,
      errors: results.filter((r) => r.action.startsWith("error")),
      results,
      nextOffset,
      remaining: Math.max(0, total - nextOffset),
    };
  });
