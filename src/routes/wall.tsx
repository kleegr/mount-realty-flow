import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getWallData } from "@/lib/wall.functions";

/**
 * WALL MONITOR — pass 9.
 *
 * Owner's notes from pass 8, all addressed:
 *  - the map now bleeds EDGE TO EDGE (no border, no rounded box); the
 *    caption card moved to the top-left so nothing collides with Google's
 *    mandatory logo in the bottom corner
 *  - a third scene: the PROJECT TOUR — every project takes the full stage
 *    for a few seconds with its buildings and their live mixes
 *  - the middle column of the board scene is now RECENT CONTRACTS &
 *    CLOSINGS — real stage changes with how long ago they happened
 *  - when a NEW closing lands, the whole wall celebrates: a takeover
 *    overlay for ~10 seconds — "CONGRATULATIONS" + balloons. Add
 *    ?celebrate=1 to the URL to preview it.
 *
 * Scene clock: BOARD 36s → MAP 36s → PROJECT TOUR (4 projects × 9s) → repeat.
 * TEAM / GUESTS switch persists per device; GUESTS hides the leaderboard.
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
function ago(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}M AGO`;
  const h = Math.round(mins / 60);
  if (h < 24) return `${h}H AGO`;
  return `${Math.round(h / 24)}D AGO`;
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
type Move = WallData["recentMoves"][number];
type Proj = WallData["projects"][number];

/** BOARD 36s -> MAP 36s -> 4 project frames x 9s -> repeat */
const SCHEDULE: Array<{ scene: "board" | "map" | "proj"; dur: number }> = [
  { scene: "board", dur: 36_000 },
  { scene: "map", dur: 36_000 },
  { scene: "proj", dur: 9_000 },
  { scene: "proj", dur: 9_000 },
  { scene: "proj", dur: 9_000 },
  { scene: "proj", dur: 9_000 },
];

function WallMonitor() {
  const wallFn = useServerFn(getWallData);
  const { data } = useQuery({ queryKey: ["wall-data"], queryFn: () => wallFn(), refetchInterval: 120_000 });

  const [now, setNow] = useState(() => new Date());
  const [step, setStep] = useState(0);
  const [projStep, setProjStep] = useState(0);
  const [sayIdx, setSayIdx] = useState(0);
  const [railFlip, setRailFlip] = useState(0);
  const [celebrate, setCelebrate] = useState<Move | null>(null);
  const [mode, setMode] = useState<"team" | "guests">(() => {
    try {
      return localStorage.getItem("mr-wall-mode") === "guests" ? "guests" : "team";
    } catch {
      return "team";
    }
  });
  const hasLogo = useAsset("/mount-logo.svg");

  function switchMode(m: "team" | "guests") {
    setMode(m);
    try {
      localStorage.setItem("mr-wall-mode", m);
    } catch { /* fine */ }
  }

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setSayIdx((i) => (i + 1) % 3), 3000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setRailFlip((f) => f + 1), 13_000);
    return () => clearInterval(t);
  }, []);
  // the scene clock
  useEffect(() => {
    const cur = SCHEDULE[step % SCHEDULE.length];
    const t = setTimeout(() => {
      if (cur.scene === "proj") setProjStep((p) => p + 1);
      setStep((s) => (s + 1) % SCHEDULE.length);
    }, cur.dur);
    return () => clearTimeout(t);
  }, [step]);

  // ---- celebration: a NEW closing takes over the wall
  useEffect(() => {
    if (!data) return;
    try {
      const test = new URLSearchParams(window.location.search).get("celebrate");
      const sold = data.recentMoves.filter((m) => m.status === "SOLD");
      const key = "mr-wall-last-close";
      const last = localStorage.getItem(key);
      if (test && !last?.startsWith("test")) {
        localStorage.setItem(key, "test");
        setCelebrate(sold[0] ?? { id: "t", at: new Date().toISOString(), status: "SOLD", unit: "UNIT 301", building: "GROVEVIEW C3", project: "GROVEVIEW" });
        setTimeout(() => setCelebrate(null), 11_000);
        return;
      }
      if (sold.length === 0) return;
      const newest = sold[0];
      if (last === null) {
        localStorage.setItem(key, newest.at); // first boot: don't celebrate history
        return;
      }
      if (!last.startsWith("test") && newest.at > last) {
        localStorage.setItem(key, newest.at);
        setCelebrate(newest);
        setTimeout(() => setCelebrate(null), 11_000);
      }
    } catch { /* fine */ }
  }, [data]);

  const totals = data?.totals ?? { available: 0, reserved: 0, underContract: 0, sold: 0 };
  const TOTAL = data?.totalUnits ?? 0;
  const projects = data?.projects ?? [];
  const scene = SCHEDULE[step % SCHEDULE.length].scene;
  const proj = projects.length > 0 ? projects[projStep % projects.length] : null;
  const spotlight = projects.length > 0 ? projects[railFlip % projects.length] : null;
  const saying = SAYINGS[(now.getHours() % SET_COUNT) * 3 + sayIdx];
  const moves = data?.recentMoves ?? [];
  const ticker = data?.ticker ?? [];
  const leaderboard = mode === "team" ? (data?.leaderboard ?? []) : [];
  const showLeaderboard = leaderboard.length > 0 && railFlip % 2 === 1;

  return (
    <div
      style={{
        height: "100vh",
        background: `radial-gradient(120% 90% at 84% 26%, rgba(201,169,97,.18) 0%, rgba(34,43,21,0) 58%), linear-gradient(180deg, ${OLIVE} 0%, ${INK} 100%)`,
        color: IVORY,
        fontFamily: BODY,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
        position: "relative",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&display=swap');
        @keyframes wTick { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        @keyframes wIn { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
        @keyframes wSay { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
        @keyframes wDot { 0%,100% { opacity: 1 } 50% { opacity: .18 } }
        @keyframes wBalloon { from { transform: translateY(110vh) rotate(-4deg) } to { transform: translateY(-130vh) rotate(5deg) } }
        @keyframes wPop { 0% { opacity: 0; transform: scale(.7) } 12% { opacity: 1; transform: scale(1.04) } 18% { transform: scale(1) } 88% { opacity: 1 } 100% { opacity: 0; transform: scale(.98) } }
        .grow { transition: width 1.1s cubic-bezier(.22,1,.36,1) }
      `}</style>

      {/* ---------------- masthead ---------------- */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 56px", height: 74, flexShrink: 0, position: "relative", zIndex: 5 }}>
        {hasLogo ? (
          <img src="/mount-logo.svg" alt="Mount Realty Group" style={{ height: 32 }} />
        ) : (
          <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
            <span style={{ fontFamily: DISPLAY, fontSize: 32, letterSpacing: "-0.02em", color: IVORY, lineHeight: 1 }}>MOUNT</span>
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
          <span style={{ width: 1, height: 16, background: "rgba(244,241,228,.22)", margin: "0 5px" }} />
          <div style={{ display: "flex", border: "1px solid rgba(244,241,228,.25)", borderRadius: 999, overflow: "hidden" }}>
            {(["team", "guests"] as const).map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                style={{
                  fontSize: 8, letterSpacing: "0.3em", fontWeight: 700, padding: "4px 10px", border: "none", cursor: "pointer",
                  background: mode === m ? LIME : "transparent", color: mode === m ? ON_LIME : SAGE,
                }}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* ---------------- body ---------------- */}
      {scene === "map" ? (
        /* FULL-BLEED map: edge to edge, no border, no box. */
        <WallMap buildings={data?.mapBuildings ?? []} />
      ) : scene === "proj" && proj ? (
        <ProjectTour proj={proj} />
      ) : (
        <main style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1.28fr 0.9fr 1fr", gap: 40, padding: "0 56px 14px" }}>
          {/* --- the figure --- */}
          <section style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", animation: "wIn .6s both" }}>
            <div style={{ fontSize: 11, letterSpacing: "0.52em", fontWeight: 700, color: LIME }}>AVAILABLE NOW</div>
            <div style={{ fontSize: 10, letterSpacing: "0.34em", fontWeight: 600, color: SAGE, marginTop: 5 }}>
              BLOOMING GROVE · KIRYAS YOEL
            </div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 24, paddingTop: 22 }}>
              <span style={{ fontFamily: DISPLAY, fontSize: "clamp(96px, 20vh, 216px)", lineHeight: 0.74, letterSpacing: "-0.045em", color: IVORY }}>
                {totals.available}
              </span>
              <div style={{ paddingTop: 4 }}>
                <div style={{ fontFamily: DISPLAY, fontSize: 27, color: LIME, lineHeight: 1 }}>{TOTAL}</div>
                <div style={{ fontSize: 9, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, marginTop: 4 }}>TOTAL UNITS</div>
                <div style={{ width: 28, height: 1, background: "rgba(244,241,228,.28)", margin: "11px 0" }} />
                <div style={{ fontFamily: DISPLAY, fontSize: 27, color: IVORY, lineHeight: 1 }}>
                  {TOTAL > 0 ? Math.round((totals.available / TOTAL) * 100) : 0}%
                </div>
                <div style={{ fontSize: 9, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, marginTop: 4 }}>OF PORTFOLIO</div>
              </div>
            </div>
            <div style={{ display: "flex", height: 6, marginTop: 20, borderRadius: 999, overflow: "hidden", background: "rgba(244,241,228,.14)" }}>
              <div className="grow" style={{ width: `${TOTAL ? (totals.available / TOTAL) * 100 : 0}%`, background: LIME }} />
              <div className="grow" style={{ width: `${TOTAL ? (totals.reserved / TOTAL) * 100 : 0}%`, background: GOLD }} />
              <div className="grow" style={{ width: `${TOTAL ? (totals.underContract / TOTAL) * 100 : 0}%`, background: SAGE }} />
              <div className="grow" style={{ width: `${TOTAL ? (totals.sold / TOTAL) * 100 : 0}%`, background: IVORY }} />
            </div>
            <div style={{ display: "flex", alignItems: "stretch", marginTop: 22, paddingTop: 16, borderTop: "1px solid rgba(244,241,228,.16)" }}>
              <Period label="TODAY" moves={data?.activity.today.moves ?? 0} prev={data?.activity.today.prev ?? 0} against="YESTERDAY" />
              <Rule />
              <Period label="THIS WEEK" moves={data?.activity.week.moves ?? 0} prev={data?.activity.week.prev ?? 0} against="LAST WEEK" />
              <Rule />
              <Period label="THIS MONTH" moves={data?.activity.month.moves ?? 0} prev={data?.activity.month.prev ?? 0} against="LAST MONTH" />
            </div>
          </section>

          {/* --- recent contracts & closings --- */}
          <section style={{ minWidth: 0, display: "flex", flexDirection: "column", borderLeft: "1px solid rgba(244,241,228,.16)", borderRight: "1px solid rgba(244,241,228,.16)", padding: "20px 28px 0", minHeight: 0 }}>
            <div style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE, flexShrink: 0 }}>
              RECENT CONTRACTS & CLOSINGS
            </div>
            <div style={{ flex: 1, overflow: "hidden", marginTop: 8, minHeight: 0 }}>
              {(moves.length > 0 ? moves.slice(0, 9) : []).map((m, i) => (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 0", borderBottom: "1px solid rgba(244,241,228,.08)", animation: `wIn .5s ${i * 0.05}s both` }}>
                  <span style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_TONE[m.status], flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: DISPLAY, fontSize: 15, color: IVORY, lineHeight: 1.1 }}>
                      {m.building} · {m.unit}
                    </div>
                    <div style={{ fontSize: 8, letterSpacing: "0.22em", color: STATUS_TONE[m.status], fontWeight: 700, marginTop: 2 }}>
                      {m.status}
                    </div>
                  </div>
                  <span style={{ fontSize: 8, letterSpacing: "0.18em", color: "rgba(140,154,115,.7)", fontWeight: 700, whiteSpace: "nowrap" }}>
                    {ago(m.at)}
                  </span>
                </div>
              ))}
              {moves.length === 0 && (
                <div style={{ fontSize: 11, color: SAGE, marginTop: 16, letterSpacing: "0.1em" }}>Movement will appear here as deals change stage.</div>
              )}
            </div>
          </section>

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
                    <div key={l.name} style={{ display: "flex", alignItems: "baseline", gap: 12, padding: "5px 0", borderBottom: "1px solid rgba(244,241,228,.08)" }}>
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
            ) : spotlight ? (
              <div key={`spot-${railFlip}`} style={{ animation: "wIn .6s both" }}>
                <div style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE }}>SPOTLIGHT</div>
                <div style={{ marginTop: 11 }}>
                  <div style={{ display: "inline-flex", flexDirection: "column", background: INK, padding: "7px 15px", borderRadius: 4 }}>
                    <span style={{ fontSize: 8, letterSpacing: "0.38em", color: SAGE, fontWeight: 700 }}>PROJECT</span>
                    <span style={{ fontFamily: DISPLAY, fontSize: 22, color: IVORY, lineHeight: 1.15 }}>{spotlight.name}</span>
                  </div>
                  <MixBar available={spotlight.available} reserved={spotlight.reserved} underContract={spotlight.underContract} sold={spotlight.sold} total={spotlight.total} style={{ marginTop: 11 }} />
                  <div style={{ display: "flex", gap: 15, marginTop: 9 }}>
                    <Legend swatch={LIME} label="AVAIL" n={spotlight.available} />
                    <Legend swatch={GOLD} label="RES" n={spotlight.reserved} />
                    <Legend swatch={SAGE} label="CONTRACT" n={spotlight.underContract} />
                  </div>
                </div>
              </div>
            ) : null}
          </section>
        </main>
      )}

      {/* ---------------- live activity ticker ---------------- */}
      <div style={{ overflow: "hidden", padding: "9px 0", flexShrink: 0, borderTop: "1px solid rgba(244,241,228,.12)", position: "relative", zIndex: 5, background: scene === "map" ? "rgba(14,17,8,.85)" : "transparent" }}>
        <div style={{ display: "flex", width: "max-content", animation: "wTick 48s linear infinite" }}>
          {[0, 1].map((dup) => (
            <div key={dup} style={{ display: "flex" }}>
              {(ticker.length > 0 ? ticker : ["MOUNT REALTY · LIVE INVENTORY"]).map((t, i) => (
                <span key={`${dup}-${i}`} style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.24em", color: SAGE, padding: "0 38px", whiteSpace: "nowrap" }}>
                  {t}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- chartreuse banner ---------------- */}
      <footer style={{ background: LIME, flexShrink: 0, display: "flex", alignItems: "center", gap: 26, padding: "16px 56px", minHeight: 68, position: "relative", zIndex: 5 }}>
        <span style={{ fontSize: 9, letterSpacing: "0.46em", fontWeight: 700, color: ON_LIME, whiteSpace: "nowrap" }}>THIS HOUR</span>
        <div style={{ display: "flex", gap: 4, flexShrink: 0 }}>
          {[0, 1, 2].map((i) => (
            <span key={i} style={{ width: i === sayIdx ? 14 : 5, height: 3, borderRadius: 999, background: i === sayIdx ? INK : "rgba(46,54,11,.32)", transition: "width .4s" }} />
          ))}
        </div>
        <span style={{ width: 1, height: 24, background: "rgba(46,54,11,.30)", flexShrink: 0 }} />
        <span key={saying} style={{ fontFamily: DISPLAY, fontSize: "clamp(19px, 2.9vh, 31px)", color: INK, letterSpacing: "0.01em", lineHeight: 1.1, animation: "wSay .45s both" }}>
          {saying}
        </span>
      </footer>

      {/* ---------------- THE CELEBRATION ---------------- */}
      {celebrate && <Celebration move={celebrate} />}
    </div>
  );
}

function MixBar({ available, reserved, underContract, sold, total, style }: { available: number; reserved: number; underContract: number; sold: number; total: number; style?: React.CSSProperties }) {
  if (total === 0) return null;
  return (
    <div style={{ display: "flex", height: 6, borderRadius: 999, overflow: "hidden", background: "rgba(244,241,228,.14)", ...style }}>
      <div className="grow" style={{ width: `${(available / total) * 100}%`, background: LIME }} />
      <div className="grow" style={{ width: `${(reserved / total) * 100}%`, background: GOLD }} />
      <div className="grow" style={{ width: `${(underContract / total) * 100}%`, background: SAGE }} />
      <div className="grow" style={{ width: `${(sold / total) * 100}%`, background: IVORY }} />
    </div>
  );
}

/** Every project takes the stage: name huge on the left, buildings live on the right. */
function ProjectTour({ proj }: { proj: Proj }) {
  const cols = proj.buildings.length > 8 ? 2 : 1;
  return (
    <main key={proj.id + proj.name} style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1fr 1.35fr", gap: 48, padding: "0 56px 14px", animation: "wIn .6s both" }}>
      <section style={{ display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.5em", fontWeight: 700, color: GOLD }}>PROJECT TOUR</div>
        <div style={{ fontFamily: DISPLAY, fontSize: "clamp(48px, 9.5vh, 104px)", lineHeight: 0.94, letterSpacing: "-0.02em", color: IVORY, marginTop: 14, overflowWrap: "anywhere" }}>
          {proj.name}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 26, marginTop: 22 }}>
          <div>
            <span style={{ fontFamily: DISPLAY, fontSize: "clamp(40px, 7vh, 72px)", color: LIME, lineHeight: 1 }}>{proj.available}</span>
            <div style={{ fontSize: 9, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, marginTop: 4 }}>AVAILABLE</div>
          </div>
          <div>
            <span style={{ fontFamily: DISPLAY, fontSize: "clamp(26px, 4.4vh, 44px)", color: SAGE, lineHeight: 1 }}>{proj.underContract}</span>
            <div style={{ fontSize: 9, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, marginTop: 4 }}>IN CONTRACT</div>
          </div>
          <div>
            <span style={{ fontFamily: DISPLAY, fontSize: "clamp(26px, 4.4vh, 44px)", color: IVORY, lineHeight: 1 }}>{proj.total}</span>
            <div style={{ fontSize: 9, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, marginTop: 4 }}>TOTAL UNITS</div>
          </div>
        </div>
        <MixBar available={proj.available} reserved={proj.reserved} underContract={proj.underContract} sold={proj.sold} total={proj.total} style={{ marginTop: 22 }} />
      </section>
      <section style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", borderLeft: "1px solid rgba(244,241,228,.16)", paddingLeft: 44 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE }}>THE BUILDINGS</div>
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: cols === 2 ? "1fr 1fr" : "1fr", columnGap: 36, rowGap: 0, maxHeight: "62vh", overflow: "hidden" }}>
          {proj.buildings.slice(0, 16).map((b, i) => (
            <div key={b.label} style={{ padding: "9px 0", borderBottom: "1px solid rgba(244,241,228,.08)", animation: `wIn .5s ${i * 0.04}s both`, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <span style={{ fontFamily: DISPLAY, fontSize: 15, color: IVORY, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.label}</span>
                <span style={{ fontSize: 10, fontWeight: 700, color: b.available > 0 ? LIME : SAGE, whiteSpace: "nowrap" }}>
                  {b.available > 0 ? `${b.available} AVAIL` : b.underContract > 0 ? "IN CONTRACT" : b.sold === b.total ? "SOLD OUT" : "\u2014"}
                </span>
              </div>
              <MixBar available={b.available} reserved={b.reserved} underContract={b.underContract} sold={b.sold} total={b.total} style={{ marginTop: 6, height: 4 }} />
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}

/** FULL-BLEED map scene: no borders, no boxes; the map IS the wall. */
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
          label: b.available > 0 ? { text: String(b.available), color: "#0E1108", fontSize: "11px", fontWeight: "700" } : undefined,
        });
        markersRef.current.push(marker);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildings]);

  useEffect(() => {
    const t = setInterval(() => setTourIdx((i) => i + 1), 6500);
    return () => clearInterval(t);
  }, []);

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
    <main style={{ flex: 1, minHeight: 0, position: "relative", animation: "wIn .6s both" }}>
      <div ref={mapEl} style={{ position: "absolute", inset: 0 }} />
      {/* soft cinema vignette so the masthead and ticker sit ON the map */}
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "linear-gradient(180deg, rgba(14,17,8,.55) 0%, rgba(14,17,8,0) 14%, rgba(14,17,8,0) 84%, rgba(14,17,8,.55) 100%)" }} />
      {current && !overview && (
        <div key={tourIdx} style={{ position: "absolute", left: 56, top: 26, background: "rgba(14,17,8,.9)", borderLeft: `3px solid ${LIME}`, padding: "14px 22px", animation: "wIn .5s both", maxWidth: 420 }}>
          <div style={{ fontSize: 8, letterSpacing: "0.38em", color: SAGE, fontWeight: 700 }}>{current.project.toUpperCase()}</div>
          <div style={{ fontFamily: DISPLAY, fontSize: 26, color: IVORY, lineHeight: 1.12, marginTop: 2 }}>{current.label.toUpperCase()}</div>
          <div style={{ display: "flex", gap: 16, marginTop: 9 }}>
            <Legend swatch={LIME} label="AVAIL" n={current.available} />
            <Legend swatch={GOLD} label="RES" n={current.reserved} />
            <Legend swatch={SAGE} label="CONTRACT" n={current.underContract} />
            {current.sold > 0 && <Legend swatch={IVORY} label="SOLD" n={current.sold} />}
          </div>
        </div>
      )}
      {overview && (
        <div style={{ position: "absolute", left: 56, top: 26, background: "rgba(14,17,8,.9)", borderLeft: `3px solid ${LIME}`, padding: "10px 22px" }}>
          <span style={{ fontSize: 9, letterSpacing: "0.42em", color: LIME, fontWeight: 700 }}>THE PORTFOLIO</span>
        </div>
      )}
    </main>
  );
}

const BALLOONS = ["#C6D92E", "#C9A961", "#F4F1E4", "#8C9A73", "#e8734a", "#7fb3d5"];

function Celebration({ move }: { move: { unit: string; building: string } }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(14,17,8,.93)", display: "flex", alignItems: "center", justifyContent: "center", animation: "wPop 11s both", overflow: "hidden" }}>
      {/* balloons */}
      {Array.from({ length: 22 }).map((_, i) => {
        const c = BALLOONS[i % BALLOONS.length];
        const left = (i * 137) % 100;
        const dur = 7 + ((i * 53) % 50) / 10;
        const delay = ((i * 77) % 40) / 10;
        const size = 34 + ((i * 31) % 30);
        return (
          <div key={i} style={{ position: "absolute", left: `${left}%`, bottom: 0, animation: `wBalloon ${dur}s linear ${delay}s infinite` }}>
            <div style={{ width: size, height: size * 1.2, borderRadius: "50% 50% 48% 48%", background: c, opacity: 0.92, boxShadow: "inset -6px -8px 0 rgba(0,0,0,.12)" }} />
            <div style={{ width: 1, height: 46, background: "rgba(244,241,228,.4)", margin: "0 auto" }} />
          </div>
        );
      })}
      <div style={{ textAlign: "center", position: "relative" }}>
        <div style={{ fontSize: 13, letterSpacing: "0.6em", fontWeight: 700, color: GOLD }}>ANOTHER ONE CLOSED</div>
        <div style={{ fontFamily: DISPLAY, fontSize: "clamp(64px, 13vh, 148px)", lineHeight: 0.95, color: LIME, letterSpacing: "-0.02em", marginTop: 14 }}>
          CONGRATULATIONS
        </div>
        <div style={{ fontFamily: DISPLAY, fontSize: "clamp(26px, 4.6vh, 48px)", color: IVORY, marginTop: 10 }}>
          MOUNT REALTY
        </div>
        <div style={{ fontSize: 14, letterSpacing: "0.3em", fontWeight: 700, color: SAGE, marginTop: 16 }}>
          {move.building} · {move.unit} — SOLD
        </div>
      </div>
    </div>
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
