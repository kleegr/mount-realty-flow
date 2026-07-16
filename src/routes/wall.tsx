import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * WALL MONITOR — concept, pass 3.
 *
 * PALETTE, taken directly from the Mount / Diligent ads rather than invented:
 *   LIME    #C6D92E  the signature band (every piece)
 *   NAVY    #23365E  the Diligent headline + logo
 *   GOLD    #C9A961  the Spencer St metallic lettering
 *   FOREST  #2C3A1E  the Spencer St / listing-sheet ground
 *   SAGE    #7C8B5E  the Mega ad mountains
 *   STONE   #EDE9DC  the Mega ad rock + the Diligent canvas
 *   INK     #12140C  the project chips, the wordmark
 *
 * The canvas is LIGHT because the brand's two loudest pieces are light: the
 * Diligent ad is stone with a lime band, the Mega ad is sand and mist. Dark is
 * used the way the listing sheet uses it — in blocks, so colour can shout
 * against it. Black chips carry project names, exactly as in the ads.
 *
 * Top-level route on purpose — _authenticated wraps every page in the AppShell
 * ribbon, and a wall monitor with a nav bar is not a wall monitor. The PIN
 * still gates it via beforeLoad.
 *
 * LOGO: the MOUNT wordmark is custom lettering — no typeface reproduces that M.
 * Drop the real asset at /public/mount-logo.svg and it renders automatically.
 *
 * CONCEPT STAGE: sample data using the real Lazers totals (181/8/177/1) so the
 * layout is judged at true scale. Nothing reads the database yet.
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
const ON_LIME = "#39430F";
const NAVY = "#23365E";
const GOLD = "#C9A961";
const FOREST = "#2C3A1E";
const SAGE = "#7C8B5E";
const STONE = "#EDE9DC";
const CREAM = "#F7F5EE";
const INK = "#12140C";

const DISPLAY = "'Anton','Arial Narrow',Impact,sans-serif";
const BODY = "'Archivo',Inter,system-ui,sans-serif";

const SAMPLE = {
  available: 181,
  reserved: 8,
  underContract: 177,
  sold: 1,
  contractedVolume: 147_180_000,
  soldVolume: 830_780,
  week: { sold: 4, reserved: 6, contracted: 11 },
  lastWeek: { sold: 2, reserved: 9, contracted: 7 },
  projects: [
    { name: "MANGIN ROAD", total: 42, sold: 0, uc: 28, res: 2 },
    { name: "DILIGENT GARDENS", total: 75, sold: 1, uc: 41, res: 3 },
    { name: "FORT WORTH PL", total: 58, sold: 0, uc: 34, res: 1 },
    { name: "OLD TOWN", total: 36, sold: 0, uc: 19, res: 0 },
    { name: "DALLAS DRIVE", total: 44, sold: 0, uc: 22, res: 2 },
    { name: "GROVEVIEW", total: 142, sold: 0, uc: 33, res: 0 },
  ],
  ticker: [
    "UNDER CONTRACT — 8 UNIT BUILDING C4 · UNIT 102",
    "RESERVED — 51 FORT WORTH · UNIT 102",
    "UNDER CONTRACT — DILIGENT GARDENS · UNIT 205",
    "SOLD — 28 DUELK · UNIT 102",
    "UNDER CONTRACT — 1 SAN MARCOS · UNIT 202",
    "RESERVED — MANGIN ROAD · UNIT 101",
  ],
};

const TOTAL = SAMPLE.available + SAMPLE.reserved + SAMPLE.underContract + SAMPLE.sold;

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

function WallMonitor() {
  const [now, setNow] = useState(() => new Date());
  const [spot, setSpot] = useState(0);
  const [hasLogo, setHasLogo] = useState(false);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setSpot((s) => (s + 1) % SAMPLE.projects.length), 7000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const img = new Image();
    img.onload = () => setHasLogo(true);
    img.src = "/mount-logo.svg";
  }, []);

  const p = SAMPLE.projects[spot];
  const pAvail = p.total - p.sold - p.uc - p.res;

  return (
    <div
      style={{
        height: "100vh",
        background: STONE,
        color: INK,
        fontFamily: BODY,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&display=swap');
        @keyframes wTick { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        @keyframes wIn { from { opacity: 0; transform: translateY(10px) } to { opacity: 1; transform: none } }
        @keyframes wDot { 0%,100% { opacity: 1 } 50% { opacity: .2 } }
        .grow { transition: width 1s cubic-bezier(.22,1,.36,1) }
      `}</style>

      {/* ---------------- header ---------------- */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 44px",
          height: 84,
          flexShrink: 0,
          background: CREAM,
          borderBottom: `1px solid rgba(18,20,12,.10)`,
        }}
      >
        {hasLogo ? (
          <img src="/mount-logo.svg" alt="Mount Realty Group" style={{ height: 38 }} />
        ) : (
          <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
            <span style={{ fontFamily: DISPLAY, fontSize: 38, letterSpacing: "-0.02em", color: INK, lineHeight: 1 }}>
              MOUNT
            </span>
            <span style={{ fontSize: 10, letterSpacing: "0.52em", color: SAGE, fontWeight: 700 }}>
              REALTY GROUP
            </span>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: LIME, animation: "wDot 2s infinite" }} />
          <span style={{ fontSize: 11, letterSpacing: "0.38em", fontWeight: 700, color: NAVY }}>LIVE INVENTORY</span>
          <span style={{ width: 1, height: 18, background: "rgba(18,20,12,.14)", margin: "0 4px" }} />
          <span style={{ fontSize: 12, letterSpacing: "0.16em", color: SAGE, fontWeight: 600 }}>
            {now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" }).toUpperCase()}
            {"  ·  "}
            {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
      </header>

      {/* ---------------- body ---------------- */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "1.42fr 1fr",
          gap: 16,
          padding: "16px 44px 18px",
        }}
      >
        {/* ---- left ---- */}
        <section style={{ display: "grid", gridTemplateRows: "1.55fr 1fr", gap: 16, minHeight: 0 }}>
          <div
            style={{
              background: LIME,
              borderRadius: 18,
              padding: "24px 32px",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              minHeight: 0,
              animation: "wIn .5s both",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 12, letterSpacing: "0.42em", fontWeight: 700, color: ON_LIME }}>
                AVAILABLE NOW
              </span>
              <span style={{ fontSize: 12, letterSpacing: "0.2em", fontWeight: 700, color: ON_LIME, opacity: 0.7 }}>
                {Math.round((SAMPLE.available / TOTAL) * 100)}% OF PORTFOLIO
              </span>
            </div>

            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 24, minHeight: 0 }}>
              <span
                style={{
                  fontFamily: DISPLAY,
                  fontSize: "clamp(88px, 14.5vh, 184px)",
                  lineHeight: 0.76,
                  letterSpacing: "-0.03em",
                  color: INK,
                }}
              >
                {SAMPLE.available}
              </span>
              <div style={{ borderLeft: `2px solid ${ON_LIME}`, paddingLeft: 20 }}>
                <div style={{ fontFamily: DISPLAY, fontSize: 28, color: ON_LIME, lineHeight: 1 }}>{TOTAL}</div>
                <div style={{ fontSize: 10, letterSpacing: "0.28em", fontWeight: 700, color: ON_LIME, marginTop: 4 }}>
                  TOTAL UNITS
                </div>
              </div>
            </div>

            <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: "rgba(57,67,15,.22)" }}>
              <div className="grow" style={{ width: `${(SAMPLE.available / TOTAL) * 100}%`, background: "rgba(57,67,15,.16)" }} />
              <div className="grow" style={{ width: `${(SAMPLE.underContract / TOTAL) * 100}%`, background: NAVY }} />
              <div className="grow" style={{ width: `${(SAMPLE.reserved / TOTAL) * 100}%`, background: GOLD }} />
              <div className="grow" style={{ width: `${(SAMPLE.sold / TOTAL) * 100}%`, background: CREAM }} />
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, minHeight: 0 }}>
            <Stat label="RESERVED" value={SAMPLE.reserved} bg={GOLD} fg={INK} sub="rgba(18,20,12,.62)" />
            <Stat label="UNDER CONTRACT" value={SAMPLE.underContract} bg={NAVY} fg={CREAM} sub="rgba(247,245,238,.66)" />
            <Stat label="SOLD" value={SAMPLE.sold} bg={FOREST} fg={LIME} sub="rgba(198,217,46,.66)" />
          </div>
        </section>

        {/* ---- right ---- */}
        <section style={{ display: "grid", gridTemplateRows: "auto auto 1fr", gap: 16, minHeight: 0 }}>
          <div style={{ background: INK, borderRadius: 18, padding: "18px 24px" }}>
            <span style={{ fontSize: 10, letterSpacing: "0.4em", fontWeight: 700, color: SAGE }}>
              CONTRACTED VOLUME
            </span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 12, marginTop: 8 }}>
              <span style={{ fontFamily: DISPLAY, fontSize: 58, letterSpacing: "-0.02em", color: LIME, lineHeight: 0.9 }}>
                {money(SAMPLE.contractedVolume)}
              </span>
              <span style={{ fontSize: 12, color: GOLD, fontWeight: 700, letterSpacing: "0.1em" }}>
                {money(SAMPLE.soldVolume)} CLOSED
              </span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16 }}>
            <Week label="SOLD" now={SAMPLE.week.sold} prev={SAMPLE.lastWeek.sold} accent={FOREST} />
            <Week label="RESERVED" now={SAMPLE.week.reserved} prev={SAMPLE.lastWeek.reserved} accent={GOLD} />
            <Week label="CONTRACTED" now={SAMPLE.week.contracted} prev={SAMPLE.lastWeek.contracted} accent={NAVY} />
          </div>

          <div
            style={{
              background: CREAM,
              border: `1px solid rgba(18,20,12,.10)`,
              borderRadius: 18,
              padding: "18px 24px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              minHeight: 0,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 10, letterSpacing: "0.4em", fontWeight: 700, color: SAGE }}>
                PROJECT SPOTLIGHT
              </span>
              <div style={{ display: "flex", gap: 5 }}>
                {SAMPLE.projects.map((_, i) => (
                  <span
                    key={i}
                    style={{
                      width: i === spot ? 20 : 8,
                      height: 3,
                      borderRadius: 999,
                      background: i === spot ? NAVY : "rgba(18,20,12,.18)",
                      transition: "width .4s",
                    }}
                  />
                ))}
              </div>
            </div>

            <div
              key={spot}
              style={{
                flex: 1,
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                gap: 14,
                animation: "wIn .6s both",
                minHeight: 0,
              }}
            >
              <div
                style={{
                  display: "inline-flex",
                  flexDirection: "column",
                  background: INK,
                  padding: "9px 18px",
                  borderRadius: 5,
                  alignSelf: "flex-start",
                }}
              >
                <span style={{ fontSize: 9, letterSpacing: "0.34em", color: SAGE, fontWeight: 700 }}>PROJECT</span>
                <span style={{ fontFamily: DISPLAY, fontSize: 25, color: CREAM, lineHeight: 1.15 }}>{p.name}</span>
              </div>

              <div style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", background: "rgba(18,20,12,.10)" }}>
                <div className="grow" style={{ width: `${(p.sold / p.total) * 100}%`, background: FOREST }} />
                <div className="grow" style={{ width: `${(p.uc / p.total) * 100}%`, background: NAVY }} />
                <div className="grow" style={{ width: `${(p.res / p.total) * 100}%`, background: GOLD }} />
                <div className="grow" style={{ width: `${(pAvail / p.total) * 100}%`, background: LIME }} />
              </div>

              <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
                <Legend swatch={LIME} label="AVAILABLE" n={pAvail} />
                <Legend swatch={NAVY} label="CONTRACT" n={p.uc} />
                <Legend swatch={GOLD} label="RESERVED" n={p.res} />
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ---------------- ticker ---------------- */}
      <footer style={{ background: LIME, overflow: "hidden", padding: "12px 0", flexShrink: 0 }}>
        <div style={{ display: "flex", width: "max-content", animation: "wTick 46s linear infinite" }}>
          {[0, 1].map((dup) => (
            <div key={dup} style={{ display: "flex" }}>
              {SAMPLE.ticker.map((t, i) => (
                <span
                  key={`${dup}-${i}`}
                  style={{
                    fontSize: 15,
                    fontWeight: 700,
                    letterSpacing: "0.18em",
                    color: ON_LIME,
                    padding: "0 42px",
                    whiteSpace: "nowrap",
                  }}
                >
                  {t}
                </span>
              ))}
            </div>
          ))}
        </div>
      </footer>
    </div>
  );
}

function Stat({
  label, value, bg, fg, sub,
}: { label: string; value: number; bg: string; fg: string; sub: string }) {
  return (
    <div
      style={{
        background: bg,
        borderRadius: 18,
        padding: "16px 22px",
        display: "flex",
        flexDirection: "column",
        gap: 4,
        minHeight: 0,
        justifyContent: "center",
      }}
    >
      <span style={{ fontSize: 10, letterSpacing: "0.32em", fontWeight: 700, color: sub }}>{label}</span>
      <span
        style={{
          fontFamily: DISPLAY,
          fontSize: "clamp(46px, 7.6vh, 78px)",
          lineHeight: 0.86,
          letterSpacing: "-0.02em",
          color: fg,
        }}
      >
        {value}
      </span>
    </div>
  );
}

function Week({
  label, now, prev, accent,
}: { label: string; now: number; prev: number; accent: string }) {
  const up = now >= prev;
  const delta = Math.abs(now - prev);
  return (
    <div
      style={{
        background: CREAM,
        border: `1px solid rgba(18,20,12,.10)`,
        borderTop: `3px solid ${accent}`,
        borderRadius: 14,
        padding: "12px 16px",
      }}
    >
      <div style={{ fontSize: 9, letterSpacing: "0.3em", fontWeight: 700, color: SAGE }}>{label} · WK</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 7, marginTop: 3 }}>
        <span style={{ fontFamily: DISPLAY, fontSize: 38, color: INK, lineHeight: 1, letterSpacing: "-0.02em" }}>
          {now}
        </span>
        <span style={{ fontSize: 12, fontWeight: 700, color: up ? "#4C7A1E" : GOLD }}>
          {up ? "▲" : "▼"}{delta}
        </span>
      </div>
      <div style={{ fontSize: 9, color: SAGE, marginTop: 2, letterSpacing: "0.14em", fontWeight: 600 }}>
        LAST WK {prev}
      </div>
    </div>
  );
}

function Legend({ swatch, label, n }: { swatch: string; label: string; n: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: swatch }} />
      <span style={{ fontSize: 9, letterSpacing: "0.22em", fontWeight: 700, color: SAGE }}>{label}</span>
      <span style={{ fontFamily: DISPLAY, fontSize: 16, color: INK }}>{n}</span>
    </div>
  );
}
