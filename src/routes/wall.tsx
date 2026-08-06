import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getWallData } from "@/lib/wall.functions";

/**
 * WALL MONITOR — pass 8: pass 7's editorial design, now LIVE.
 *
 * - Every figure comes from getWallData (refetched every 2 minutes):
 *   stage totals, contracted volume, movement vs previous periods, the
 *   board roll, the ticker, per-project mixes.
 * - TWO SCENES alternating every 40s: the editorial board, and the MAP —
 *   a dark-styled Google map that tours the portfolio, gliding building to
 *   building (pin color = status, pin number = available units), zooming
 *   out to the whole valley between chapters. The owner's ask: the wall
 *   should breathe, constantly showing building status on the map.
 * - TEAM / GUESTS switch (tiny pill in the masthead, remembered on the
 *   device): TEAM rotates a salesperson leaderboard into the rail; GUESTS
 *   keeps the wall customer-safe — no team names anywhere.
 * - The chartreuse banner keeps its three-sayings-an-hour ritual.
 *
 * Top-level route on purpose — _authenticated wraps every page in the
 * AppShell ribbon. Auth still gates it via beforeLoad.
 */

export const Route = createFileRoute("/wall")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
  },
  component: WallMonitor,
});

const LIME = "#C6D92E";
const ON_LIME = "#2E360B";
const GOLD = "#C9A961";
const SAGE = "#8C9A73";
const OLIVE = "#222B15";
const INK = "#0E1108";
const IVORY = "#F4F1E4";

const DISPLAY = "'Anton','Arial Narrow',Impact,sans-serif";
const BODY = "'Archivo',Inter,system-ui,sans-serif";

type Status = "AVAILABLE" | "RESERVED" | "UNDER CONTRACT" | "SOLD";
const STATUS_TONE: Record<Status, string> = {
  AVAILABLE: LIME,
  RESERVED: GOLD,
  "UNDER CONTRACT": SAGE,
  SOLD: IVORY,
};

const SAYINGS = [
  "The fortune is in the follow-up.",
  "Speed to lead wins the deal.",
  "You don't find time to prospect. You make it.",
  "Every no is one call closer to a yes.",
  "Know your inventory better than your buyer does.",
  "The listing you don't ask for is the listing you don't get.",
  "Objections are questions wearing a disguise.",
  "Consistency beats intensity.",
  "Sell the neighborhood, not just the house.",
  "The market rewards the prepared, not the lucky.",
  "A deal isn't done until the keys change hands.",
  "Talk to more people today than you did yesterday.",
  "Listen twice as long as you pitch.",
  "The second call is where the trust starts.",
  "Price tells them what. You tell them why.",
  "Nobody ever regretted one more call.",
  "Answer fast. Answer honest. Answer again.",
  "A buyer remembers how you made the hard part easy.",
  "Know the street before you sell the address.",
  "Momentum is built, not found.",
  "The best negotiator in the room prepared the most.",
  "Show up before you're needed.",
  "Your pipeline today is your paycheck in ninety days.",
  "Small promises, kept, close big deals.",
];
const SET_COUNT = Math.floor(SAYINGS.length / 3);

const GKEY = (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) || "AIzaSyBjnAKmoD8mmxO3xhNImshrDqzH2yg423k";
const AREA_CENTER = { lat: 41.36, lng: -74.17 };

/** Night map palette tuned to the wall's olive/ivory brand. */
const MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#161c0e" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8C9A73" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#0E1108" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#2a3319" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#6f7d5a" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#0d1a1c" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#1a2210" }] },
];

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

function useAsset(src: string) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setOk(true);
    img.src = src;
  }, [src]);
  return ok;
}

let gmapsPromise: Promise<unknown> | null = null;
function loadGoogle(): Promise<unknown> {
  if (typeof window === "undefined") return Promise.reject(new Error("no window"));
  const w = window as unknown as Record<string, unknown> & { google?: { maps?: unknown } };
  if (w.google?.maps) return Promise.resolve(w.google);
  if (!gmapsPromise) {
    gmapsPromise = new Promise((resolve, reject) => {
      (w as Record<string, unknown>).__mrWallMap = () => resolve(w.google);
      const s = document.createElement("script");
      s.src = `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GKEY)}&callback=__mrWallMap`;
      s.async = true;
      s.onerror = () => reject(new Error("maps failed"));
      document.head.appendChild(s);
    });
  }
  return gmapsPromise;
}

type WallData = Awaited<ReturnType<ReturnType<typeof useServerFn<typeof getWallData>>>>;
type MapB = WallData["mapBuildings"][number];

function WallMonitor() {
  const wallFn = useServerFn(getWallData);
  const { data } = useQuery({ queryKey: ["wall-data"], queryFn: () => wallFn(), refetchInterval: 120_000 });

  const [now, setNow] = useState(() => new Date());
  const [spot, setSpot] = useState(0);
  const [sayIdx, setSayIdx] = useState(0);
  const [scene, setScene] = useState<"board" | "map">("board");
  const [railFlip, setRailFlip] = useState(0); // team mode: spotlight <-> leaderboard
  const [mode, setMode] = useState<"team" | "guests">(() => {
    try {
      return localStorage.getItem("mr-wall-mode") === "guests" ? "guests" : "team";
    } catch {
      return "team";
    }
  });
  const hasLogo = useAsset("/mount-logo.svg");
  const hasHero = useAsset("/mount-hero.jpg");

  function switchMode(m: "team" | "guests") {
    setMode(m);
    try {
      localStorage.setItem("mr-wall-mode", m);
    } catch {
      /* fine */
    }
  }

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setSpot((s) => s + 1), 8000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setSayIdx((i) => (i + 1) % 3), 3000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setScene((s) => (s === "board" ? "map" : "board")), 40_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setRailFlip((f) => f + 1), 13_000);
    return () => clearInterval(t);
  }, []);

  const totals = data?.totals ?? { available: 0, reserved: 0, underContract: 0, sold: 0 };
  const TOTAL = data?.totalUnits ?? 0;
  const projects = data?.projects ?? [];
  const p = projects.length > 0 ? projects[spot % projects.length] : null;
  const saying = SAYINGS[(now.getHours() % SET_COUNT) * 3 + sayIdx];
  const roll = data?.roll ?? [];
  const ticker = data?.ticker ?? [];
  const leaderboard = mode === "team" ? (data?.leaderboard ?? []) : [];
  const showLeaderboard = leaderboard.length > 0 && railFlip % 2 === 1;

  const ground = hasHero
    ? "linear-gradient(90deg, rgba(14,17,8,.95) 0%, rgba(14,17,8,.88) 46%, rgba(14,17,8,.58) 100%), url(/mount-hero.jpg)"
    : `radial-gradient(120% 90% at 84% 26%, rgba(201,169,97,.18) 0%, rgba(34,43,21,0) 58%), linear-gradient(180deg, ${OLIVE} 0%, ${INK} 100%)`;

  return (
    <div
      style={{
        height: "100vh",
        background: ground,
        backgroundSize: "cover",
        backgroundPosition: "center",
        color: IVORY,
        fontFamily: BODY,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&display=swap');
        @keyframes wRoll { from { transform: translateY(0) } to { transform: translateY(-50%) } }
        @keyframes wTick { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        @keyframes wIn { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
        @keyframes wSay { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
        @keyframes wDot { 0%,100% { opacity: 1 } 50% { opacity: .18 } }
        .grow { transition: width 1.1s cubic-bezier(.22,1,.36,1) }
        .roll { animation: wRoll 52s linear infinite }
        .rollMask {
          -webkit-mask-image: linear-gradient(180deg, transparent 0%, #000 12%, #000 88%, transparent 100%);
          mask-image: linear-gradient(180deg, transparent 0%, #000 12%, #000 88%, transparent 100%);
        }
      `}</style>

      {/* ---------------- masthead ---------------- */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 56px",
          height: 74,
          flexShrink: 0,
        }}
      >
        {hasLogo ? (
          <img src="/mount-logo.svg" alt="Mount Realty Group" style={{ height: 32 }} />
        ) : (
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <span style={{ fontFamily: DISPLAY, fontSize: 32, letterSpacing: "-0.02em", color: IVORY, lineHeight: 1 }}>
              MOUNT
            </span>
            <span style={{ fontSize: 9, letterSpacing: "0.56em", color: GOLD, fontWeight: 700 }}>REALTY GROUP</span>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: LIME, animation: "wDot 2s infinite" }} />
          <span style={{ fontSize: 10, letterSpacing: "0.42em", fontWeight: 700, color: LIME }}>LIVE INVENTORY</span>
          <span style={{ width: 1, height: 16, background: "rgba(244,241,228,.22)", margin: "0 5px" }} />
          <span style={{ fontSize: 11, letterSpacing: "0.2em", color: SAGE, fontWeight: 600 }}>
            {now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }).toUpperCase()}
            {"   "}
            {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </span>
          {/* team / guests switch - deliberately quiet */}
          <span style={{ width: 1, height: 16, background: "rgba(244,241,228,.22)", margin: "0 5px" }} />
          <div style={{ display: "flex", border: "1px solid rgba(244,241,228,.25)", borderRadius: 999, overflow: "hidden" }}>
            {(["team", "guests"] as const).map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                style={{
                  fontSize: 8,
                  letterSpacing: "0.3em",
                  fontWeight: 700,
                  padding: "4px 10px",
                  border: "none",
                  cursor: "pointer",
                  background: mode === m ? LIME : "transparent",
                  color: mode === m ? ON_LIME : SAGE,
                }}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* ---------------- body ---------------- */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: scene === "board" ? "1.28fr 0.9fr 1fr" : "2.18fr 1fr",
          gap: 40,
          padding: "0 56px 14px",
        }}
      >
        {scene === "board" ? (
          <>
            {/* --- the figure --- */}
            <section style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", animation: "wIn .6s both" }}>
              <div style={{ fontSize: 11, letterSpacing: "0.52em", fontWeight: 700, color: LIME }}>AVAILABLE NOW</div>
              <div style={{ fontSize: 10, letterSpacing: "0.34em", fontWeight: 600, color: SAGE, marginTop: 5 }}>
                BLOOMING GROVE · KIRYAS YOEL
              </div>

              <div style={{ display: "flex", alignItems: "flex-start", gap: 24, paddingTop: 22 }}>
                <span
                  style={{
                    fontFamily: DISPLAY,
                    fontSize: "clamp(96px, 20vh, 216px)",
                    lineHeight: 0.74,
                    letterSpacing: "-0.045em",
                    color: IVORY,
                    textShadow: hasHero ? "0 8px 60px rgba(0,0,0,.55)" : "none",
                  }}
                >
                  {totals.available}
                </span>
                <div style={{ paddingTop: 4 }}>
                  <div style={{ fontFamily: DISPLAY, fontSize: 27, color: LIME, lineHeight: 1 }}>{TOTAL}</div>
                  <div style={{ fontSize: 9, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, marginTop: 4 }}>
                    TOTAL UNITS
                  </div>
                  <div style={{ width: 28, height: 1, background: "rgba(244,241,228,.28)", margin: "11px 0" }} />
                  <div style={{ fontFamily: DISPLAY, fontSize: 27, color: IVORY, lineHeight: 1 }}>
                    {TOTAL > 0 ? Math.round((totals.available / TOTAL) * 100) : 0}%
                  </div>
                  <div style={{ fontSize: 9, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, marginTop: 4 }}>
                    OF PORTFOLIO
                  </div>
                </div>
              </div>

              <div style={{ display: "flex", height: 6, marginTop: 20, borderRadius: 999, overflow: "hidden", background: "rgba(244,241,228,.14)" }}>
                <div className="grow" style={{ width: `${TOTAL ? (totals.available / TOTAL) * 100 : 0}%`, background: LIME }} />
                <div className="grow" style={{ width: `${TOTAL ? (totals.reserved / TOTAL) * 100 : 0}%`, background: GOLD }} />
                <div className="grow" style={{ width: `${TOTAL ? (totals.underContract / TOTAL) * 100 : 0}%`, background: SAGE }} />
                <div className="grow" style={{ width: `${TOTAL ? (totals.sold / TOTAL) * 100 : 0}%`, background: IVORY }} />
              </div>

              <div
                style={{
                  display: "flex",
                  alignItems: "stretch",
                  marginTop: 22,
                  paddingTop: 16,
                  borderTop: "1px solid rgba(244,241,228,.16)",
                }}
              >
                <Period label="TODAY" moves={data?.activity.today.moves ?? 0} prev={data?.activity.today.prev ?? 0} against="YESTERDAY" />
                <Rule />
                <Period label="THIS WEEK" moves={data?.activity.week.moves ?? 0} prev={data?.activity.week.prev ?? 0} against="LAST WEEK" />
                <Rule />
                <Period label="THIS MONTH" moves={data?.activity.month.moves ?? 0} prev={data?.activity.month.prev ?? 0} against="LAST MONTH" />
              </div>
            </section>

            {/* --- the roll --- */}
            <section
              style={{
                minWidth: 0,
                display: "flex",
                flexDirection: "column",
                borderLeft: "1px solid rgba(244,241,228,.16)",
                borderRight: "1px solid rgba(244,241,228,.16)",
                padding: "20px 28px 0",
                minHeight: 0,
              }}
            >
              <div style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE, flexShrink: 0 }}>
                THE BOARD
              </div>
              <div className="rollMask" style={{ flex: 1, overflow: "hidden", marginTop: 12, minHeight: 0 }}>
                <div className="roll">
                  {[0, 1].map((dup) => (
                    <div key={dup}>
                      {(roll.length > 0 ? roll : [{ unit: "—", building: "SYNCING…", status: "AVAILABLE" as const }]).map((u, i) => (
                        <UnitRow key={`${dup}-${i}`} unit={u.unit} building={u.building} status={u.status as Status} />
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            </section>
          </>
        ) : (
          /* --- the map scene --- */
          <WallMap buildings={data?.mapBuildings ?? []} />
        )}

        {/* --- the rail --- */}
        <section style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <Line label="RESERVED" value={totals.reserved} tone={GOLD} />
          <Line label="UNDER CONTRACT" value={totals.underContract} tone={SAGE} />
          <Line label="SOLD" value={totals.sold} tone={IVORY} />

          <div style={{ height: 1, background: "rgba(244,241,228,.16)", margin: "18px 0" }} />

          <div style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE }}>CONTRACTED VOLUME</div>
          <div style={{ fontFamily: DISPLAY, fontSize: "clamp(38px, 5.8vh, 62px)", color: LIME, lineHeight: 0.95, letterSpacing: "-0.02em", marginTop: 5 }}>
            {money(data?.contractedVolume ?? 0)}
          </div>

          <div style={{ height: 1, background: "rgba(244,241,228,.16)", margin: "18px 0" }} />

          {showLeaderboard ? (
            <div key={`lb-${railFlip}`} style={{ animation: "wIn .6s both" }}>
              <div style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE }}>THE BOARD LEADERS</div>
              <div style={{ marginTop: 10 }}>
                {leaderboard.map((l, i) => (
                  <div
                    key={l.name}
                    style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "5px 0", borderBottom: "1px solid rgba(244,241,228,.08)" }}
                  >
                    <span style={{ fontFamily: DISPLAY, fontSize: 15, color: i === 0 ? LIME : SAGE, width: 18 }}>{i + 1}</span>
                    <span style={{ fontSize: 12, fontWeight: 600, color: IVORY, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "0.06em" }}>
                      {l.name.toUpperCase()}
                    </span>
                    <span style={{ fontFamily: DISPLAY, fontSize: 17, color: i === 0 ? LIME : IVORY }}>{l.contract}</span>
                    <span style={{ fontSize: 8, letterSpacing: "0.2em", color: SAGE, fontWeight: 700 }}>IN CONTRACT</span>
                  </div>
                ))}
              </div>
            </div>
          ) : p ? (
            <div key={`spot-${spot}`} style={{ animation: "wIn .6s both" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE }}>SPOTLIGHT</span>
                <div style={{ display: "flex", gap: 4 }}>
                  {projects.slice(0, 12).map((_, i) => (
                    <span
                      key={i}
                      style={{
                        width: i === spot % projects.length ? 16 : 6,
                        height: 2,
                        borderRadius: 999,
                        background: i === spot % projects.length ? LIME : "rgba(244,241,228,.24)",
                        transition: "width .4s",
                      }}
                    />
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 11 }}>
                <div style={{ display: "inline-flex", flexDirection: "column", background: INK, padding: "7px 15px", borderRadius: 4 }}>
                  <span style={{ fontSize: 8, letterSpacing: "0.38em", color: SAGE, fontWeight: 700 }}>PROJECT</span>
                  <span style={{ fontFamily: DISPLAY, fontSize: 22, color: IVORY, lineHeight: 1.15 }}>{p.name}</span>
                </div>
                <div style={{ display: "flex", height: 6, marginTop: 11, borderRadius: 999, overflow: "hidden", background: "rgba(244,241,228,.14)" }}>
                  <div className="grow" style={{ width: `${(p.available / p.total) * 100}%`, background: LIME }} />
                  <div className="grow" style={{ width: `${(p.reserved / p.total) * 100}%`, background: GOLD }} />
                  <div className="grow" style={{ width: `${(p.underContract / p.total) * 100}%`, background: SAGE }} />
                  <div className="grow" style={{ width: `${(p.sold / p.total) * 100}%`, background: IVORY }} />
                </div>
                <div style={{ display: "flex", gap: 15, marginTop: 9 }}>
                  <Legend swatch={LIME} label="AVAIL" n={p.available} />
                  <Legend swatch={GOLD} label="RES" n={p.reserved} />
                  <Legend swatch={SAGE} label="CONTRACT" n={p.underContract} />
                </div>
              </div>
            </div>
          ) : null}
        </section>
      </main>

      {/* ---------------- live activity ticker ---------------- */}
      <div style={{ overflow: "hidden", padding: "9px 0", flexShrink: 0, borderTop: "1px solid rgba(244,241,228,.12)" }}>
        <div style={{ display: "flex", width: "max-content", animation: "wTick 48s linear infinite" }}>
          {[0, 1].map((dup) => (
            <div key={dup} style={{ display: "flex" }}>
              {(ticker.length > 0 ? ticker : ["MOUNT REALTY · LIVE INVENTORY"]).map((t, i) => (
                <span
                  key={`${dup}-${i}`}
                  style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.24em", color: SAGE, padding: "0 38px", whiteSpace: "nowrap" }}
                >
                  {t}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- chartreuse banner ---------------- */}
      <footer
        style={{
          background: LIME,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 26,
          padding: "16px 56px",
          minHeight: 68,
        }}
      >
        <span style={{ fontSize: 9, letterSpacing: "0.46em", fontWeight: 700, color: ON_LIME, whiteSpace: "nowrap" }}>
          THIS HOUR
        </span>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {[0, 1, 2].map((i) => (
            <span
              key={i}
              style={{
                width: i === sayIdx ? 14 : 5,
                height: 3,
                borderRadius: 999,
                background: i === sayIdx ? INK : "rgba(46,54,11,.32)",
                transition: "width .4s",
              }}
            />
          ))}
        </div>
        <span style={{ width: 1, height: 24, background: "rgba(46,54,11,.30)", flexShrink: 0 }} />
        <span
          key={saying}
          style={{
            fontFamily: DISPLAY,
            fontSize: "clamp(19px, 2.9vh, 31px)",
            color: INK,
            letterSpacing: "0.01em",
            lineHeight: 1.1,
            animation: "wSay .45s both",
          }}
        >
          {saying}
        </span>
      </footer>
    </div>
  );
}

/**
 * THE MAP SCENE - a slow cinematic tour: glide to a building, hold, glide to
 * the next; every sixth stop pulls back to the whole valley. Pin color =
 * status mix (lime if anything is available), pin number = available units.
 */
function WallMap({ buildings }: { buildings: MapB[] }) {
  const mapEl = useRef<HTMLDivElement>(null);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const mapRef = useRef<any>(null);
  const markersRef = useRef<any[]>([]);
  const [tourIdx, setTourIdx] = useState(0);
  const ordered = [...buildings].sort((a, b) => a.project.localeCompare(b.project) || a.label.localeCompare(b.label));
  const current = ordered.length > 0 ? ordered[tourIdx % ordered.length] : null;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const g: any = await loadGoogle().catch(() => null);
      if (!g || cancelled || !mapEl.current) return;
      if (!mapRef.current) {
        mapRef.current = new g.maps.Map(mapEl.current, {
          center: AREA_CENTER,
          zoom: 12.4,
          disableDefaultUI: true,
          styles: MAP_STYLE,
          backgroundColor: "#161c0e",
        });
      }
      const map = mapRef.current;
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];
      for (const b of buildings) {
        const color = b.available > 0 ? LIME : b.reserved > 0 ? GOLD : b.underContract > 0 ? SAGE : "#6b7280";
        const marker = new g.maps.Marker({
          map,
          position: { lat: b.lat, lng: b.lng },
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: "#0E1108",
            strokeWeight: 2,
            scale: Math.min(15, 8 + b.total * 0.35),
          },
          label:
            b.available > 0
              ? { text: String(b.available), color: "#0E1108", fontSize: "11px", fontWeight: "700" }
              : undefined,
        });
        markersRef.current.push(marker);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildings]);

  // The tour clock.
  useEffect(() => {
    const t = setInterval(() => setTourIdx((i) => i + 1), 6500);
    return () => clearInterval(t);
  }, []);

  // Glide.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || ordered.length === 0) return;
    const overview = tourIdx % 6 === 5;
    if (overview) {
      map.panTo(AREA_CENTER);
      map.setZoom(12.2);
    } else if (current) {
      map.panTo({ lat: current.lat, lng: current.lng });
      map.setZoom(15.4);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tourIdx]);
  /* eslint-enable @typescript-eslint/no-explicit-any */

  const overview = tourIdx % 6 === 5;
  return (
    <section style={{ minWidth: 0, position: "relative", animation: "wIn .6s both", padding: "14px 0" }}>
      <div ref={mapEl} style={{ position: "absolute", inset: "14px 0", borderRadius: 10, overflow: "hidden", border: "1px solid rgba(244,241,228,.16)" }} />
      {/* caption card */}
      {current && !overview && (
        <div
          key={tourIdx}
          style={{
            position: "absolute",
            left: 22,
            bottom: 34,
            background: "rgba(14,17,8,.92)",
            border: "1px solid rgba(244,241,228,.18)",
            borderRadius: 6,
            padding: "12px 18px",
            animation: "wIn .5s both",
            maxWidth: 380,
          }}
        >
          <div style={{ fontSize: 8, letterSpacing: "0.38em", color: SAGE, fontWeight: 700 }}>
            {current.project.toUpperCase()}
          </div>
          <div style={{ fontFamily: DISPLAY, fontSize: 24, color: IVORY, lineHeight: 1.15, marginTop: 2 }}>
            {current.label.toUpperCase()}
          </div>
          <div style={{ display: "flex", gap: 16, marginTop: 8 }}>
            <Legend swatch={LIME} label="AVAIL" n={current.available} />
            <Legend swatch={GOLD} label="RES" n={current.reserved} />
            <Legend swatch={SAGE} label="CONTRACT" n={current.underContract} />
            {current.sold > 0 && <Legend swatch={IVORY} label="SOLD" n={current.sold} />}
          </div>
        </div>
      )}
      {overview && (
        <div
          style={{
            position: "absolute",
            left: 22,
            bottom: 34,
            background: "rgba(14,17,8,.92)",
            border: "1px solid rgba(244,241,228,.18)",
            borderRadius: 6,
            padding: "10px 18px",
          }}
        >
          <span style={{ fontSize: 9, letterSpacing: "0.42em", color: LIME, fontWeight: 700 }}>THE PORTFOLIO</span>
        </div>
      )}
    </section>
  );
}

function Rule() {
  return <div style={{ width: 1, background: "rgba(244,241,228,.16)", margin: "0 22px", flexShrink: 0 }} />;
}

function Period({ label, moves, prev, against }: { label: string; moves: number; prev: number; against: string }) {
  const delta = moves - prev;
  const up = delta >= 0;
  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 9, letterSpacing: "0.36em", fontWeight: 700, color: SAGE }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 5 }}>
        <span style={{ fontFamily: DISPLAY, fontSize: "clamp(26px, 3.8vh, 40px)", color: IVORY, lineHeight: 1, letterSpacing: "-0.02em" }}>
          {moves}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: up ? LIME : GOLD, whiteSpace: "nowrap" }}>
          {up ? "\u25b2" : "\u25bc"}{Math.abs(delta)}
        </span>
      </div>
      <div style={{ fontSize: 8, letterSpacing: "0.16em", color: "rgba(140,154,115,.6)", fontWeight: 600, marginTop: 4, whiteSpace: "nowrap" }}>
        UNIT MOVES · VS {against} {prev}
      </div>
    </div>
  );
}

function UnitRow({ unit, building, status }: { unit: string; building: string; status: Status }) {
  const tone = STATUS_TONE[status] ?? SAGE;
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "10px 0",
        borderBottom: "1px solid rgba(244,241,228,.08)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: DISPLAY, fontSize: 16, color: IVORY, lineHeight: 1.1, letterSpacing: "0.01em" }}>
          {unit}
        </div>
        <div
          style={{
            fontSize: 9,
            letterSpacing: "0.18em",
            color: SAGE,
            fontWeight: 600,
            marginTop: 2,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {building}
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: tone }} />
        <span style={{ fontSize: 8, letterSpacing: "0.2em", fontWeight: 700, color: tone, whiteSpace: "nowrap" }}>
          {status}
        </span>
      </div>
    </div>
  );
}

function Line({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, padding: "7px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: tone, flexShrink: 0 }} />
        <span style={{ fontSize: 10, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, whiteSpace: "nowrap" }}>
          {label}
        </span>
      </div>
      <span style={{ fontFamily: DISPLAY, fontSize: "clamp(26px, 4vh, 42px)", color: tone, lineHeight: 1, letterSpacing: "-0.02em" }}>
        {value}
      </span>
    </div>
  );
}

function Legend({ swatch, label, n }: { swatch: string; label: string; n: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 8, height: 8, borderRadius: 2, background: swatch }} />
      <span style={{ fontSize: 8, letterSpacing: "0.26em", fontWeight: 700, color: SAGE }}>{label}</span>
      <span style={{ fontFamily: DISPLAY, fontSize: 14, color: IVORY }}>{n}</span>
    </div>
  );
}
