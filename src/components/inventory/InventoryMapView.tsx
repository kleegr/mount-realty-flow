import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-react";
import { getRecordLocations, saveGeocodes, syncRecordAddresses } from "@/lib/inventory-map.functions";

/**
 * MAP VIEW - one pin per building (falling back to the project address when a
 * building has none), colored by that building's unit stages:
 * green if anything is Available, amber if only Reserved, blue if Under
 * Contract, gray if Sold out. The pin's number = available units, and the
 * street address is written right under the pin. Clicking either opens the
 * building card listing every unit with its stage and holder.
 *
 * All properties are in the Blooming Grove / Monroe NY area, so geocoding is
 * biased there, ", NY" is appended to bare addresses, and any result landing
 * outside the area is rejected (listed under the map instead of mis-pinned).
 * Cached coordinates that fall outside the area are re-geocoded once.
 */

const STAGE_COLOR: Record<string, string> = {
  Available: "#10b981",
  "Reserved/Locked": "#f59e0b",
  "Under Contract": "#0ea5e9",
  "Closed/Sold": "#94a3b8",
};

const GKEY = (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) || "AIzaSyBjnAKmoD8mmxO3xhNImshrDqzH2yg423k";

// Home turf: Blooming Grove / Monroe, Orange County NY.
const AREA_CENTER = { lat: 41.36, lng: -74.17 };
const AREA_ZOOM = 12;
// Geocoder bias box (tight around Blooming Grove + Monroe).
const BIAS_SW = { lat: 41.25, lng: -74.35 };
const BIAS_NE = { lat: 41.5, lng: -74.05 };
// Acceptance box (a bit wider); results outside are treated as not found.
const ACCEPT = { south: 41.1, north: 41.65, west: -74.55, east: -73.85 };
function inArea(lat: number, lng: number): boolean {
  return lat >= ACCEPT.south && lat <= ACCEPT.north && lng >= ACCEPT.west && lng <= ACCEPT.east;
}

interface MapPerson {
  oppId: string;
  name: string | null;
  oppName: string | null;
}
interface MapUnit {
  id: string;
  label: string;
  stage: string;
  holder: MapPerson | null;
  interested: MapPerson[];
}
interface MapBuilding {
  id: string;
  label: string;
  counts: { available: number; reserved: number; underContract: number; sold: number };
  units: MapUnit[];
}
interface MapModel {
  projects: Array<{ id: string; name: string; buildings: MapBuilding[] }>;
}

function crmBase(): string {
  try {
    if (typeof document !== "undefined" && document.referrer) {
      const u = new URL(document.referrer);
      if (typeof window === "undefined" || u.origin !== window.location.origin) return u.origin;
    }
  } catch {
    /* fall through */
  }
  return "https://app.gohighlevel.com";
}
function opportunityUrl(locationId: string, oppId: string): string {
  return `${crmBase()}/v2/location/${locationId}/opportunities/list/${oppId}?tab=OpportunityDetails`;
}
function esc(s: unknown): string {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
/** "15 Perlman Dr, Monroe, NY 10950" -> "15 Perlman Dr" for the on-map label. */
function shortAddress(addr: string): string {
  const first = addr.split(",")[0]?.trim() ?? addr;
  return first.length > 28 ? first.slice(0, 27) + "…" : first;
}

let gmapsPromise: Promise<unknown> | null = null;
function loadGoogle(): Promise<unknown> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  const w = window as unknown as Record<string, unknown> & { google?: { maps?: unknown } };
  if (w.google?.maps) return Promise.resolve(w.google);
  if (!gmapsPromise) {
    gmapsPromise = new Promise((resolve, reject) => {
      (w as Record<string, unknown>).__mrMapReady = () => resolve(w.google);
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GKEY)}&callback=__mrMapReady`;
      s.async = true;
      s.onerror = () => reject(new Error("Google Maps failed to load"));
      document.head.appendChild(s);
    });
  }
  return gmapsPromise;
}

export function InventoryMapView({ model, locationId }: { model: MapModel; locationId: string }) {
  const qc = useQueryClient();
  const locFn = useServerFn(getRecordLocations);
  const syncFn = useServerFn(syncRecordAddresses);
  const saveFn = useServerFn(saveGeocodes);
  const { data: locData } = useQuery({ queryKey: ["record-locations"], queryFn: () => locFn() });

  const [syncing, setSyncing] = useState(false);
  const [status, setStatus] = useState("Loading map…");
  const [noAddress, setNoAddress] = useState<string[]>([]);
  const mapEl = useRef<HTMLDivElement>(null);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const autoSynced = useRef(false);

  async function runSync() {
    setSyncing(true);
    try {
      await syncFn();
      await qc.invalidateQueries({ queryKey: ["record-locations"] });
    } finally {
      setSyncing(false);
    }
  }

  // First visit: the mirror is empty, so fill it automatically.
  useEffect(() => {
    if (!locData || autoSynced.current) return;
    if (!locData.tableMissing && locData.rows.length === 0) {
      autoSynced.current = true;
      void runSync();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locData]);

  useEffect(() => {
    if (!locData || locData.tableMissing) return;
    let cancelled = false;
    (async () => {
      const g: any = await loadGoogle().catch(() => null);
      if (!g || cancelled || !mapEl.current) return;
      if (!mapRef.current) {
        mapRef.current = new g.maps.Map(mapEl.current, {
          center: AREA_CENTER,
          zoom: AREA_ZOOM,
          streetViewControl: false,
          mapTypeControl: false,
        });
      }
      const map = mapRef.current;
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];

      const locById = new Map<string, any>(locData.rows.map((r: any) => [r.crm_record_id, { ...r }]));
      const geocoder = new g.maps.Geocoder();
      const info = new g.maps.InfoWindow();
      const biasBounds = new g.maps.LatLngBounds(BIAS_SW, BIAS_NE);
      const toSave: Array<{ id: string; lat: number; lng: number }> = [];
      const bounds = new g.maps.LatLngBounds();
      const missing: string[] = [];
      const posCount = new Map<string, number>();
      let plotted = 0;

      // Bias to home turf; add ", NY" when the stored address doesn't say so.
      const geocodeOne = (address: string) =>
        new Promise<{ lat: number; lng: number } | null>((resolve) => {
          const query = /\bny\b|new york/i.test(address) ? address : `${address}, NY`;
          geocoder.geocode({ address: query, bounds: biasBounds, region: "us" }, (results: any, st: string) => {
            if (st === "OK" && results?.[0]) {
              const l = results[0].geometry.location;
              const lat = l.lat();
              const lng = l.lng();
              resolve(inArea(lat, lng) ? { lat, lng } : null);
            } else resolve(null);
          });
        });

      for (const p of model.projects) {
        for (const b of p.buildings) {
          if (cancelled) return;
          if (b.units.length === 0 || b.id === "__loose__") continue;
          let ownerId = b.id;
          let loc = locById.get(b.id);
          if (!loc?.address) {
            const pl = locById.get(p.id);
            if (pl?.address) {
              loc = pl;
              ownerId = p.id;
            }
          }
          if (!loc?.address) {
            missing.push(`${p.name} · ${b.label}`);
            continue;
          }
          let lat = loc.lat;
          let lng = loc.lng;
          // A cached point outside the area was a bad geocode - redo it.
          if (lat != null && lng != null && !inArea(Number(lat), Number(lng))) {
            lat = null;
            lng = null;
          }
          if (lat == null || lng == null) {
            setStatus(`Locating ${b.label}…`);
            const r = await geocodeOne(loc.address);
            if (!r) {
              missing.push(`${p.name} · ${b.label} (not found near Blooming Grove/Monroe: ${loc.address})`);
              continue;
            }
            lat = r.lat;
            lng = r.lng;
            loc.lat = lat;
            loc.lng = lng; // in-session cache so a shared project address geocodes once
            toSave.push({ id: ownerId, lat, lng });
            await new Promise((res) => setTimeout(res, 150));
          }

          // Buildings sharing one address (project fallback) fan out slightly.
          const key = `${Number(lat).toFixed(6)},${Number(lng).toFixed(6)}`;
          const n = posCount.get(key) ?? 0;
          posCount.set(key, n + 1);
          const aLat = Number(lat) + n * 0.00035;
          const aLng = Number(lng) + n * 0.00035;

          const c = b.counts;
          const color =
            c.available > 0
              ? STAGE_COLOR.Available
              : c.reserved > 0
                ? STAGE_COLOR["Reserved/Locked"]
                : c.underContract > 0
                  ? STAGE_COLOR["Under Contract"]
                  : c.sold > 0
                    ? STAGE_COLOR["Closed/Sold"]
                    : "#64748b";

          const marker = new g.maps.Marker({
            map,
            position: { lat: aLat, lng: aLng },
            icon: {
              path: g.maps.SymbolPath.CIRCLE,
              fillColor: color,
              fillOpacity: 1,
              strokeColor: "#ffffff",
              strokeWeight: 2,
              scale: Math.min(16, 9 + b.units.length),
            },
            label:
              c.available > 0
                ? { text: String(c.available), color: "#ffffff", fontSize: "11px", fontWeight: "700" }
                : undefined,
            title: `${p.name} · ${b.label} — ${loc.address}`,
          });

          // The street address, written on the map just under the pin.
          const textMarker = new g.maps.Marker({
            map,
            position: { lat: aLat - 0.0011, lng: aLng },
            icon: { path: g.maps.SymbolPath.CIRCLE, scale: 0 },
            label: {
              text: shortAddress(loc.address),
              color: "#1d2939",
              fontSize: "11px",
              fontWeight: "600",
            },
            clickable: true,
            title: `${p.name} · ${b.label} — ${loc.address}`,
          });

          const unitsHtml = b.units
            .map((u) => {
              const col = STAGE_COLOR[u.stage] ?? "#64748b";
              const holder = u.holder
                ? ` — <a href="${opportunityUrl(locationId, u.holder.oppId)}" target="_top" style="color:#2563eb">${esc(u.holder.name ?? u.holder.oppName ?? "deal")}</a>`
                : "";
              const interest =
                u.interested.length > 0 ? ` <span style="color:#92400e">(${u.interested.length} interested)</span>` : "";
              return `<div style="margin:2px 0"><b>${esc(u.label)}</b> — <span style="color:${col};font-weight:600">${esc(u.stage || "—")}</span>${holder}${interest}</div>`;
            })
            .join("");
          const openCard = () => {
            info.setContent(
              `<div style="font:13px/1.5 system-ui;max-width:280px"><div style="font-size:14px;font-weight:700">${esc(b.label)}</div><div style="color:#667085">${esc(p.name)} · ${esc(loc.address)}</div><div style="margin-top:6px">${unitsHtml}</div></div>`,
            );
            info.open(map, marker);
          };
          marker.addListener("click", openCard);
          textMarker.addListener("click", openCard);
          markersRef.current.push(marker, textMarker);
          bounds.extend({ lat: aLat, lng: aLng });
          plotted++;
        }
      }

      if (toSave.length > 0) {
        void saveFn({ data: { items: toSave } });
      }
      if (cancelled) return;
      setNoAddress(missing);
      setStatus(`${plotted} building${plotted === 1 ? "" : "s"} on the map`);
      if (!bounds.isEmpty()) {
        map.fitBounds(bounds, 60);
        // Stay zoomed in on the area - never zoom out past it, never in past street level.
        g.maps.event.addListenerOnce(map, "idle", () => {
          if (map.getZoom() > 16) map.setZoom(16);
          if (map.getZoom() < AREA_ZOOM) {
            map.setZoom(AREA_ZOOM);
            map.setCenter(AREA_CENTER);
          }
        });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locData, model]);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  if (locData?.tableMissing) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
        The <code>record_locations</code> table doesn't exist yet. Run the migration in
        <code> supabase/migrations/20260805191500_record_locations.sql</code> (Supabase → SQL editor → paste → Run),
        then reload this page.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        {Object.entries(STAGE_COLOR).map(([label, col]) => (
          <span key={label} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: col }} />
            {label}
          </span>
        ))}
        <span className="text-xs text-muted-foreground">· pin number = available units</span>
        <span className="flex-1" />
        <span className="text-xs text-muted-foreground">{status}</span>
        <Button variant="outline" size="sm" onClick={() => void runSync()} disabled={syncing}>
          <RefreshCw className={syncing ? "mr-1.5 h-3.5 w-3.5 animate-spin" : "mr-1.5 h-3.5 w-3.5"} />
          {syncing ? "Syncing addresses…" : "Sync addresses"}
        </Button>
      </div>
      <div ref={mapEl} className="h-[70vh] w-full overflow-hidden rounded-lg border" />
      {noAddress.length > 0 && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          <b>Not on the map — no address on file (fill Building Address in the CRM, then Sync addresses):</b>
          <div className="mt-1 space-y-0.5">
            {noAddress.map((n) => (
              <div key={n}>{n}</div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
