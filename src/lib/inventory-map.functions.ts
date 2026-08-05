import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

/**
 * MAP VIEW - addresses for buildings/projects, mirrored from the CRM into
 * record_locations, plus cached geocodes so the map loads instantly after the
 * first render.
 *
 * getRecordLocations: read the mirror.
 * syncRecordAddresses: walk building + project records in the CRM and upsert
 *   their address fields; a changed address clears its cached lat/lng so the
 *   client re-geocodes it.
 * saveGeocodes: persist client-side geocode results.
 */

function addressToString(raw: unknown): string {
  const v = Array.isArray(raw) ? raw[0] : raw;
  if (v && typeof v === "object") {
    return Object.values(v as Record<string, unknown>)
      .map((x) => String(x ?? "").trim())
      .filter(Boolean)
      .join(", ");
  }
  return String(v ?? "").trim();
}

export const getRecordLocations = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data, error } = await supabaseAdmin
      .from("record_locations")
      .select("crm_record_id, scope, address, lat, lng");
    if (error) return { rows: [], tableMissing: /record_locations/.test(error.message), error: error.message };
    return { rows: data ?? [], tableMissing: false, error: null };
  });

export const syncRecordAddresses = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { listLiveRecords, propsOf, readProp } = await import("./kleegr/live-records.server");
    const { FIELDS } = await import("./kleegr/field-map");

    const { data: existingRows } = await supabaseAdmin.from("record_locations").select("crm_record_id, address");
    const existing = new Map((existingRows ?? []).map((r) => [r.crm_record_id, r.address ?? ""]));

    let scanned = 0;
    const upserts: Array<{ crm_record_id: string; scope: string; address: string; lat: null; lng: null; synced_at: string }> = [];

    for (const scope of ["building", "project"] as const) {
      let records: Array<Record<string, unknown>> = [];
      try {
        records = await listLiveRecords(scope);
      } catch {
        continue; // one scope failing shouldn't sink the other
      }
      const key = scope === "building" ? FIELDS.building.address : FIELDS.project.address;
      for (const record of records) {
        const id = typeof record.id === "string" ? record.id : null;
        const props = id ? propsOf(record) : null;
        if (!id || !props) continue;
        scanned++;
        const address = addressToString(readProp(props, key));
        if (!address) continue;
        if ((existing.get(id) ?? "") === address) continue; // unchanged: keep cached geocode
        upserts.push({ crm_record_id: id, scope, address, lat: null, lng: null, synced_at: new Date().toISOString() });
      }
    }

    if (upserts.length > 0) {
      await supabaseAdmin.from("record_locations").upsert(upserts as never[], { onConflict: "crm_record_id" });
    }
    return { scanned, updated: upserts.length };
  });

export const saveGeocodes = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z
      .object({
        items: z
          .array(z.object({ id: z.string().min(1), lat: z.number(), lng: z.number() }))
          .max(500),
      })
      .parse(d),
  )
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    for (const it of data.items) {
      await supabaseAdmin
        .from("record_locations")
        .update({ lat: it.lat, lng: it.lng })
        .eq("crm_record_id", it.id);
    }
    return { saved: data.items.length };
  });
