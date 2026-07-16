import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * WALL MONITOR — concept build.
 *
 * A full-bleed dashboard for the office TV. Mount Realty's own identity, not
 * Kleegr's: lime / deep olive / cream, heavy condensed caps, black project
 * chips — lifted from the Diligent Developers and Listing sheets.
 *
 * Deliberately a TOP-LEVEL route, not under _authenticated: that layout wraps
 * every page in the AppShell ribbon, and a wall monitor with a nav bar on it is
 * not a wall monitor. Auth is still enforced here via beforeLoad, so the PIN
 * still gates it.
 *
 * CONCEPT STAGE: every number below is sample data, using the real Lazers sheet
 * totals (181 / 8 / 177 / 1) so the layout is being judged at true scale.
 * Nothing here reads the database yet — that's the next step, once the look is
 * approved.
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
const OLIVE = "#2C3A1E";
const INK = "#12160C";
const PANEL = "#1C2413";
const CREAM = "#F4F2E8";
const BRONZE = "#C2A264";

const HEAD = "'Arial Narrow','Helvetica Neue',Inter,system-ui,sans-serif";

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
    "UNDER CONTRACT — 8 Unit Building C4 · Unit 102",
    "RESERVED — 51 Fort Worth · Unit 102",
    "UNDER CONTRACT — Diligent Gardens · Unit 205",
    "SOLD — 28 Duelk · Unit 102",
    "UNDER CONTRACT — 1 San Marcos · Unit 202",
    "RESERVED — Mangin Road · Unit 101",
  ],
};

function money(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${n}`;
}

function WallMonitor() {
  const [now, setNow] = useState(() => new Date());
  const [spot, setSpot] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setSpot((s) => (s + 1) % SAMPLE.projects.length), 7000);
    return () => clearInterval(t);
  }, []);

  const p = SAMPLE.projects[spot];
  const pAvail = p.total - p.sold - p.uc - p.res;
  const pct = (n: number) => `${(n / p.total) * 100}%`;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: INK,
        color: CREAM,
        fontFamily: HEAD,
        display: "flex",
        flexDirection: "column",
        overflow: "hidden",
      }}
    >
      <style>{`
        @keyframes wallTicker { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        @keyframes wallFade { from { opacity: 0; transform: translateY(8px) } to { opacity: 1; transform: none } }
        @keyframes wallPulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }
        .wallGrow { transition: width 900ms cubic-bezier(.22,1,.36,1) }
      `}</style>

      {/* ---------- header ---------- */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "22px 40px",
          borderBottom: `1px solid ${OLIVE}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 18 }}>
          <span style={{ fontSize: 44, fontWeight: 900, letterSpacing: "-0.04em", color: CREAM }}>
            MOUNT
          </span>
          <span style={{ fontSize: 13, letterSpacing: "0.42em", color: BRONZE, fontWeight: 700 }}>
            REALTY GROUP
          </span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: 999,
              background: LIME,
              animation: "wallPulse 2s infinite",
            }}
          />
          <span style={{ fontSize: 15, letterSpacing: "0.3em", fontWeight: 700, color: LIME }}>
            LIVE INVENTORY
          </span>
          <span style={{ fontSize: 15, letterSpacing: "0.1em", color: "#8A9678", marginLeft: 10 }}>
            {now.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })}
            {" · "}
            {now.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}
          </span>
        </div>
      </header>

      {/* ---------- body ---------- */}
      <main
        style={{
          flex: 1,
          display: "grid",
          gridTemplateColumns: "1.35fr 1fr",
          gap: 24,
          padding: "26px 40px",
          minHeight: 0,
        }}
      >
        {/* left: the four statuses */}
        <section style={{ display: "grid", gridTemplateRows: "1.5fr 1fr", gap: 20, minHeight: 0 }}>
          <div
            style={{
              background: LIME,
              borderRadius: 20,
              padding: "28px 34px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              animation: "wallFade .5s both",
            }}
          >
            <span style={{ fontSize: 15, letterSpacing: "0.34em", fontWeight: 700, color: "#3F4A12" }}>
              AVAILABLE NOW
            </span>
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between" }}>
              <span
                style={{
                  fontSize: 168,
                  lineHeight: 0.82,
                  fontWeight: 900,
                  letterSpacing: "-0.05em",
                  color: INK,
                }}
              >
                {SAMPLE.available}
              </span>
              <span style={{ fontSize: 19, fontWeight: 700, color: "#3F4A12", paddingBottom: 12 }}>
                of {SAMPLE.available + SAMPLE.reserved + SAMPLE.underContract + SAMPLE.sold} units
              </span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 20, minHeight: 0 }}>
            <Tile label="RESERVED" value={SAMPLE.reserved} tone={BRONZE} />
            <Tile label="UNDER CONTRACT" value={SAMPLE.underContract} tone={LIME} />
            <Tile label="SOLD" value={SAMPLE.sold} tone={CREAM} />
          </div>
        </section>

        {/* right: money, week, spotlight */}
        <section style={{ display: "grid", gridTemplateRows: "auto auto 1fr", gap: 20, minHeight: 0 }}>
          <div style={{ background: PANEL, borderRadius: 20, padding: "22px 28px" }}>
            <span style={{ fontSize: 13, letterSpacing: "0.34em", fontWeight: 700, color: "#8A9678" }}>
              CONTRACTED VOLUME
            </span>
            <div style={{ display: "flex", alignItems: "baseline", gap: 16, marginTop: 8 }}>
              <span style={{ fontSize: 66, fontWeight: 900, letterSpacing: "-0.04em", color: LIME, lineHeight: 1 }}>
                {money(SAMPLE.contractedVolume)}
              </span>
              <span style={{ fontSize: 15, color: "#8A9678", fontWeight: 700 }}>
                {money(SAMPLE.soldVolume)} closed
              </span>
            </div>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 20 }}>
            <Week label="SOLD" now={SAMPLE.week.sold} prev={SAMPLE.lastWeek.sold} />
            <Week label="RESERVED" now={SAMPLE.week.reserved} prev={SAMPLE.lastWeek.reserved} />
            <Week label="CONTRACTED" now={SAMPLE.week.contracted} prev={SAMPLE.lastWeek.contracted} />
          </div>

          <div
            style={{
              background: PANEL,
              borderRadius: 20,
              padding: "24px 28px",
              display: "flex",
              flexDirection: "column",
              justifyContent: "space-between",
              minHeight: 0,
            }}
          >
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <span style={{ fontSize: 13, letterSpacing: "0.34em", fontWeight: 700, color: "#8A9678" }}>
                PROJECT SPOTLIGHT
              </span>
              <div style={{ display: "flex", gap: 6 }}>
                {SAMPLE.projects.map((_, i) => (
                  <span
                    key={i}
                    style={{
                      width: 18,
                      height: 4,
                      borderRadius: 999,
                      background: i === spot ? LIME : "#3A472B",
                    }}
                  />
                ))}
              </div>
            </div>

            <div key={spot} style={{ animation: "wallFade .6s both" }}>
              <div
                style={{
                  display: "inline-block",
                  background: INK,
                  padding: "9px 18px",
                  borderRadius: 6,
                  marginBottom: 16,
                }}
              >
                <div style={{ fontSize: 10, letterSpacing: "0.3em", color: "#8A9678", fontWeight: 700 }}>
                  PROJECT
                </div>
                <div style={{ fontSize: 26, fontWeight: 900, letterSpacing: "-0.02em", color: CREAM }}>
                  {p.name}
                </div>
              </div>

              <div style={{ display: "flex", height: 16, borderRadius: 999, overflow: "hidden", background: "#3A472B" }}>
                <div className="wallGrow" style={{ width: pct(p.sold), background: CREAM }} />
                <div className="wallGrow" style={{ width: pct(p.uc), background: LIME }} />
                <div className="wallGrow" style={{ width: pct(p.res), background: BRONZE }} />
              </div>

              <div style={{ display: "flex", gap: 26, marginTop: 16 }}>
                <Legend swatch={LIME} label="UNDER CONTRACT" n={p.uc} />
                <Legend swatch={BRONZE} label="RESERVED" n={p.res} />
                <Legend swatch="#3A472B" label="AVAILABLE" n={pAvail} />
              </div>
            </div>
          </div>
        </section>
      </main>

      {/* ---------- ticker ---------- */}
      <footer style={{ background: LIME, overflow: "hidden", padding: "14px 0" }}>
        <div style={{ display: "flex", width: "max-content", animation: "wallTicker 44s linear infinite" }}>
          {[0, 1].map((dup) => (
            <div key={dup} style={{ display: "flex" }}>
              {SAMPLE.ticker.map((t, i) => (
                <span
                  key={`${dup}-${i}`}
                  style={{
                    fontSize: 19,
                    fontWeight: 700,
                    letterSpacing: "0.14em",
                    color: INK,
                    padding: "0 46px",
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

function Tile({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div
      style={{
        background: PANEL,
        borderRadius: 20,
        padding: "20px 24px",
        display: "flex",
        flexDirection: "column",
        justifyContent: "space-between",
        borderTop: `4px solid ${tone}`,
      }}
    >
      <span style={{ fontSize: 12, letterSpacing: "0.3em", fontWeight: 700, color: "#8A9678" }}>
        {label}
      </span>
      <span style={{ fontSize: 76, lineHeight: 0.9, fontWeight: 900, letterSpacing: "-0.04em", color: tone }}>
        {value}
      </span>
    </div>
  );
}

function Week({ label, now, prev }: { label: string; now: number; prev: number }) {
  const up = now >= prev;
  const delta = now - prev;
  return (
    <div style={{ background: PANEL, borderRadius: 20, padding: "18px 20px" }}>
      <div style={{ fontSize: 11, letterSpacing: "0.28em", fontWeight: 700, color: "#8A9678" }}>
        {label} · WK
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 6 }}>
        <span style={{ fontSize: 44, fontWeight: 900, color: CREAM, lineHeight: 1, letterSpacing: "-0.03em" }}>
          {now}
        </span>
        <span style={{ fontSize: 16, fontWeight: 700, color: up ? LIME : BRONZE }}>
          {up ? "▲" : "▼"} {Math.abs(delta)}
        </span>
      </div>
      <div style={{ fontSize: 12, color: "#6E7A5E", marginTop: 4, letterSpacing: "0.06em" }}>
        last week {prev}
      </div>
    </div>
  );
}

function Legend({ swatch, label, n }: { swatch: string; label: string; n: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
      <span style={{ width: 12, height: 12, borderRadius: 3, background: swatch }} />
      <span style={{ fontSize: 12, letterSpacing: "0.16em", fontWeight: 700, color: "#8A9678" }}>
        {label}
      </span>
      <span style={{ fontSize: 16, fontWeight: 900, color: CREAM }}>{n}</span>
    </div>
  );
}
