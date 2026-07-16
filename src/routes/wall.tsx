import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * WALL MONITOR — campaign direction (pass 5).
 *
 * Built to the Mount campaign brief rather than to dashboard convention:
 *
 *   "Do not place every piece of information inside separate boxes.
 *    The design should feel editorial and intentional."
 *
 * So: no card grid. One cinematic ground, one dominant figure, hairline rules
 * instead of borders, controlled asymmetry, and a single chartreuse brand panel
 * carrying the contact block — exactly as the printed pieces do.
 *
 * THE ONE ADAPTATION: the brief describes a static advertisement, but this is a
 * live board. Rather than bolt a campaign headline above changing numbers, the
 * NUMBER IS THE HEADLINE — set at campaign scale. It earns the oversized
 * treatment because it is the thing that actually moves.
 *
 * PALETTE (per brief): signature chartreuse, deep olive, black, warm ivory,
 * with gold for warm-light accents. No blue — the navy in the Diligent ad is
 * Diligent's logo colour, not Mount's.
 *
 * YIDDISH: real copy from Mount's own Mega ad — "יעדע סארט אפציע אין
 * בלומינגראוו" (every kind of option in Blooming Grove), which is precisely
 * what an inventory board says. Set in Heebo 800 at display weight with
 * dir="rtl" — a headline, not a caption.
 *
 * ASSETS — optional; swap in the moment the file exists:
 *   /public/mount-logo.svg  the wordmark (custom lettering; no font has that M)
 *   /public/mount-hero.jpg  the architectural hero. Without it the ground falls
 *                           back to deep olive with a warm key light — handsome,
 *                           but NOT the cinematic concept. The photograph is the
 *                           concept.
 *
 * Top-level route on purpose — _authenticated wraps every page in the AppShell
 * ribbon, and a wall monitor with a nav bar is not a wall monitor. The PIN
 * still gates it via beforeLoad.
 *
 * CONCEPT STAGE: sample data using the real Lazers totals (181/8/177/1).
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
const YID = "'Heebo','Noto Sans Hebrew',sans-serif";

const SAMPLE = {
  available: 181,
  reserved: 8,
  underContract: 177,
  sold: 1,
  contractedVolume: 147_180_000,
  week: { sold: 4, prevSold: 2 },
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

function useAsset(src: string) {
  const [ok, setOk] = useState(false);
  useEffect(() => {
    const img = new Image();
    img.onload = () => setOk(true);
    img.src = src;
  }, [src]);
  return ok;
}

function WallMonitor() {
  const [now, setNow] = useState(() => new Date());
  const [spot, setSpot] = useState(0);
  const hasLogo = useAsset("/mount-logo.svg");
  const hasHero = useAsset("/mount-hero.jpg");

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

  const ground = hasHero
    ? "linear-gradient(90deg, rgba(14,17,8,.95) 0%, rgba(14,17,8,.86) 42%, rgba(14,17,8,.52) 100%), url(/mount-hero.jpg)"
    : `radial-gradient(120% 90% at 82% 28%, rgba(201,169,97,.20) 0%, rgba(34,43,21,0) 58%), linear-gradient(180deg, ${OLIVE} 0%, ${INK} 100%)`;

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
        @import url('https://fonts.googleapis.com/css2?family=Anton&family=Archivo:wght@400;500;600;700&family=Heebo:wght@400;700;800;900&display=swap');
        @keyframes wTick { from { transform: translateX(0) } to { transform: translateX(-50%) } }
        @keyframes wIn { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
        @keyframes wDot { 0%,100% { opacity: 1 } 50% { opacity: .18 } }
        .grow { transition: width 1.1s cubic-bezier(.22,1,.36,1) }
      `}</style>

      {/* ---------------- masthead ---------------- */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 60px",
          height: 82,
          flexShrink: 0,
        }}
      >
        {hasLogo ? (
          <img src="/mount-logo.svg" alt="Mount Realty Group" style={{ height: 34 }} />
        ) : (
          <div style={{ display: "flex", alignItems: "baseline", gap: 15 }}>
            <span style={{ fontFamily: DISPLAY, fontSize: 34, letterSpacing: "-0.02em", color: IVORY, lineHeight: 1 }}>
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
        </div>
      </header>

      {/* ---------------- editorial body ---------------- */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "1.5fr 1fr",
          gap: 56,
          padding: "0 60px",
          alignItems: "center",
        }}
      >
        <section style={{ minWidth: 0, animation: "wIn .6s both" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.52em", fontWeight: 700, color: LIME, marginBottom: 4 }}>
            AVAILABLE NOW · BLOOMING GROVE
          </div>

          <div style={{ display: "flex", alignItems: "flex-start", gap: 30 }}>
            <span
              style={{
                fontFamily: DISPLAY,
                fontSize: "clamp(120px, 27vh, 300px)",
                lineHeight: 0.74,
                letterSpacing: "-0.045em",
                color: IVORY,
                textShadow: hasHero ? "0 8px 60px rgba(0,0,0,.55)" : "none",
              }}
            >
              {SAMPLE.available}
            </span>
            <div style={{ paddingTop: 12 }}>
              <div style={{ fontFamily: DISPLAY, fontSize: 34, color: LIME, lineHeight: 1 }}>{TOTAL}</div>
              <div style={{ fontSize: 9, letterSpacing: "0.34em", fontWeight: 700, color: SAGE, marginTop: 5 }}>
                TOTAL UNITS
              </div>
              <div style={{ width: 34, height: 1, background: "rgba(244,241,228,.28)", margin: "14px 0" }} />
              <div style={{ fontFamily: DISPLAY, fontSize: 34, color: IVORY, lineHeight: 1 }}>
                {Math.round((SAMPLE.available / TOTAL) * 100)}%
              </div>
              <div style={{ fontSize: 9, letterSpacing: "0.34em", fontWeight: 700, color: SAGE, marginTop: 5 }}>
                OF PORTFOLIO
              </div>
            </div>
          </div>

          <div
            dir="rtl"
            style={{
              fontFamily: YID,
              fontWeight: 800,
              fontSize: "clamp(26px, 4.2vh, 46px)",
              color: IVORY,
              lineHeight: 1.25,
              marginTop: 18,
              textAlign: "right",
              maxWidth: "88%",
            }}
          >
            יעדע סארט אפציע אין בלומינגראוו
          </div>

          <div style={{ display: "flex", height: 6, marginTop: 22, borderRadius: 999, overflow: "hidden", background: "rgba(244,241,228,.14)" }}>
            <div className="grow" style={{ width: `${(SAMPLE.available / TOTAL) * 100}%`, background: LIME }} />
            <div className="grow" style={{ width: `${(SAMPLE.reserved / TOTAL) * 100}%`, background: GOLD }} />
            <div className="grow" style={{ width: `${(SAMPLE.underContract / TOTAL) * 100}%`, background: SAGE }} />
            <div className="grow" style={{ width: `${(SAMPLE.sold / TOTAL) * 100}%`, background: IVORY }} />
          </div>
        </section>

        <section style={{ minWidth: 0, borderLeft: "1px solid rgba(244,241,228,.16)", paddingLeft: 44 }}>
          <Line label="RESERVED" value={SAMPLE.reserved} tone={GOLD} />
          <Line label="UNDER CONTRACT" value={SAMPLE.underContract} tone={SAGE} />
          <Line label="SOLD" value={SAMPLE.sold} tone={IVORY} note={`${SAMPLE.week.sold} this week · ${SAMPLE.week.prevSold} last`} />

          <div style={{ height: 1, background: "rgba(244,241,228,.16)", margin: "22px 0" }} />

          <div style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE }}>CONTRACTED VOLUME</div>
          <div style={{ fontFamily: DISPLAY, fontSize: "clamp(44px, 7vh, 74px)", color: LIME, lineHeight: 0.95, letterSpacing: "-0.02em", marginTop: 6 }}>
            {money(SAMPLE.contractedVolume)}
          </div>

          <div style={{ height: 1, background: "rgba(244,241,228,.16)", margin: "22px 0" }} />

          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <span style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE }}>SPOTLIGHT</span>
            <div style={{ display: "flex", gap: 4 }}>
              {SAMPLE.projects.map((_, i) => (
                <span
                  key={i}
                  style={{
                    width: i === spot ? 16 : 6,
                    height: 2,
                    borderRadius: 999,
                    background: i === spot ? LIME : "rgba(244,241,228,.24)",
                    transition: "width .4s",
                  }}
                />
              ))}
            </div>
          </div>

          <div key={spot} style={{ animation: "wIn .6s both", marginTop: 12 }}>
            <div style={{ display: "inline-flex", flexDirection: "column", background: INK, padding: "8px 16px", borderRadius: 4 }}>
              <span style={{ fontSize: 8, letterSpacing: "0.38em", color: SAGE, fontWeight: 700 }}>PROJECT</span>
              <span style={{ fontFamily: DISPLAY, fontSize: 24, color: IVORY, lineHeight: 1.15 }}>{p.name}</span>
            </div>
            <div style={{ display: "flex", height: 6, marginTop: 12, borderRadius: 999, overflow: "hidden", background: "rgba(244,241,228,.14)" }}>
              <div className="grow" style={{ width: `${(pAvail / p.total) * 100}%`, background: LIME }} />
              <div className="grow" style={{ width: `${(p.res / p.total) * 100}%`, background: GOLD }} />
              <div className="grow" style={{ width: `${(p.uc / p.total) * 100}%`, background: SAGE }} />
              <div className="grow" style={{ width: `${(p.sold / p.total) * 100}%`, background: IVORY }} />
            </div>
            <div style={{ display: "flex", gap: 18, marginTop: 10 }}>
              <Legend swatch={LIME} label="AVAIL" n={pAvail} />
              <Legend swatch={GOLD} label="RES" n={p.res} />
              <Legend swatch={SAGE} label="CONTRACT" n={p.uc} />
            </div>
          </div>
        </section>
      </main>

      {/* ---------------- activity line ---------------- */}
      <div style={{ overflow: "hidden", padding: "10px 0", flexShrink: 0, borderTop: "1px solid rgba(244,241,228,.12)" }}>
        <div style={{ display: "flex", width: "max-content", animation: "wTick 48s linear infinite" }}>
          {[0, 1].map((dup) => (
            <div key={dup} style={{ display: "flex" }}>
              {SAMPLE.ticker.map((t, i) => (
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

      {/* ---------------- chartreuse brand panel ---------------- */}
      <footer
        style={{
          background: LIME,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 40,
          padding: "16px 60px",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontFamily: DISPLAY, fontSize: 30, color: INK, lineHeight: 1, letterSpacing: "-0.02em" }}>
            MOUNT
          </span>
          <span style={{ fontSize: 8, letterSpacing: "0.5em", color: ON_LIME, fontWeight: 700 }}>REALTY GROUP</span>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 22, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <span dir="rtl" style={{ fontFamily: YID, fontWeight: 700, fontSize: 15, color: INK }}>
            אליעזר יחזקאל שווימער
          </span>
          <span dir="rtl" style={{ fontFamily: YID, fontWeight: 400, fontSize: 12, color: ON_LIME }}>
            אברהם חיים לעווי · יואל לעווי · אברהם קויפמאן
          </span>

          <span style={{ width: 1, height: 26, background: "rgba(46,54,11,.28)" }} />

          <div style={{ textAlign: "right", lineHeight: 1.5 }}>
            <div style={{ fontSize: 17, fontWeight: 700, color: INK, letterSpacing: "0.02em" }}>
              845-45-MOUNT &nbsp; sales@mountrealty.com
            </div>
            <div style={{ fontSize: 10, color: ON_LIME, fontWeight: 600 }}>
              BLOOMING GROVE: 28 MERRIEWOLD LN S, MONROE NY 10950 &nbsp;·&nbsp; WILLIAMSBURG: 146 SPENCER ST, BROOKLYN NY 11205
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Line({ label, value, tone, note }: { label: string; value: number; tone: string; note?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, padding: "9px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
        <span style={{ width: 8, height: 8, borderRadius: 2, background: tone, flexShrink: 0 }} />
        <span style={{ fontSize: 10, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, whiteSpace: "nowrap" }}>
          {label}
        </span>
        {note && (
          <span style={{ fontSize: 9, letterSpacing: "0.1em", color: "rgba(140,154,115,.7)", whiteSpace: "nowrap" }}>
            {note}
          </span>
        )}
      </div>
      <span style={{ fontFamily: DISPLAY, fontSize: "clamp(30px, 4.6vh, 48px)", color: tone, lineHeight: 1, letterSpacing: "-0.02em" }}>
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
      <span style={{ fontFamily: DISPLAY, fontSize: 15, color: IVORY }}>{n}</span>
    </div>
  );
}
