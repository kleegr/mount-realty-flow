import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * WALL MONITOR — pass 6.
 *
 * Editorial, not a card grid: one cinematic ground, hairline rules, controlled
 * asymmetry. Three columns — the dominant figure, a live unit roll, and a
 * stats rail.
 *
 * WHY THE UNIT ROLL EXISTS: the centre used to be dead space holding a Yiddish
 * line. A wall monitor's job is to answer "what's actually moving" from across
 * the room, so the middle now carries the inventory itself, rolling bottom-to-
 * top with a status flag per unit. It's the only element that earns continuous
 * motion.
 *
 * THE BANNER: this screen is not an advertisement — the team already knows the
 * phone number. So the chartreuse panel carries an hourly broker saying instead
 * of a contact block. Keyed to the clock hour, so it changes on its own and the
 * room isn't staring at the same line all day. Deliberately unattributed —
 * putting a real person's name on a sales aphorism invents a quote.
 *
 * TYPOGRAPHY NOTE: the hero figure runs line-height .74 at up to 300px, so its
 * glyph box overflows upward and collided with the label above it. Fixed by
 * reserving the overflow with padding rather than nudging margins.
 *
 * PALETTE (per brief): chartreuse, deep olive, black, warm ivory; gold for
 * warm-light accents. No blue — the navy in the Diligent ad is Diligent's logo
 * colour, not Mount's.
 *
 * ASSETS — optional; swap in the moment the file exists:
 *   /public/mount-logo.svg  the wordmark (custom lettering; no font has that M)
 *   /public/mount-hero.jpg  the architectural hero. Without it the ground falls
 *                           back to lit olive — handsome, but the photograph IS
 *                           the cinematic concept.
 *
 * Top-level route on purpose — _authenticated wraps every page in the AppShell
 * ribbon. The PIN still gates it via beforeLoad.
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

type Status = "AVAILABLE" | "RESERVED" | "UNDER CONTRACT" | "SOLD";

const STATUS_TONE: Record<Status, string> = {
  AVAILABLE: LIME,
  RESERVED: GOLD,
  "UNDER CONTRACT": SAGE,
  SOLD: IVORY,
};

/** Unattributed on purpose — naming a real broker would invent a quote. */
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
];

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
  units: [
    { unit: "UNIT 102", building: "8 UNIT BUILDING C1", status: "UNDER CONTRACT" as Status },
    { unit: "UNIT 101", building: "8 UNIT BUILDING C2", status: "UNDER CONTRACT" as Status },
    { unit: "UNIT 102", building: "8 UNIT BUILDING C3", status: "AVAILABLE" as Status },
    { unit: "UNIT 101", building: "8 UNIT BUILDING C4", status: "AVAILABLE" as Status },
    { unit: "UNIT 102", building: "28 DUELK", status: "SOLD" as Status },
    { unit: "UNIT 102", building: "51 FORT WORTH", status: "RESERVED" as Status },
    { unit: "UNIT 205", building: "DILIGENT GARDENS", status: "UNDER CONTRACT" as Status },
    { unit: "UNIT 202", building: "1 SAN MARCOS", status: "UNDER CONTRACT" as Status },
    { unit: "UNIT 101", building: "MANGIN ROAD", status: "RESERVED" as Status },
    { unit: "UNIT 103", building: "OLD TOWN", status: "AVAILABLE" as Status },
    { unit: "UNIT 101", building: "57 FORT WORTH", status: "UNDER CONTRACT" as Status },
    { unit: "UNIT 204", building: "DALLAS DRIVE", status: "AVAILABLE" as Status },
    { unit: "UNIT 101", building: "61 FORT WORTH", status: "UNDER CONTRACT" as Status },
    { unit: "UNIT 202", building: "1 SAN MARCOS", status: "AVAILABLE" as Status },
    { unit: "UNIT 101", building: "8 UNIT BUILDING C5", status: "AVAILABLE" as Status },
    { unit: "UNIT 102", building: "8 UNIT BUILDING CC", status: "UNDER CONTRACT" as Status },
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
  const saying = SAYINGS[now.getHours() % SAYINGS.length];

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
        @keyframes wIn { from { opacity: 0; transform: translateY(12px) } to { opacity: 1; transform: none } }
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
          height: 78,
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
        </div>
      </header>

      {/* ---------------- body: figure | roll | rail ---------------- */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "1.25fr 0.92fr 1fr",
          gap: 44,
          padding: "0 56px 18px",
        }}
      >
        {/* --- the figure --- */}
        <section style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", animation: "wIn .6s both" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.52em", fontWeight: 700, color: LIME }}>
            AVAILABLE NOW
          </div>
          <div style={{ fontSize: 10, letterSpacing: "0.34em", fontWeight: 600, color: SAGE, marginTop: 6 }}>
            BLOOMING GROVE · KIRYAS YOEL
          </div>

          {/* paddingTop reserves the space the .74 line-height glyph overflows into */}
          <div style={{ display: "flex", alignItems: "flex-start", gap: 26, paddingTop: 26 }}>
            <span
              style={{
                fontFamily: DISPLAY,
                fontSize: "clamp(110px, 24vh, 260px)",
                lineHeight: 0.74,
                letterSpacing: "-0.045em",
                color: IVORY,
                textShadow: hasHero ? "0 8px 60px rgba(0,0,0,.55)" : "none",
              }}
            >
              {SAMPLE.available}
            </span>
            <div style={{ paddingTop: 6 }}>
              <div style={{ fontFamily: DISPLAY, fontSize: 30, color: LIME, lineHeight: 1 }}>{TOTAL}</div>
              <div style={{ fontSize: 9, letterSpacing: "0.34em", fontWeight: 700, color: SAGE, marginTop: 4 }}>
                TOTAL UNITS
              </div>
              <div style={{ width: 30, height: 1, background: "rgba(244,241,228,.28)", margin: "12px 0" }} />
              <div style={{ fontFamily: DISPLAY, fontSize: 30, color: IVORY, lineHeight: 1 }}>
                {Math.round((SAMPLE.available / TOTAL) * 100)}%
              </div>
              <div style={{ fontSize: 9, letterSpacing: "0.34em", fontWeight: 700, color: SAGE, marginTop: 4 }}>
                OF PORTFOLIO
              </div>
            </div>
          </div>

          <div style={{ display: "flex", height: 6, marginTop: 26, borderRadius: 999, overflow: "hidden", background: "rgba(244,241,228,.14)" }}>
            <div className="grow" style={{ width: `${(SAMPLE.available / TOTAL) * 100}%`, background: LIME }} />
            <div className="grow" style={{ width: `${(SAMPLE.reserved / TOTAL) * 100}%`, background: GOLD }} />
            <div className="grow" style={{ width: `${(SAMPLE.underContract / TOTAL) * 100}%`, background: SAGE }} />
            <div className="grow" style={{ width: `${(SAMPLE.sold / TOTAL) * 100}%`, background: IVORY }} />
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
            padding: "22px 30px 0",
            minHeight: 0,
          }}
        >
          <div style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE, flexShrink: 0 }}>
            THE BOARD
          </div>

          <div className="rollMask" style={{ flex: 1, overflow: "hidden", marginTop: 14, minHeight: 0 }}>
            <div className="roll">
              {[0, 1].map((dup) => (
                <div key={dup}>
                  {SAMPLE.units.map((u, i) => (
                    <UnitRow key={`${dup}-${i}`} unit={u.unit} building={u.building} status={u.status} />
                  ))}
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* --- the rail --- */}
        <section style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <Line label="RESERVED" value={SAMPLE.reserved} tone={GOLD} />
          <Line label="UNDER CONTRACT" value={SAMPLE.underContract} tone={SAGE} />
          <Line label="SOLD" value={SAMPLE.sold} tone={IVORY} note={`${SAMPLE.week.sold} this week · ${SAMPLE.week.prevSold} last`} />

          <div style={{ height: 1, background: "rgba(244,241,228,.16)", margin: "20px 0" }} />

          <div style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE }}>CONTRACTED VOLUME</div>
          <div style={{ fontFamily: DISPLAY, fontSize: "clamp(40px, 6.4vh, 68px)", color: LIME, lineHeight: 0.95, letterSpacing: "-0.02em", marginTop: 6 }}>
            {money(SAMPLE.contractedVolume)}
          </div>

          <div style={{ height: 1, background: "rgba(244,241,228,.16)", margin: "20px 0" }} />

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
              <span style={{ fontFamily: DISPLAY, fontSize: 23, color: IVORY, lineHeight: 1.15 }}>{p.name}</span>
            </div>
            <div style={{ display: "flex", height: 6, marginTop: 12, borderRadius: 999, overflow: "hidden", background: "rgba(244,241,228,.14)" }}>
              <div className="grow" style={{ width: `${(pAvail / p.total) * 100}%`, background: LIME }} />
              <div className="grow" style={{ width: `${(p.res / p.total) * 100}%`, background: GOLD }} />
              <div className="grow" style={{ width: `${(p.uc / p.total) * 100}%`, background: SAGE }} />
              <div className="grow" style={{ width: `${(p.sold / p.total) * 100}%`, background: IVORY }} />
            </div>
            <div style={{ display: "flex", gap: 16, marginTop: 10 }}>
              <Legend swatch={LIME} label="AVAIL" n={pAvail} />
              <Legend swatch={GOLD} label="RES" n={p.res} />
              <Legend swatch={SAGE} label="CONTRACT" n={p.uc} />
            </div>
          </div>
        </section>
      </main>

      {/* ---------------- chartreuse banner: the hour's saying ---------------- */}
      <footer
        style={{
          background: LIME,
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          gap: 28,
          padding: "18px 56px",
        }}
      >
        <span style={{ fontSize: 9, letterSpacing: "0.46em", fontWeight: 700, color: ON_LIME, whiteSpace: "nowrap" }}>
          THIS HOUR
        </span>
        <span style={{ width: 1, height: 26, background: "rgba(46,54,11,.30)", flexShrink: 0 }} />
        <span
          style={{
            fontFamily: DISPLAY,
            fontSize: "clamp(20px, 3.2vh, 34px)",
            color: INK,
            letterSpacing: "0.01em",
            lineHeight: 1.1,
          }}
        >
          {saying}
        </span>
      </footer>
    </div>
  );
}

function UnitRow({ unit, building, status }: { unit: string; building: string; status: Status }) {
  const tone = STATUS_TONE[status];
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: "11px 0",
        borderBottom: "1px solid rgba(244,241,228,.08)",
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontFamily: DISPLAY, fontSize: 17, color: IVORY, lineHeight: 1.1, letterSpacing: "0.01em" }}>
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
      <div style={{ display: "flex", alignItems: "center", gap: 7, flexShrink: 0 }}>
        <span style={{ width: 7, height: 7, borderRadius: 2, background: tone }} />
        <span style={{ fontSize: 8, letterSpacing: "0.2em", fontWeight: 700, color: tone, whiteSpace: "nowrap" }}>
          {status}
        </span>
      </div>
    </div>
  );
}

function Line({ label, value, tone, note }: { label: string; value: number; tone: string; note?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 16, padding: "8px 0" }}>
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
      <span style={{ fontFamily: DISPLAY, fontSize: "clamp(28px, 4.4vh, 46px)", color: tone, lineHeight: 1, letterSpacing: "-0.02em" }}>
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
