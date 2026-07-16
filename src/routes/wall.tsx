import { createFileRoute, redirect } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";

/**
 * WALL MONITOR — pass 7.
 *
 * Editorial, not a card grid: one cinematic ground, hairline rules, controlled
 * asymmetry. Three columns — the dominant figure, a live unit roll, a stats
 * rail — then the activity line and the chartreuse banner.
 *
 * ACTIVITY: state answers "what do we have"; the period row answers "is it
 * moving", which is the question a wall monitor actually exists for. Today /
 * week / month, each against its previous period.
 *
 * NOTE FOR WIRING (concept stage): these come from audit_events, which today
 * only reaches back about a day. THIS MONTH will read near-zero until history
 * accumulates, and wiping inventory for the Lazers import resets it again.
 * The block is correct; it needs time, not code.
 *
 * THE BANNER: this screen is not an advertisement — the team knows its own
 * phone number — so the chartreuse panel carries broker sayings instead. Three
 * per hour, one every 3 seconds; the hour picks the set of three. Deliberately
 * unattributed: putting a real person's name on a sales aphorism invents a
 * quote they never said.
 *
 * TYPOGRAPHY NOTE: the hero figure runs line-height .74, so its glyph box
 * overflows upward and collided with the label above. Fixed by reserving the
 * overflow with padding rather than nudging margins.
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

/**
 * 24 lines = 8 sets of three. The clock hour picks the set; the set cycles one
 * line every 3 seconds. Unattributed on purpose — naming a real broker under a
 * sales aphorism would be inventing a quote.
 */
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

const SAMPLE = {
  available: 181,
  reserved: 8,
  underContract: 177,
  sold: 1,
  contractedVolume: 147_180_000,
  activity: {
    today: { moves: 3, sold: 1, res: 0, uc: 2, prev: 2 },
    week: { moves: 21, sold: 4, res: 6, uc: 11, prev: 15 },
    month: { moves: 64, sold: 9, res: 14, uc: 41, prev: 67 },
  },
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
const SET_COUNT = Math.floor(SAYINGS.length / 3);

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
  const [sayIdx, setSayIdx] = useState(0);
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

  // three sayings an hour, one every three seconds
  useEffect(() => {
    const t = setInterval(() => setSayIdx((i) => (i + 1) % 3), 3000);
    return () => clearInterval(t);
  }, []);

  const p = SAMPLE.projects[spot];
  const pAvail = p.total - p.sold - p.uc - p.res;
  const saying = SAYINGS[(now.getHours() % SET_COUNT) * 3 + sayIdx];

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
        </div>
      </header>

      {/* ---------------- body: figure | roll | rail ---------------- */}
      <main
        style={{
          flex: 1,
          minHeight: 0,
          display: "grid",
          gridTemplateColumns: "1.28fr 0.9fr 1fr",
          gap: 40,
          padding: "0 56px 14px",
        }}
      >
        {/* --- the figure --- */}
        <section style={{ minWidth: 0, display: "flex", flexDirection: "column", justifyContent: "center", animation: "wIn .6s both" }}>
          <div style={{ fontSize: 11, letterSpacing: "0.52em", fontWeight: 700, color: LIME }}>AVAILABLE NOW</div>
          <div style={{ fontSize: 10, letterSpacing: "0.34em", fontWeight: 600, color: SAGE, marginTop: 5 }}>
            BLOOMING GROVE · KIRYAS YOEL
          </div>

          {/* paddingTop reserves the space the .74 line-height glyph overflows into */}
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
              {SAMPLE.available}
            </span>
            <div style={{ paddingTop: 4 }}>
              <div style={{ fontFamily: DISPLAY, fontSize: 27, color: LIME, lineHeight: 1 }}>{TOTAL}</div>
              <div style={{ fontSize: 9, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, marginTop: 4 }}>
                TOTAL UNITS
              </div>
              <div style={{ width: 28, height: 1, background: "rgba(244,241,228,.28)", margin: "11px 0" }} />
              <div style={{ fontFamily: DISPLAY, fontSize: 27, color: IVORY, lineHeight: 1 }}>
                {Math.round((SAMPLE.available / TOTAL) * 100)}%
              </div>
              <div style={{ fontSize: 9, letterSpacing: "0.32em", fontWeight: 700, color: SAGE, marginTop: 4 }}>
                OF PORTFOLIO
              </div>
            </div>
          </div>

          <div style={{ display: "flex", height: 6, marginTop: 20, borderRadius: 999, overflow: "hidden", background: "rgba(244,241,228,.14)" }}>
            <div className="grow" style={{ width: `${(SAMPLE.available / TOTAL) * 100}%`, background: LIME }} />
            <div className="grow" style={{ width: `${(SAMPLE.reserved / TOTAL) * 100}%`, background: GOLD }} />
            <div className="grow" style={{ width: `${(SAMPLE.underContract / TOTAL) * 100}%`, background: SAGE }} />
            <div className="grow" style={{ width: `${(SAMPLE.sold / TOTAL) * 100}%`, background: IVORY }} />
          </div>

          {/* --- movement --- */}
          <div
            style={{
              display: "flex",
              alignItems: "stretch",
              marginTop: 22,
              paddingTop: 16,
              borderTop: "1px solid rgba(244,241,228,.16)",
            }}
          >
            <Period label="TODAY" a={SAMPLE.activity.today} against="YESTERDAY" />
            <Rule />
            <Period label="THIS WEEK" a={SAMPLE.activity.week} against="LAST WEEK" />
            <Rule />
            <Period label="THIS MONTH" a={SAMPLE.activity.month} against="LAST MONTH" />
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
          <Line label="SOLD" value={SAMPLE.sold} tone={IVORY} />

          <div style={{ height: 1, background: "rgba(244,241,228,.16)", margin: "18px 0" }} />

          <div style={{ fontSize: 9, letterSpacing: "0.42em", fontWeight: 700, color: SAGE }}>CONTRACTED VOLUME</div>
          <div style={{ fontFamily: DISPLAY, fontSize: "clamp(38px, 5.8vh, 62px)", color: LIME, lineHeight: 0.95, letterSpacing: "-0.02em", marginTop: 5 }}>
            {money(SAMPLE.contractedVolume)}
          </div>

          <div style={{ height: 1, background: "rgba(244,241,228,.16)", margin: "18px 0" }} />

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

          <div key={spot} style={{ animation: "wIn .6s both", marginTop: 11 }}>
            <div style={{ display: "inline-flex", flexDirection: "column", background: INK, padding: "7px 15px", borderRadius: 4 }}>
              <span style={{ fontSize: 8, letterSpacing: "0.38em", color: SAGE, fontWeight: 700 }}>PROJECT</span>
              <span style={{ fontFamily: DISPLAY, fontSize: 22, color: IVORY, lineHeight: 1.15 }}>{p.name}</span>
            </div>
            <div style={{ display: "flex", height: 6, marginTop: 11, borderRadius: 999, overflow: "hidden", background: "rgba(244,241,228,.14)" }}>
              <div className="grow" style={{ width: `${(pAvail / p.total) * 100}%`, background: LIME }} />
              <div className="grow" style={{ width: `${(p.res / p.total) * 100}%`, background: GOLD }} />
              <div className="grow" style={{ width: `${(p.uc / p.total) * 100}%`, background: SAGE }} />
              <div className="grow" style={{ width: `${(p.sold / p.total) * 100}%`, background: IVORY }} />
            </div>
            <div style={{ display: "flex", gap: 15, marginTop: 9 }}>
              <Legend swatch={LIME} label="AVAIL" n={pAvail} />
              <Legend swatch={GOLD} label="RES" n={p.res} />
              <Legend swatch={SAGE} label="CONTRACT" n={p.uc} />
            </div>
          </div>
        </section>
      </main>

      {/* ---------------- the tiny banner: live activity ---------------- */}
      <div style={{ overflow: "hidden", padding: "9px 0", flexShrink: 0, borderTop: "1px solid rgba(244,241,228,.12)" }}>
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

      {/* ---------------- chartreuse banner: three sayings an hour ---------------- */}
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

function Rule() {
  return <div style={{ width: 1, background: "rgba(244,241,228,.16)", margin: "0 22px", flexShrink: 0 }} />;
}

function Period({
  label, a, against,
}: {
  label: string;
  a: { moves: number; sold: number; res: number; uc: number; prev: number };
  against: string;
}) {
  const delta = a.moves - a.prev;
  const up = delta >= 0;
  return (
    <div style={{ minWidth: 0, flex: 1 }}>
      <div style={{ fontSize: 9, letterSpacing: "0.36em", fontWeight: 700, color: SAGE }}>{label}</div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 5 }}>
        <span style={{ fontFamily: DISPLAY, fontSize: "clamp(26px, 3.8vh, 40px)", color: IVORY, lineHeight: 1, letterSpacing: "-0.02em" }}>
          {a.moves}
        </span>
        <span style={{ fontSize: 11, fontWeight: 700, color: up ? LIME : GOLD, whiteSpace: "nowrap" }}>
          {up ? "▲" : "▼"}{Math.abs(delta)}
        </span>
      </div>
      <div style={{ fontSize: 8, letterSpacing: "0.16em", color: "rgba(140,154,115,.75)", fontWeight: 600, marginTop: 4, whiteSpace: "nowrap" }}>
        {a.sold} SOLD · {a.res} RES · {a.uc} CONTRACT
      </div>
      <div style={{ fontSize: 8, letterSpacing: "0.16em", color: "rgba(140,154,115,.5)", fontWeight: 600, marginTop: 2, whiteSpace: "nowrap" }}>
        VS {against} {a.prev}
      </div>
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
