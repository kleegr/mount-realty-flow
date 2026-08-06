import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * WALL MONITOR data - everything the wall needs in ONE call, so the TV only
 * hits the server once every couple of minutes.
 *
 * Sources:
 *  - external_id_map + unit_state + unit_details: live tree, buckets, prices
 *  - record_locations: building coordinates for the map scene
 *  - audit_events (unit scope): movement counts (today/week/month vs the
 *    previous period), the ticker, and recentMoves - the feed behind the
 *    "recent contracts & closings" panel AND the celebration overlay
 *  - CRM (best effort): salesperson leaderboard from opportunity owners -
 *    if the CRM is unreachable the wall still renders everything else
 */

function norm(v: unknown): string {
  return String(v ?? "").trim().toLowerCase().replace(/[\s_/-]+/g, "");
}
function bucketOf(stage: unknown, availability: unknown): "available" | "reserved" | "underContract" | "sold" | null {
  const s = norm(stage);
  if (s === "reservedlocked") return "reserved";
  if (s === "undercontract") return "underContract";
  if (s === "closedsold") return "sold";
  if (s === "available" || norm(availability) === "available") return "available";
  return null;
}
function statusWord(stage: string): "AVAILABLE" | "RESERVED" | "UNDER CONTRACT" | "SOLD" | null {
  const s = norm(stage);
  if (s === "reservedlocked" || s.includes("reserved")) return "RESERVED";
  if (s === "undercontract" || s.includes("contract")) return "UNDER CONTRACT";
  if (s === "closedsold" || s.includes("closed") || s.includes("sold")) return "SOLD";
  if (s === "available") return "AVAILABLE";
  return null;
}
function pickStage(o: unknown): string {
  if (!o || typeof o !== "object") return "";
  const r = o as Record<string, unknown>;
  for (const k of ["stage", "unit_stage", "stageName", "next_stage", "value", "unit_state", "availability"]) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}
function shortLabel(name: string | null, parent?: string | null): string {
  let s = String(name ?? "").trim();
  const p = String(parent ?? "").trim();
  if (p && s.startsWith(p + " - ")) s = s.slice(p.length + 3);
  else if (s.includes(" - ")) s = s.slice(s.lastIndexOf(" - ") + 3);
  const parts = s.split(" ");
  const half = parts.length / 2;
  if (Number.isInteger(half) && half > 0 && parts.slice(0, half).join(" ") === parts.slice(half).join(" ")) {
    s = parts.slice(0, half).join(" ");
  }
  return s;
}
function midLabel(name: string | null, project?: string | null): string {
  // Building label without the project prefix but WITH its own name.
  let s = String(name ?? "").trim();
  const p = String(project ?? "").trim();
  if (p && s.startsWith(p + " - ")) s = s.slice(p.length + 3);
  return s;
}

export const getWallData = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async () => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    const since = new Date(Date.now() - 62 * 24 * 3600 * 1000).toISOString();
    const [mapRes, stateRes, detailRes, locRes, eventsRes, tickRes] = await Promise.all([
      supabaseAdmin.from("external_id_map").select("scope, crm_record_id, display_name, parent_crm_id"),
      supabaseAdmin.from("unit_state").select("unit_crm_id, availability, stage"),
      supabaseAdmin.from("unit_details").select("unit_crm_id, props"),
      supabaseAdmin.from("record_locations").select("crm_record_id, address, lat, lng"),
      supabaseAdmin
        .from("audit_events")
        .select("created_at")
        .eq("entity_scope", "unit")
        .gte("created_at", since),
      supabaseAdmin
        .from("audit_events")
        .select("id, created_at, entity_crm_id, previous, next")
        .eq("entity_scope", "unit")
        .order("created_at", { ascending: false })
        .limit(120),
    ]);

    const rows = mapRes.data ?? [];
    const projects = rows.filter((r) => r.scope === "project");
    const buildings = rows.filter((r) => r.scope === "building");
    const units = rows.filter((r) => r.scope === "unit");
    const projById = new Map(projects.map((p) => [p.crm_record_id, p]));
    const bldById = new Map(buildings.map((b) => [b.crm_record_id, b]));
    const unitById = new Map(units.map((u) => [u.crm_record_id, u]));

    const stateById = new Map((stateRes.data ?? []).map((s) => [s.unit_crm_id, s]));
    const priceById = new Map<string, number>();
    for (const d of detailRes.data ?? []) {
      const p = (d.props as Record<string, unknown> | null)?.price;
      const n = typeof p === "number" ? p : Number(p);
      if (Number.isFinite(n) && n > 0) priceById.set(d.unit_crm_id, n);
    }

    // ---- totals + per-building/project aggregation + volume
    const totals = { available: 0, reserved: 0, underContract: 0, sold: 0 };
    let contractedVolume = 0;
    interface Agg { available: number; reserved: number; underContract: number; sold: number; total: number }
    const perBuilding = new Map<string, Agg>();
    const perProject = new Map<string, Agg>();
    const bump = (m: Map<string, Agg>, k: string, b: string | null) => {
      const a = m.get(k) ?? { available: 0, reserved: 0, underContract: 0, sold: 0, total: 0 };
      a.total++;
      if (b) a[b as keyof Omit<Agg, "total">]++;
      m.set(k, a);
    };

    for (const u of units) {
      const st = stateById.get(u.crm_record_id);
      const b = bucketOf(st?.stage, st?.availability);
      if (b) totals[b]++;
      if (b === "underContract" || b === "sold") {
        contractedVolume += priceById.get(u.crm_record_id) ?? 0;
      }
      const bld = u.parent_crm_id ? bldById.get(u.parent_crm_id) : null;
      const proj = bld?.parent_crm_id ? projById.get(bld.parent_crm_id) : null;
      if (bld) bump(perBuilding, bld.crm_record_id, b);
      if (proj) bump(perProject, proj.crm_record_id, b);
    }

    // ---- projects with their BUILDINGS (for the project-tour scene)
    const projectCards = [...perProject.entries()]
      .map(([id, a]) => {
        const projName = String(projById.get(id)?.display_name ?? "");
        const blds = buildings
          .filter((b) => b.parent_crm_id === id)
          .map((b) => {
            const ba = perBuilding.get(b.crm_record_id) ?? { available: 0, reserved: 0, underContract: 0, sold: 0, total: 0 };
            return {
              label: midLabel(b.display_name, projName).toUpperCase(),
              available: ba.available,
              reserved: ba.reserved,
              underContract: ba.underContract,
              sold: ba.sold,
              total: ba.total,
            };
          })
          .filter((b) => b.total > 0)
          .sort((x, y) => x.label.localeCompare(y.label));
        return {
          id,
          name: projName.toUpperCase(),
          total: a.total,
          available: a.available,
          reserved: a.reserved,
          underContract: a.underContract,
          sold: a.sold,
          buildings: blds,
        };
      })
      .filter((p) => p.name && p.total > 0)
      .sort((a, b) => b.total - a.total);

    // ---- map buildings (need coordinates)
    const locById = new Map((locRes.data ?? []).map((l) => [l.crm_record_id, l]));
    const mapBuildings = buildings
      .map((b) => {
        const loc = locById.get(b.crm_record_id);
        const projLoc = b.parent_crm_id ? locById.get(b.parent_crm_id) : null;
        const lat = loc?.lat ?? projLoc?.lat;
        const lng = loc?.lng ?? projLoc?.lng;
        if (lat == null || lng == null) return null;
        const a = perBuilding.get(b.crm_record_id);
        if (!a || a.total === 0) return null;
        const proj = b.parent_crm_id ? projById.get(b.parent_crm_id) : null;
        return {
          id: b.crm_record_id,
          label: midLabel(b.display_name, proj?.display_name),
          project: String(proj?.display_name ?? ""),
          address: String(loc?.address ?? projLoc?.address ?? ""),
          lat: Number(lat),
          lng: Number(lng),
          available: a.available,
          reserved: a.reserved,
          underContract: a.underContract,
          sold: a.sold,
          total: a.total,
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // ---- movement: today / week / month vs previous periods
    const stamps = (eventsRes.data ?? []).map((e) => new Date(e.created_at as string).getTime());
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const t0 = startOfToday.getTime();
    const inRange = (from: number, to: number) => stamps.filter((s) => s >= from && s < to).length;
    const activity = {
      today: { moves: inRange(t0, now), prev: inRange(t0 - day, t0) },
      week: { moves: inRange(now - 7 * day, now), prev: inRange(now - 14 * day, now - 7 * day) },
      month: { moves: inRange(now - 30 * day, now), prev: inRange(now - 60 * day, now - 30 * day) },
    };

    // ---- recent moves: the feed for the panel, the ticker AND the
    //      celebration overlay (new SOLD events trigger the balloons)
    const recentMoves: Array<{ id: string; at: string; status: "AVAILABLE" | "RESERVED" | "UNDER CONTRACT" | "SOLD"; unit: string; building: string; project: string }> = [];
    for (const e of tickRes.data ?? []) {
      const u = e.entity_crm_id ? unitById.get(e.entity_crm_id) : null;
      if (!u) continue;
      const st = statusWord(pickStage(e.next));
      if (!st || st === "AVAILABLE") continue; // the wall celebrates movement INTO holding stages
      const bld = u.parent_crm_id ? bldById.get(u.parent_crm_id) : null;
      const proj = bld?.parent_crm_id ? projById.get(bld.parent_crm_id) : null;
      recentMoves.push({
        id: String(e.id),
        at: String(e.created_at),
        status: st,
        unit: shortLabel(u.display_name, bld?.display_name ?? "").toUpperCase(),
        building: midLabel(bld?.display_name ?? "", proj?.display_name).toUpperCase(),
        project: String(proj?.display_name ?? "").toUpperCase(),
      });
      if (recentMoves.length >= 16) break;
    }
    const ticker = recentMoves.slice(0, 10).map((m) => `${m.status} \u2014 ${m.building} \u00b7 ${m.unit}`);

    // ---- leaderboard (best effort, CRM)
    let leaderboard: Array<{ name: string; deals: number; contract: number }> = [];
    try {
      const { createCrmClient } = await import("./kleegr/client.server");
      const client = await createCrmClient();
      const locationId = String(client.config.location_id ?? "");
      const uRes = await client.request<{ users?: Array<Record<string, unknown>> }>("GET", "/users/", {
        query: { locationId },
      });
      const userName = new Map(
        (uRes.data?.users ?? []).map((u) => [String(u.id ?? ""), String(u.name ?? `${u.firstName ?? ""} ${u.lastName ?? ""}`).trim()]),
      );
      const counts = new Map<string, { deals: number; contract: number }>();
      for (let page = 1; page <= 8; page++) {
        const sr = await client.request<{ opportunities?: Array<Record<string, unknown>> }>("GET", "/opportunities/search", {
          query: { location_id: locationId, limit: 100, page },
        });
        const opps = Array.isArray(sr.data?.opportunities) ? sr.data.opportunities : [];
        if (opps.length === 0) break;
        for (const o of opps) {
          const owner = String(o.assignedTo ?? o.assigned_to ?? "");
          if (!owner) continue;
          const slot = counts.get(owner) ?? { deals: 0, contract: 0 };
          slot.deals++;
          const stageName = norm((o.pipelineStageName as string) ?? "");
          if (stageName.includes("contract") || stageName.includes("locked") || norm(String(o.status ?? "")) === "won") slot.contract++;
          counts.set(owner, slot);
        }
        if (opps.length < 100) break;
      }
      leaderboard = [...counts.entries()]
        .map(([id, c]) => ({ name: userName.get(id) || "Unknown", deals: c.deals, contract: c.contract }))
        .filter((l) => l.name && l.name !== "Unknown")
        .sort((a, b) => b.contract - a.contract || b.deals - a.deals)
        .slice(0, 7);
    } catch {
      leaderboard = [];
    }

    return {
      totals,
      totalUnits: totals.available + totals.reserved + totals.underContract + totals.sold,
      contractedVolume,
      activity,
      projects: projectCards,
      recentMoves,
      ticker,
      mapBuildings,
      leaderboard,
      generatedAt: new Date().toISOString(),
    };
  });
