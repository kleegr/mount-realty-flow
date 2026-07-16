import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * WALL MONITOR — concept, pass 2.
 *
 * Mount Realty's identity, not Kleegr's. Rules taken from the ads:
 *   - Lime is the LOUD surface, not an accent. Cards are bright; the canvas is
 *     dark only so the lime and cream can shout (see the Listing sheet).
 *   - Headlines are heavy condensed caps, tight leading, negative tracking.
 *   - Metadata is tiny, tracked-out, all caps.
 *   - Black chips carry project names.
 *
 * Top-level route on purpose — _authenticated wraps every page in the AppShell
 * ribbon, and a wall monitor with a nav bar on it is not a wall monitor. The
 * PIN still gates it via beforeLoad.
 *
 * LOGO: the MOUNT wordmark is custom lettering — no typeface reproduces that M.
 * Drop the real asset at /public/mount-logo.svg and it renders automatically;
 * until then the type lockup below stands in.
 *
 * CONCEPT STAGE: numbers are sample data using the real Lazers totals
 * (181 / 8 / 177 / 1) so the layout is judged at true scale. Nothing reads the
 * database yet.
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
const INK = "#161B0E";
const OLIVE = "#26301A";
const CREAM = "#F4F2E8";
const BRONZE = "#C2A264";
const MUTED = "#93A07E";

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

  // Swap the type lockup for the real wordmark the moment the asset exists.
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
        background: INK,
        color: CREAM,
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
        @keyframes wDot { 0%,100% { opacity: 1 } 50% { opacity: .25 } }
        .grow { transition: width 1s cubic-bezier(.22,1,.36,1) }
      `}</style>

      {/* ---------------- header ---------------- */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 44px",
          height: 86,
          flexShrink: 0,
          borderBottom: `1px solid ${OLIVE}`,
        }}
      >
        {hasLogo ? (
          <img src="/mount-logo.svg" alt="Mount Realty Group" style={{ height: 40 }} />
        ) : (
          <div style={{ display: "flex", alignItems: "baseline", gap: 16 }}>
            <span
              style={{
                fontFamily: DISPLAY,
                fontSize: 40,
                letterSpacing: "-0.02em",
                color: CREAM,
                lineHeight: 1,
              }}
            >
              MOUNT
            </span>
            <span style={{ fontSize: 11, letterSpacing: "0.5em", color: BRONZE, fontWeight: 600 }}>
              REALTY GROUP
            </span>
          </div>
        )}

        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: LIME, animation: "wDot 2s infinite" }} />
          <span style={{ fontSize: 12, letterSpacing: "0.36em", fontWeight: 700, color: LIME }}>
            LIVE INVENTORY
          </span>
          <span style={{ width: 1, height: 20, background: OLIVE, margin: "0 4px" }} />
          <span style={{ fontSize: 13, letterSpacing: "0.14em", color: MUTED, fontWeight: 500 }}>
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
          gap: 18,
          padding: "18px 44px 20px",
        }}
      >
        {/* ---- left ---- */}
        <section style={{ display: "grid", gridTemplateRows: "1.55fr 1fr", gap: 18, minHeight: 0 }}>
          {/* hero */}
          <div
            style={{
              background: LIME,
              borderRadius: 18,
              padding: "26px 34px",
              display: "flex",
              flexDirection: "column",
              gap: 14,
              minHeight: 0,
              animation: "wIn .5s both",
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, letterSpacing: "0.4em", fontWeight: 700, color: ON_LIME }}>
                AVAILABLE NOW
              </span>
              <span style={{ fontSize: 13, letterSpacing: "0.2em", fontWeight: 700, color: ON_LIME, opacity: 0.75 }}>
                {Math.round((SAMPLE.available / TOTAL) * 100)}% OF PORTFOLIO
              </span>
            </div>

            <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 26, minHeight: 0 }}>
              <span
                style={{
                  fontFamily: DISPLAY,
                  fontSize: "clamp(90px, 15vh, 190px)",
                  lineHeight: 0.76,
                  letterSpacing: "-0.03em",
                  color: INK,
                }}
              >
                {SAMPLE.available}
              </span>
              <div style={{ borderLeft: `2px solid ${ON_LIME}`, paddingLeft: 22, opacity: 0.9 }}>
                <div style={{ fontFamily: DISPLAY, fontSize: 30, color: ON_LIME, lineHeight: 1 }}>{TOTAL}</div>
                <div style={{ fontSize: 11, letterSpacing: "0.26em", fontWeight: 700, color: ON_LIME, marginTop: 4 }}>
                  TOTAL UNITS
                </div>
              </div>
            </div>

            {/* portfolio composition */}
            <div style={{ display: "flex", height: 10, borderRadius: 999, overflow: "hidden", background: ON_LIME }}>
              <div className="grow" style={{ width: `${(SAMPLE.available / TOTAL) * 100}%`, background: INK, opacity: 0.14 }} />
              <div className="grow" style={{ width: `${(SAMPLE.underContract / TOTAL) * 100}%`, background: INK }} />
              <div className="grow" style={{ width: `${(SAMPLE.reserved / TOTAL) * 100}%`, background: BRONZE }} />
              <div className="grow" style={{ width: `${(SAMPLE.sold / TOTAL) * 100}%`, background: CREAM }} />
            </div>
          </div>

          {/* three states — bright cards, dark numerals */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 18, minHeight: 0 }}>
            <Stat label="RESERVED" value={SAMPLE.reserved} bg={CREAM} fg={INK} dot={BRONZE} />
            <Stat label="UNDER CONTRACT" value={SAMPLE.underContract} bg={CREAM} fg={INK} dot={LIME} />
            <Stat label="SOLD" value={SAMPLE.sold} bg={BRONZE} fg={INK} dot={INK} />
          </div>
        </section>

        {/* ---- right ---- */}
        <section style={{ display: "grid", gridTemplateRows: "auto auto 1fr", gap: 18, minHeight: 0 }}>
          <div style={{ background: OLIVE, borderRadius: 18, padding: "20px 26px" }}>
            <span style={{ fontSize: 11, letterSpacing: "0.38em", fontWeight: 700, color: MUTED }}>
              CONTRACTED VOLUME
            </span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 14, marginTop: 10 }}>
              <span style={{ fontFamily: DISPLAY, fontSize: 60, letterSpacing: "-0.02em", color: LIME, lineHeight: 0.9 }}>
                {money(SAMPLE.contractedVolume)}
              </span>
              <span style={{ fontSize: 13, color: CREAM, fontWeight: 600, letterSpacing: "0.08em" }}>
                {money(SAMPLE.soldVolume)} CLOSED
              </span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 18 }}>
            <Week label="SOLD" now={SAMPLE.week.sold} prev={SAMPLE.lastWeek.sold} />
            <Week label="RESERVED" now={SAMPLE.week.reserved} prev={SAMPLE.lastWeek.reserved} />
            <Week label="CONTRACTED" now={SAMPLE.week.contracted} prev={SAMPLE.lastWeek.contracted} />
          </div>

          <div
            style={{
              background: OLIVE,
              borderRadius: 18,
              padding: "20px 26px",
              display: "flex",
              flexDirection: "column",
              gap: 16,
              minHeight: 0,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 11, letterSpacing: "0.38em", fontWeight: 700, color: MUTED }}>
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
                      background: i === spot ? LIME : "#445133",
                      transition: "width .4s",
                    }}
                  />
                ))}
              </div>
            </div>

            <div key={spot} style={{ flex: 1, display: "flex", flexDirection: "column", justifyContent: "center", gap: 16, animation: "wIn .6s both", minHeight: 0 }}>
              <div style={{ display: "inline-flex", flexDirection: "column", background: INK, padding: "10px 18px", borderRadius: 5, alignSelf: "flex-start" }}>
                <span style={{ fontSize: 9, letterSpacing: "0.34em", color: MUTED, fontWeight: 700 }}>PROJECT</span>
                <span style={{ fontFamily: DISPLAY, fontSize: 26, letterSpacing: "0.01em", color: CREAM, lineHeight: 1.15 }}>
                  {p.name}
                </span>
              </div>

              <div style={{ display: "flex", height: 14, borderRadius: 999, overflow: "hidden", background: "#3A472B" }}>
                <div className="grow" style={{ width: `${(p.sold / p.total) * 100}%`, background: CREAM }} />
                <div className="grow" style={{ width: `${(p.uc / p.total) * 100}%`, background: LIME }} />
                <div className="grow" style={{ width: `${(p.res / p.total) * 100}%`, background: BRONZE }} />
              </div>

              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                <Legend swatch={LIME} label="CONTRACT" n={p.uc} />
                <Legend swatch={BRONZE} label="RESERVED" n={p.res} />
                <Legend swatch="#3A472B" label="AVAILABLE" n={pAvail} />
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ---------------- ticker ---------------- */}
      <footer style={{ background: LIME, overflow: "hidden", padding: "13px 0", flexShrink: 0 }}>
        <div style={{ display: "flex", width: "max-content", animation: "wTick 46s linear infinite" }}>
          {[0, 1].map((dup) => (
            <div key={dup} style={{ display: "flex" }}>
              {SAMPLE.ticker.map((t, i) => (
                <span
                  key={`${dup}-${i}`}
                  style={{
                    fontSize: 16,
                    fontWeight: 700,
                    letterSpacing: "0.18em",
                    color: ON_LIME,
                    padding: "0 44px",
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

function Stat({ label, value, bg, fg, dot }: { label: string; value: number; bg: string; fg: string; dot: string }) {
  return (
    <div
      style={{
        background: bg,
        borderRadius: 18,
        padding: "18px 22px",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        minHeight: 0,
        justifyContent: "center",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: dot }} />
        <span style={{ fontSize: 11, letterSpacing: "0.3em", fontWeight: 700, color: fg, opacity: 0.65 }}>
          {label}
        </span>
      </div>
      <span style={{ fontFamily: DISPLAY, fontSize: "clamp(48px, 8vh, 82px)", lineHeight: 0.86, letterSpacing: "-0.02em", color: fg }}>
        {value}
      </span>
    </div>
  );
}

function Week({ label, now, prev }: { label: string; now: number; prev: number }) {
  const up = now >= prev;
  const delta = Math.abs(now - prev);
  return (
    <div style={{ background: OLIVE, borderRadius: 18, padding: "14px 18px" }}>
      <div style={{ fontSize: 9, letterSpacing: "0.3em", fontWeight: 700, color: MUTED }}>{label} · WK</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
        <span style={{ fontFamily: DISPLAY, fontSize: 40, color: CREAM, lineHeight: 1, letterSpacing: "-0.02em" }}>
          {now}
        </span>
        <span style={{ fontSize: 13, fontWeight: 700, color: up ? LIME : BRONZE }}>
          {up ? "▲" : "▼"}{delta}
        </span>
      </div>
      <div style={{ fontSize: 10, color: "#6E7A5E", marginTop: 3, letterSpacing: "0.12em", fontWeight: 600 }}>
        LAST WK {prev}
      </div>
    </div>
  );
}

function Legend({ swatch, label, n }: { swatch: string; label: string; n: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ width: 10, height: 10, borderRadius: 2, background: swatch }} />
      <span style={{ fontSize: 10, letterSpacing: "0.2em", fontWeight: 700, color: MUTED }}>{label}</span>
      <span style={{ fontFamily: DISPLAY, fontSize: 17, color: CREAM }}>{n}</span>
    </div>
  );
}
