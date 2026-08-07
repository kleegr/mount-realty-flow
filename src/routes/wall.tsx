import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { supabase } from "@/integrations/supabase/client";
import { getWallData } from "@/lib/wall.functions";
import { WALL_BG1 } from "@/lib/wall-bg1";
import { WALL_BG2 } from "@/lib/wall-bg2";
import { WALL_BG3 } from "@/lib/wall-bg3";

/**
 * WALL MONITOR — pass 13 (owner notes on pass 12):
 *  1. Leaderboard agents are now ALWAYS on screen. The right rail shows the
 *     board leaders at all times; the project spotlight moved beneath it and
 *     rotates there, so the two no longer trade places. Agents never vanish.
 *  2. Top ribbon recolored to the SAGE/olive green (the 'under contract'
 *     tone) instead of lime, so the header reads as the darker green while
 *     the footer stays chartreuse. Logo/type kept ivory for contrast.
 *
 * Scene clock: BOARD 36s → MAP 36s → PROJECT TOUR (4 × 9s) → repeat.
 * TEAM / GUESTS switch persists per device; ?celebrate=1 previews balloons.
 */

export const Route = createFileRoute("/wall")({
  ssr: false,
  beforeLoad: async () => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) throw redirect({ to: "/auth" });
  },
  component: WallMonitor,
});

// -------- the poster palette
const BG = "#F0EDE2";
const INK = "#15150D";
const MUTE = "#787668";
const FAINT = "rgba(21,21,13,.14)";
const LIME = "#C4D62E";
const GOLD = "#C9A961";
const SAGE = "#7B8A5E";
const IVORY = "#F4F1E4";
const DISPLAY = "'Anton','Arial Narrow',Impact,sans-serif";
const BODY = "'Archivo',Inter,system-ui,sans-serif";

type Status = "AVAILABLE" | "RESERVED" | "UNDER CONTRACT" | "SOLD";
const STATUS_TONE: Record<Status, string> = {
  AVAILABLE: LIME,
  RESERVED: GOLD,
  "UNDER CONTRACT": SAGE,
  SOLD: INK,
};

/** The exact wordmark, cut from the poster art. */
const LOGO =
  "data:image/png;base64,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";

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

const GKEY = (import.meta.env.VITE_GOOGLE_MAPS_KEY as string | undefined) || "AIzaSyBjnAKmoD8mmxO3xhNImshrDqzH2yg423k";
const AREA_CENTER = { lat: 41.36, lng: -74.17 };
/** Light map tuned to the ivory ground. */
const MAP_STYLE = [
  { elementType: "geometry", stylers: [{ color: "#e9e6d9" }] },
  { elementType: "labels.text.fill", stylers: [{ color: "#8a8876" }] },
  { elementType: "labels.text.stroke", stylers: [{ color: "#f4f1e4" }] },
  { featureType: "poi", stylers: [{ visibility: "off" }] },
  { featureType: "transit", stylers: [{ visibility: "off" }] },
  { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
  { featureType: "road", elementType: "labels.text.fill", stylers: [{ color: "#9b997f" }] },
  { featureType: "water", elementType: "geometry", stylers: [{ color: "#c9d6cd" }] },
  { featureType: "landscape.natural", elementType: "geometry", stylers: [{ color: "#e3e2d0" }] },
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

const SCHEDULE: Array<{ scene: "board" | "map" | "proj"; dur: number }> = [
  { scene: "board", dur: 36_000 },
  { scene: "map", dur: 36_000 },
  { scene: "proj", dur: 9_000 },
  { scene: "proj", dur: 9_000 },
  { scene: "proj", dur: 9_000 },
  { scene: "proj", dur: 9_000 },
];

/** Faint rotating house scenes behind the board (3 images / 5 minutes). */
function BgSlideshow() {
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => i + 1), 100_000);
    return () => clearInterval(t);
  }, []);
  const imgs = [WALL_BG1, WALL_BG2, WALL_BG3];
  return (
    <div aria-hidden style={{ position: "absolute", inset: 0, zIndex: 0, overflow: "hidden", pointerEvents: "none" }}>
      {imgs.map((src, i) => (
        <BgImg key={i} n={i + 1} fallback={src} active={i === idx % imgs.length} />
      ))}
    </div>
  );
}

/** Prefers /public/wall-bg-N.jpg when present; falls back to the built-in poster crop. */
function BgImg({ n, fallback, active }: { n: number; fallback: string; active: boolean }) {
  const [src, setSrc] = useState(`/wall-bg-${n}.jpg`);
  return (
    <img
      src={src}
      alt=""
      onError={() => {
        if (src !== fallback) setSrc(fallback);
      }}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        objectFit: "cover",
        opacity: active ? 0.13 : 0,
        transition: "opacity 3s ease",
        animation: active ? "wKen 100s ease-in-out infinite alternate" : "none",
        willChange: "transform, opacity",
      }}
    />
  );
}

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
  // One saying every 20 seconds, cycling the whole list.
  useEffect(() => {
    const t = setInterval(() => setSayIdx((i) => i + 1), 20_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const t = setInterval(() => setRailFlip((f) => f + 1), 13_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    const cur = SCHEDULE[step % SCHEDULE.length];
    const t = setTimeout(() => {
      if (cur.scene === "proj") setProjStep((p) => p + 1);
      setStep((s) => (s + 1) % SCHEDULE.length);
    }, cur.dur);
    return () => clearTimeout(t);
  }, [step]);

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
        localStorage.setItem(key, newest.at);
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
  const saying = SAYINGS[sayIdx % SAYINGS.length];
  const moves = data?.recentMoves ?? [];
  const ticker = data?.ticker ?? [];
  const leaderboard = mode === "team" ? (data?.leaderboard ?? []) : [];
  const hasLeaderboard = leaderboard.length > 0;

  return (
    <div style={{ height: "100vh", background: BG, color: INK, fontFamily: BODY, display: "flex", flexDirection: "column", overflow: "hidden", position: "relative" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&display=swap');
        @keyframes wTick { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        @keyframes wIn { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
        @keyframes wSay { from { opacity: 0; transform: translateY(6px) } to { opacity: 1; transform: none } }
        @keyframes wDot { 0%,100% { opacity: 1 } 50% { opacity: .18 } }
        @keyframes wKen { from { transform: scale(1.08) translate(-1.2%, -0.8%) } to { transform: scale(1.16) translate(1.2%, 0.8%) } }
        @keyframes wBalloon { from { transform: translateY(110vh) rotate(-4deg) } to { transform: translateY(-130vh) rotate(5deg) } }
        @keyframes wPop { 0% { opacity: 0; transform: scale(.7) } 12% { opacity: 1; transform: scale(1.04) } 18% { transform: scale(1) } 88% { opacity: 1 } 100% { opacity: 0; transform: scale(.98) } }
        .grow { transition: width 1.1s cubic-bezier(.22,1,.36,1) }
      `}</style>

      {/* faint rotating house scenes; the full-bleed map covers its own ground */}
      {scene !== "map" && <BgSlideshow />}

      {/* ---------------- masthead: sage/olive-green ribbon (darker green up top) ---------------- */}
      <header style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0 56px", height: 80, flexShrink: 0, position: "relative", zIndex: 5, background: SAGE }}>
        <img src={LOGO} alt="Mount Realty Group" style={{ height: 42 }} />
        <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: IVORY, animation: "wDot 2s infinite" }} />
          <span style={{ fontSize: 11, letterSpacing: "0.42em", fontWeight: 700, color: IVORY }}>LIVE INVENTORY</span>
          <span style={{ width: 1, height: 16, background: "rgba(244,241,228,.4)", margin: "0 5px" }} />
          <span style={{ fontSize: 12, letterSpacing: "0.18em", color: "rgba(244,241,228,.85)", fontWeight: 600 }}>
            {now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }).toUpperCase()}
            {"   "}
            {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </span>
          <span style={{ width: 1, height: 16, background: "rgba(244,241,228,.4)", margin: "0 5px" }} />
          <div style={{ display: "flex", border: `1.5px solid ${IVORY}`, borderRadius: 999, overflow: "hidden" }}>
            {(["team", "guests"] as const).map((m) => (
              <button
                key={m}
                onClick={() => switchMode(m)}
                style={{ fontSize: 9, letterSpacing: "0.3em", fontWeight: 700, padding: "5px 12px", border: "none", cursor: "pointer", background: mode === m ? IVORY : "transparent", color: mode === m ? INK : IVORY }}
              >
                {m.toUpperCase()}
              </button>
            ))}
          </div>
        </div>
      </header>

      {/* ---------------- body ---------------- */}
      {scene === "map" ? (
        <WallMap buildings={data?.mapBuildings ?? []} />
      ) : scene === "proj" && proj ? (
        <ProjectTour proj={proj} />
      ) : (
        <main style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1.28fr 0.9fr 1fr", gap: 40, padding: "0 56px 14px", position: "relative", zIndex: 1 }}>
          {/* --- the figure --- */}
          <section style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", animation: "wIn .6s both" }}>
            <span style={{ alignSelf: "flex-start", background: INK, color: LIME, borderRadius: 999, padding: "6px 17px", fontSize: 11, letterSpacing: "0.5em", fontWeight: 700 }}>
              AVAILABLE NOW
            </span>
            <div style={{ fontSize: 11, letterSpacing: "0.34em", fontWeight: 600, color: MUTE, marginTop: 10 }}>
              BLOOMING GROVE · KIRYAS YOEL
            </div>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 24, paddingTop: 20 }}>
              <span style={{ fontFamily: DISPLAY, fontSize: "clamp(96px, 20vh, 216px)", lineHeight: 0.74, letterSpacing: "-0.045em", color: INK }}>
                {totals.available}
              </span>
              <div style={{ paddingTop: 4 }}>
                <div style={{ fontFamily: DISPLAY, fontSize: 30, color: INK, lineHeight: 1 }}>{TOTAL}</div>
                <div style={{ fontSize: 10, letterSpacing: "0.3em", fontWeight: 700, color: MUTE, marginTop: 4 }}>TOTAL UNITS</div>
                <div style={{ width: 28, height: 2, background: LIME, margin: "11px 0" }} />
                <div style={{ fontFamily: DISPLAY, fontSize: 30, color: INK, lineHeight: 1 }}>
                  {TOTAL > 0 ? Math.round((totals.available / TOTAL) * 100) : 0}%
                </div>
                <div style={{ fontSize: 10, letterSpacing: "0.3em", fontWeight: 700, color: MUTE, marginTop: 4 }}>OF PORTFOLIO</div>
              </div>
            </div>
            <MixBar available={totals.available} reserved={totals.reserved} underContract={totals.underContract} sold={totals.sold} total={TOTAL} style={{ marginTop: 20 }} />
            <div style={{ display: "flex", alignItems: "stretch", marginTop: 22, paddingTop: 16, borderTop: `1px solid ${FAINT}` }}>
              <Period label="TODAY" moves={data?.activity.today.moves ?? 0} prev={data?.activity.today.prev ?? 0} against="YESTERDAY" />
              <Rule />
              <Period label="THIS WEEK" moves={data?.activity.week.moves ?? 0} prev={data?.activity.week.prev ?? 0} against="LAST WEEK" />
              <Rule />
              <Period label="THIS MONTH" moves={data?.activity.month.moves ?? 0} prev={data?.activity.month.prev ?? 0} against="LAST MONTH" />
            </div>
          </section>

          {/* --- recent contracts & closings --- */}
          <section style={{ minWidth: 0, display: "flex", flexDirection: "column", borderLeft: `1px solid ${FAINT}`, borderRight: `1px solid ${FAINT}`, padding: "20px 28px 0", minHeight: 0 }}>
            <div style={{ fontSize: 10, letterSpacing: "0.4em", fontWeight: 700, color: MUTE, flexShrink: 0 }}>
              RECENT CONTRACTS & CLOSINGS
            </div>
            <div style={{ flex: 1, overflow: "hidden", marginTop: 8, minHeight: 0 }}>
              {(moves.length > 0 ? moves.slice(0, 9) : []).map((m, i) => (
                <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "12px 0", borderBottom: `1px solid ${FAINT}`, animation: `wIn .5s ${i * 0.05}s both` }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: STATUS_TONE[m.status], border: `1.5px solid ${INK}`, flexShrink: 0 }} />
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontFamily: DISPLAY, fontSize: 17, color: INK, lineHeight: 1.12 }}>
                      {m.building} · {m.unit}
                    </div>
                    <div style={{ fontSize: 10, letterSpacing: "0.22em", color: MUTE, fontWeight: 700, marginTop: 2 }}>
                      {m.status}
                    </div>
                  </div>
                  <span style={{ fontSize: 10, letterSpacing: "0.16em", color: MUTE, fontWeight: 700, whiteSpace: "nowrap" }}>
                    {ago(m.at)}
                  </span>
                </div>
              ))}
              {moves.length === 0 && (
                <div style={{ fontSize: 13, color: MUTE, marginTop: 16, letterSpacing: "0.08em" }}>Movement will appear here as deals change stage.</div>
              )}
            </div>
          </section>

          {/* --- the rail: leaderboard is ALWAYS on; spotlight rotates below it --- */}
          <section style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <Line label="RESERVED" value={totals.reserved} tone={GOLD} />
            <Line label="UNDER CONTRACT" value={totals.underContract} tone={SAGE} />
            <Line label="SOLD" value={totals.sold} tone={INK} />
            <div style={{ height: 1, background: FAINT, margin: "16px 0" }} />
            <div style={{ fontSize: 10, letterSpacing: "0.4em", fontWeight: 700, color: MUTE }}>CONTRACTED VOLUME</div>
            <div style={{ fontFamily: DISPLAY, fontSize: "clamp(34px, 5vh, 56px)", color: INK, lineHeight: 0.95, letterSpacing: "-0.02em", marginTop: 5 }}>
              {money(data?.contractedVolume ?? 0)}
            </div>
            <div style={{ height: 1, background: FAINT, margin: "16px 0" }} />

            {hasLeaderboard ? (
              <>
                <div style={{ fontSize: 10, letterSpacing: "0.4em", fontWeight: 700, color: MUTE }}>THE BOARD LEADERS</div>
                <div style={{ marginTop: 12 }}>
                  {leaderboard.map((l, i) => (
                    <div key={l.name} style={{ display: "flex", alignItems: "baseline", gap: 13, padding: "9px 0", borderBottom: `1px solid ${FAINT}` }}>
                      <span style={{ fontFamily: DISPLAY, fontSize: 24, color: i === 0 ? INK : MUTE, width: 26 }}>{i + 1}</span>
                      <span style={{ fontFamily: DISPLAY, fontSize: "clamp(22px, 3vh, 30px)", color: INK, flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", letterSpacing: "0.01em", lineHeight: 1.05 }}>
                        {l.name.toUpperCase()}
                      </span>
                      <span style={{ fontFamily: DISPLAY, fontSize: 26, color: INK, background: i === 0 ? LIME : "transparent", padding: i === 0 ? "0 9px" : 0, borderRadius: 4 }}>{l.contract}</span>
                      <span style={{ fontSize: 9, letterSpacing: "0.2em", color: MUTE, fontWeight: 700 }}>IN CONTRACT</span>
                    </div>
                  ))}
                </div>
                {spotlight && (
                  <div key={`spot-${railFlip}`} style={{ marginTop: 18, animation: "wIn .6s both" }}>
                    <div style={{ fontSize: 10, letterSpacing: "0.4em", fontWeight: 700, color: MUTE }}>SPOTLIGHT</div>
                    <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 16 }}>
                      <PillChip label="PROJECT" value={spotlight.name} />
                      <div style={{ display: "flex", gap: 15 }}>
                        <Legend swatch={LIME} label="AVAIL" n={spotlight.available} />
                        <Legend swatch={GOLD} label="RES" n={spotlight.reserved} />
                        <Legend swatch={SAGE} label="CONTRACT" n={spotlight.underContract} />
                      </div>
                    </div>
                  </div>
                )}
              </>
            ) : spotlight ? (
              <div key={`spot-${railFlip}`} style={{ animation: "wIn .6s both" }}>
                <div style={{ fontSize: 10, letterSpacing: "0.4em", fontWeight: 700, color: MUTE }}>SPOTLIGHT</div>
                <div style={{ marginTop: 11 }}>
                  <PillChip label="PROJECT" value={spotlight.name} />
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

      {/* ---------------- ticker: ink band, lime type (poster chip language) ---------------- */}
      <div style={{ overflow: "hidden", padding: "12px 0", flexShrink: 0, background: INK, position: "relative", zIndex: 5 }}>
        <div style={{ display: "flex", width: "max-content", animation: "wTick 48s linear infinite" }}>
          {[0, 1].map((dup) => (
            <div key={dup} style={{ display: "flex" }}>
              {(ticker.length > 0 ? ticker : ["MOUNT REALTY · LIVE INVENTORY"]).map((t, i) => (
                <span key={`${dup}-${i}`} style={{ fontSize: 13, fontWeight: 700, letterSpacing: "0.22em", color: LIME, padding: "0 40px", whiteSpace: "nowrap" }}>
                  {t}
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>

      {/* ---------------- chartreuse banner ---------------- */}
      <footer style={{ background: LIME, flexShrink: 0, display: "flex", alignItems: "center", gap: 26, padding: "16px 56px", minHeight: 70, position: "relative", zIndex: 5 }}>
        <span style={{ fontSize: 10, letterSpacing: "0.44em", fontWeight: 700, color: INK, whiteSpace: "nowrap" }}>THE MOUNT WAY</span>
        <span style={{ width: 1, height: 26, background: "rgba(21,21,13,.3)", flexShrink: 0 }} />
        <span key={saying} style={{ fontFamily: DISPLAY, fontSize: "clamp(22px, 3.3vh, 36px)", color: INK, letterSpacing: "0.01em", lineHeight: 1.1, animation: "wSay .45s both" }}>
          {saying}
        </span>
      </footer>

      {celebrate && <Celebration move={celebrate} />}
    </div>
  );
}

/** Poster motif: black pill with a tiny label and the value in white. */
function PillChip({ label, value }: { label: string; value: string }) {
  return (
    <span style={{ display: "inline-flex", flexDirection: "column", alignItems: "center", background: INK, borderRadius: 10, padding: "7px 20px 9px" }}>
      <span style={{ fontSize: 8, letterSpacing: "0.38em", color: "rgba(244,241,228,.75)", fontWeight: 700 }}>{label}</span>
      <span style={{ fontFamily: DISPLAY, fontSize: 22, color: IVORY, lineHeight: 1.15, whiteSpace: "nowrap" }}>{value}</span>
    </span>
  );
}

function MixBar({ available, reserved, underContract, sold, total, style }: { available: number; reserved: number; underContract: number; sold: number; total: number; style?: React.CSSProperties }) {
  if (total === 0) return null;
  return (
    <div style={{ display: "flex", height: 7, borderRadius: 999, overflow: "hidden", background: "rgba(21,21,13,.1)", ...style }}>
      <div className="grow" style={{ width: `${(available / total) * 100}%`, background: LIME }} />
      <div className="grow" style={{ width: `${(reserved / total) * 100}%`, background: GOLD }} />
      <div className="grow" style={{ width: `${(underContract / total) * 100}%`, background: SAGE }} />
      <div className="grow" style={{ width: `${(sold / total) * 100}%`, background: INK }} />
    </div>
  );
}

function ProjectTour({ proj }: { proj: Proj }) {
  const cols = proj.buildings.length > 8 ? 2 : 1;
  return (
    <main key={proj.id + proj.name} style={{ flex: 1, minHeight: 0, display: "grid", gridTemplateColumns: "1fr 1.35fr", gap: 48, padding: "0 56px 14px", animation: "wIn .6s both", position: "relative", zIndex: 1 }}>
      <section style={{ display: "flex", flexDirection: "column", justifyContent: "center", minWidth: 0 }}>
        <span style={{ alignSelf: "flex-start", background: INK, color: LIME, borderRadius: 999, padding: "6px 17px", fontSize: 11, letterSpacing: "0.5em", fontWeight: 700 }}>
          PROJECT TOUR
        </span>
        <div style={{ fontFamily: DISPLAY, fontSize: "clamp(48px, 9.5vh, 104px)", lineHeight: 0.94, letterSpacing: "-0.02em", color: INK, marginTop: 16, overflowWrap: "anywhere" }}>
          {proj.name}
        </div>
        <div style={{ display: "flex", alignItems: "baseline", gap: 26, marginTop: 22 }}>
          <div>
            <span style={{ fontFamily: DISPLAY, fontSize: "clamp(40px, 7vh, 72px)", color: INK, lineHeight: 1, background: LIME, padding: "0 14px", borderRadius: 8 }}>{proj.available}</span>
            <div style={{ fontSize: 10, letterSpacing: "0.3em", fontWeight: 700, color: MUTE, marginTop: 8 }}>AVAILABLE</div>
          </div>
          <div>
            <span style={{ fontFamily: DISPLAY, fontSize: "clamp(26px, 4.4vh, 44px)", color: INK, lineHeight: 1 }}>{proj.underContract}</span>
            <div style={{ fontSize: 10, letterSpacing: "0.3em", fontWeight: 700, color: MUTE, marginTop: 4 }}>IN CONTRACT</div>
          </div>
          <div>
            <span style={{ fontFamily: DISPLAY, fontSize: "clamp(26px, 4.4vh, 44px)", color: INK, lineHeight: 1 }}>{proj.total}</span>
            <div style={{ fontSize: 10, letterSpacing: "0.3em", fontWeight: 700, color: MUTE, marginTop: 4 }}>TOTAL UNITS</div>
          </div>
        </div>
        <MixBar available={proj.available} reserved={proj.reserved} underContract={proj.underContract} sold={proj.sold} total={proj.total} style={{ marginTop: 22 }} />
      </section>
      <section style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", borderLeft: `1px solid ${FAINT}`, paddingLeft: 44 }}>
        <div style={{ fontSize: 10, letterSpacing: "0.4em", fontWeight: 700, color: MUTE }}>THE BUILDINGS</div>
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: cols === 2 ? "1fr 1fr" : "1fr", columnGap: 36, rowGap: 0, maxHeight: "62vh", overflow: "hidden" }}>
          {proj.buildings.slice(0, 16).map((b, i) => (
            <div key={b.label} style={{ padding: "9px 0", borderBottom: `1px solid ${FAINT}`, animation: `wIn .5s ${i * 0.04}s both`, minWidth: 0 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <span style={{ fontFamily: DISPLAY, fontSize: 17, color: INK, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{b.label}</span>
                <span style={{ fontSize: 11, fontWeight: 700, color: b.available > 0 ? INK : MUTE, background: b.available > 0 ? LIME : "transparent", padding: b.available > 0 ? "1px 9px" : 0, borderRadius: 999, whiteSpace: "nowrap" }}>
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

/** FULL-BLEED light map; the caption card is BIG and now carries the address. */
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
          backgroundColor: "#e9e6d9",
        });
      }
      const map = mapRef.current;
      markersRef.current.forEach((m) => m.setMap(null));
      markersRef.current = [];
      for (const b of buildings) {
        const color = b.available > 0 ? LIME : b.reserved > 0 ? GOLD : b.underContract > 0 ? SAGE : "#a3a191";
        const marker = new g.maps.Marker({
          map,
          position: { lat: b.lat, lng: b.lng },
          icon: {
            path: g.maps.SymbolPath.CIRCLE,
            fillColor: color,
            fillOpacity: 1,
            strokeColor: INK,
            strokeWeight: 2.5,
            scale: Math.min(16, 9 + b.total * 0.35),
          },
          label: b.available > 0 ? { text: String(b.available), color: INK, fontSize: "12px", fontWeight: "700" } : undefined,
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
      <div style={{ position: "absolute", inset: 0, pointerEvents: "none", background: "linear-gradient(180deg, rgba(240,237,226,.7) 0%, rgba(240,237,226,0) 12%, rgba(240,237,226,0) 88%, rgba(240,237,226,.7) 100%)" }} />
      {current && !overview && (
        <div key={tourIdx} style={{ position: "absolute", left: 56, top: 30, background: INK, borderLeft: `6px solid ${LIME}`, padding: "22px 34px 24px", animation: "wIn .5s both", maxWidth: 600, borderRadius: 6 }}>
          <div style={{ fontSize: 12, letterSpacing: "0.4em", color: LIME, fontWeight: 700 }}>{current.project.toUpperCase()}</div>
          <div style={{ fontFamily: DISPLAY, fontSize: "clamp(30px, 4.6vh, 46px)", color: IVORY, lineHeight: 1.08, marginTop: 6 }}>{current.label.toUpperCase()}</div>
          {current.address && (
            <div style={{ fontSize: 14, letterSpacing: "0.06em", color: "rgba(244,241,228,.78)", fontWeight: 600, marginTop: 8 }}>
              {current.address.toUpperCase()}
            </div>
          )}
          <div style={{ display: "flex", gap: 24, marginTop: 16 }}>
            <BigLegend swatch={LIME} label="AVAILABLE" n={current.available} />
            <BigLegend swatch={GOLD} label="RESERVED" n={current.reserved} />
            <BigLegend swatch={SAGE} label="IN CONTRACT" n={current.underContract} />
            {current.sold > 0 && <BigLegend swatch={IVORY} label="SOLD" n={current.sold} />}
          </div>
        </div>
      )}
      {overview && (
        <div style={{ position: "absolute", left: 56, top: 30, background: INK, borderLeft: `6px solid ${LIME}`, padding: "14px 30px", borderRadius: 6 }}>
          <span style={{ fontSize: 12, letterSpacing: "0.4em", color: LIME, fontWeight: 700 }}>THE PORTFOLIO</span>
        </div>
      )}
    </main>
  );
}

const BALLOONS = [INK, "#ffffff", GOLD, IVORY, "#e8734a", SAGE];

function Celebration({ move }: { move: { unit: string; building: string } }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 50, background: LIME, display: "flex", alignItems: "center", justifyContent: "center", animation: "wPop 11s both", overflow: "hidden" }}>
      {Array.from({ length: 22 }).map((_, i) => {
        const c = BALLOONS[i % BALLOONS.length];
        const left = (i * 137) % 100;
        const dur = 7 + ((i * 53) % 50) / 10;
        const delay = ((i * 77) % 40) / 10;
        const size = 34 + ((i * 31) % 30);
        return (
          <div key={i} style={{ position: "absolute", left: `${left}%`, bottom: 0, animation: `wBalloon ${dur}s linear ${delay}s infinite` }}>
            <div style={{ width: size, height: size * 1.2, borderRadius: "50% 50% 48% 48%", background: c, opacity: 0.94, boxShadow: "inset -6px -8px 0 rgba(0,0,0,.1)" }} />
            <div style={{ width: 1, height: 46, background: "rgba(21,21,13,.4)", margin: "0 auto" }} />
          </div>
        );
      })}
      <div style={{ textAlign: "center", position: "relative" }}>
        <div style={{ fontSize: 14, letterSpacing: "0.6em", fontWeight: 700, color: INK }}>ANOTHER ONE CLOSED</div>
        <div style={{ fontFamily: DISPLAY, fontSize: "clamp(64px, 13vh, 148px)", lineHeight: 0.95, color: INK, letterSpacing: "-0.02em", marginTop: 14 }}>
          CONGRATULATIONS
        </div>
        <img src={LOGO} alt="Mount Realty Group" style={{ height: 52, marginTop: 18 }} />
        <div style={{ fontSize: 15, letterSpacing: "0.3em", fontWeight: 700, color: INK, marginTop: 18 }}>
          {move.building} · {move.unit} — SOLD
        </div>
      </div>
    </div>
  );
}

function Rule() {
  return <div style={{ width: 1, background: FAINT, margin: "0 22px", flexShrink: 0 }} />;
}

function Period({ label, moves, prev, against }: { label: string; moves: number; prev: number; against: string }) {
  const delta = moves - prev;
  const up = delta >= 0;
  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 10, letterSpacing: "0.34em", fontWeight: 700, color: MUTE }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 5 }}>
        <span style={{ fontFamily: DISPLAY, fontSize: "clamp(30px, 4.4vh, 46px)", color: INK, lineHeight: 1, letterSpacing: "-0.02em" }}>
          {moves}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: up ? "#5f7d16" : "#a3742a", whiteSpace: "nowrap" }}>
          {up ? "\u25b2" : "\u25bc"}{Math.abs(delta)}
        </span>
      </div>
      <div style={{ fontSize: 10, letterSpacing: "0.14em", color: MUTE, fontWeight: 600, marginTop: 4, whiteSpace: "nowrap" }}>
        UNIT MOVES · VS {against} {prev}
      </div>
    </div>
  );
}

function Line({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, padding: "7px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ width: 10, height: 10, borderRadius: 2, background: tone, border: `1.5px solid ${INK}`, flexShrink: 0 }} />
        <span style={{ fontSize: 11, letterSpacing: "0.3em", fontWeight: 700, color: MUTE, whiteSpace: "nowrap" }}>
          {label}
        </span>
      </div>
      <span style={{ fontFamily: DISPLAY, fontSize: "clamp(30px, 4.6vh, 48px)", color: INK, lineHeight: 1, letterSpacing: "-0.02em" }}>
        {value}
      </span>
    </div>
  );
}

function Legend({ swatch, label, n }: { swatch: string; label: string; n: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
      <span style={{ width: 9, height: 9, borderRadius: 2, background: swatch, border: `1px solid ${INK}` }} />
      <span style={{ fontSize: 9, letterSpacing: "0.24em", fontWeight: 700, color: MUTE }}>{label}</span>
      <span style={{ fontFamily: DISPLAY, fontSize: 16, color: INK }}>{n}</span>
    </div>
  );
}

/** Larger legend for the big map caption card (sits on ink). */
function BigLegend({ swatch, label, n }: { swatch: string; label: string; n: number }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
        <span style={{ width: 12, height: 12, borderRadius: 3, background: swatch }} />
        <span style={{ fontFamily: DISPLAY, fontSize: 30, color: IVORY, lineHeight: 1 }}>{n}</span>
      </div>
      <span style={{ fontSize: 9, letterSpacing: "0.24em", fontWeight: 700, color: "rgba(244,241,228,.7)" }}>{label}</span>
    </div>
  );
}
