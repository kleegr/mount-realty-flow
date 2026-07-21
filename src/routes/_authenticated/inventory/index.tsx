import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getInventoryTree, syncUnitDetails, syncUnitInterestChunk, type UnitDetailProps } from "@/lib/inventory-view.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useEffect, useMemo, useRef, useState } from "react";
import { Building2, ChevronRight, Flame, FolderOpen, Home, RefreshCw, Search, UserRound, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/inventory/")({
  component: InventoryPage,
});

/**
 * INVENTORY - a clean, read-only catalog of Projects > Buildings > Units,
 * with full unit details and live interest on every unit (who it's suggested
 * to, who holds it), each name linking straight into the CRM. Data refreshes
 * itself automatically when it's stale; nothing here writes anything.
 */

type Tree = Awaited<ReturnType<ReturnType<typeof useServerFn<typeof getInventoryTree>>>>;

const STAGE_STYLE: Record<string, string> = {
  Available: "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Reserved/Locked": "bg-amber-50 text-amber-700 border-amber-200",
  "Under Contract": "bg-sky-50 text-sky-700 border-sky-200",
  "Closed/Sold": "bg-slate-100 text-slate-600 border-slate-200",
};
const STAGES = ["Available", "Reserved/Locked", "Under Contract", "Closed/Sold"] as const;

const SYNC_STALE_MS = 30 * 60 * 1000;

function stripPrefix(name: string, parent?: string): string {
  let s = name;
  if (parent && s.startsWith(parent + " - ")) s = s.slice(parent.length + 3);
  const parts = s.split(" ");
  const half = parts.length / 2;
  if (Number.isInteger(half) && half > 0 && parts.slice(0, half).join(" ") === parts.slice(half).join(" ")) {
    s = parts.slice(0, half).join(" ");
  }
  return s;
}

/** The CRM this app is embedded in (whitelabel-aware via the iframe referrer). */
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

function contactUrl(locationId: string, contactId: string): string {
  return `${crmBase()}/v2/location/${locationId}/contacts/detail/${contactId}`;
}
/**
 * GHL's official deep-link for one opportunity (changelog "Dynamic routing
 * for the Opportunities modal"): the id is a PATH segment plus
 * ?tab=OpportunityDetails - a query-param form only opens the board.
 */
function opportunityUrl(locationId: string, oppId: string): string {
  return `${crmBase()}/v2/location/${locationId}/opportunities/list/${oppId}?tab=OpportunityDetails`;
}

function money(n: number): string {
  return `$${Math.round(n).toLocaleString("en-US")}`;
}
function detailLine(d: UnitDetailProps | null): string {
  if (!d) return "";
  const parts: string[] = [];
  if (d.rooms) parts.push(`${d.rooms} rm`);
  if (d.bedrooms) parts.push(`${d.bedrooms} bd`);
  if (d.sf) parts.push(`${Math.round(d.sf).toLocaleString("en-US")} SF`);
  if (d.price) parts.push(money(d.price));
  else if (d.psf) parts.push(`${money(d.psf)}/SF`);
  if (d.style) parts.push(d.style);
  if (d.floor) parts.push(`Fl ${d.floor}`);
  return parts.join(" · ");
}

function InventoryPage() {
  const treeFn = useServerFn(getInventoryTree);
  const detailsFn = useServerFn(syncUnitDetails);
  const chunkFn = useServerFn(syncUnitInterestChunk);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["inventory-tree"], queryFn: () => treeFn() });

  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState<string | null>(null);
  const [view, setView] = useState<"browse" | "top">("browse");
  const [stageFilter, setStageFilter] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<"default" | "interest" | "priceDesc" | "priceAsc">("default");
  const autoRan = useRef(false);

  async function refresh(label: string) {
    setSyncing(label);
    try {
      await detailsFn().catch(() => undefined);
      let offset = 0;
      for (;;) {
        const r = await chunkFn({ data: { offset } });
        const done = Math.min(r.total - r.remaining, r.total);
        setSyncing(`Syncing deals ${done}/${r.total}…`);
        if (r.remaining <= 0 || r.processed === 0) break;
        offset = r.nextOffset;
      }
      await qc.invalidateQueries({ queryKey: ["inventory-tree"] });
    } finally {
      setSyncing(null);
    }
  }

  // Keep itself fresh: sync automatically on first load when data is missing
  // or older than 30 minutes.
  useEffect(() => {
    if (!data || autoRan.current || syncing) return;
    const stale = !data.lastSyncedAt || Date.now() - new Date(data.lastSyncedAt).getTime() > SYNC_STALE_MS;
    if (stale) {
      autoRan.current = true;
      void refresh("Updating from CRM…");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  const model = useMemo(() => buildModel(data, q, stageFilter, sortMode), [data, q, stageFilter, sortMode]);
  const searching = q.trim().length > 0;

  function toggleStage(s: string) {
    setStageFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
          <p className="mt-1 text-muted-foreground">
            Every project, building and unit — details, who's interested and who's serious. Read-only.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.lastSyncedAt && !syncing && (
            <span className="text-xs text-muted-foreground">Synced {timeAgo(data.lastSyncedAt)}</span>
          )}
          <Button variant="outline" size="sm" onClick={() => refresh("Updating from CRM…")} disabled={!!syncing}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", syncing && "animate-spin")} />
            {syncing ?? "Refresh"}
          </Button>
        </div>
      </div>

      {/* Summary / stage filters */}
      {model && (
        <div className="flex flex-wrap items-center gap-2">
          <StatChip icon={FolderOpen} label="Projects" value={model.totals.projects} />
          <StatChip icon={Building2} label="Buildings" value={model.totals.buildings} />
          <StatChip icon={Home} label="Units" value={model.totals.units} />
          <span className="mx-1 hidden w-px self-stretch bg-border sm:block" />
          {STAGES.map((label) => {
            const n = model.totals.byStage[label] ?? 0;
            const active = stageFilter.has(label);
            return (
              <button
                key={label}
                onClick={() => toggleStage(label)}
                title={active ? "Clear filter" : `Show only ${label}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-shadow",
                  STAGE_STYLE[label],
                  active && "ring-2 ring-primary/40",
                )}
              >
                {label}
                <span className="font-bold">{n}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Search + view + sort */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-64 flex-1 sm:max-w-xl">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search projects, buildings, units or customer names…"
            className="pl-9"
          />
        </div>
        <div className="inline-flex overflow-hidden rounded-md border">
          <button
            className={cn("px-3 py-1.5 text-sm font-medium", view === "browse" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground")}
            onClick={() => setView("browse")}
          >
            Browse
          </button>
          <button
            className={cn("inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium", view === "top" ? "bg-primary text-primary-foreground" : "bg-card text-muted-foreground hover:text-foreground")}
            onClick={() => setView("top")}
          >
            <Flame className="h-3.5 w-3.5" /> Top interest
          </button>
        </div>
        {view === "browse" && (
          <select
            value={sortMode}
            onChange={(e) => setSortMode(e.target.value as typeof sortMode)}
            className="h-9 rounded-md border bg-card px-2 text-sm text-foreground"
          >
            <option value="default">Sort: A–Z</option>
            <option value="interest">Sort: Most interested</option>
            <option value="priceDesc">Sort: Price high → low</option>
            <option value="priceAsc">Sort: Price low → high</option>
          </select>
        )}
      </div>

      {isLoading && <p className="py-10 text-center text-muted-foreground">Loading inventory…</p>}

      {model && view === "top" && <TopInterest model={model} locationId={data?.locationId ?? ""} />}

      {model && view === "browse" && model.projects.length === 0 && (
        <p className="py-10 text-center text-muted-foreground">Nothing matches.</p>
      )}

      {view === "browse" &&
        model?.projects.map((p) => {
          const expanded = searching || open[p.id];
          return (
            <Card key={p.id} className="overflow-hidden transition-shadow hover:shadow-md">
              <button
                className="flex w-full items-center gap-3 px-4 py-3 text-left"
                onClick={() => setOpen((o) => ({ ...o, [p.id]: !o[p.id] }))}
              >
                <ChevronRight className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", expanded && "rotate-90")} />
                <FolderOpen className="h-4 w-4 shrink-0 text-accent" />
                <span className="flex-1 truncate text-base font-semibold">{p.name}</span>
                <StageDots counts={p.counts} />
                <Badge variant="outline" className="shrink-0">{p.unitCount} units</Badge>
              </button>

              {expanded && (
                <CardContent className="space-y-3 border-t bg-secondary/20 px-4 pb-4 pt-3">
                  {p.buildings.map((b) => {
                    const bOpen = searching || open[b.id];
                    return (
                      <div key={b.id} className="overflow-hidden rounded-lg border bg-card">
                        <button
                          className="flex w-full items-center gap-2.5 px-3 py-2.5 text-left"
                          onClick={() => setOpen((o) => ({ ...o, [b.id]: !o[b.id] }))}
                        >
                          <ChevronRight className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", bOpen && "rotate-90")} />
                          <Building2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                          <span className="flex-1 truncate text-sm font-medium">{b.label}</span>
                          <StageDots counts={b.counts} />
                          <span className="shrink-0 text-xs text-muted-foreground">{b.units.length} units</span>
                        </button>

                        {bOpen && (
                          <div className="divide-y border-t">
                            {b.units.map((u) => (
                              <UnitRow key={u.id} u={u} locationId={data?.locationId ?? ""} />
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </CardContent>
              )}
            </Card>
          );
        })}
    </div>
  );
}

function PersonChips({ u, locationId, showEmpty = true }: { u: UnitVM; locationId: string; showEmpty?: boolean }) {
  return (
    <>
      {u.holder && (
        <a
          href={opportunityUrl(locationId, u.holder.oppId)}
          target="_top"
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10"
          title={`${u.holder.name ?? u.holder.oppName ?? "Deal"} — ${u.holder.stageName ?? u.stage} (open in CRM)`}
        >
          <Lock className="h-3 w-3" />
          {u.holder.name ?? u.holder.oppName ?? "View deal"}
          <span className="font-normal text-primary/70">· {u.holder.stageName ?? u.stage ?? "held"}</span>
        </a>
      )}
      {u.interested.length > 0 && (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {u.interested.length} interested
          </span>
          {u.interested.map((i) => (
            <a
              key={i.oppId}
              href={i.contactId ? contactUrl(locationId, i.contactId) : opportunityUrl(locationId, i.oppId)}
              target="_top"
              className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-800 hover:bg-amber-100"
              title="Open in CRM"
            >
              <UserRound className="h-3 w-3" />
              {i.name ?? i.oppName ?? "View"}
            </a>
          ))}
        </span>
      )}
      {showEmpty && !u.holder && u.interested.length === 0 && (
        <span className="text-[11px] text-muted-foreground/50">no interest yet</span>
      )}
    </>
  );
}

function UnitRow({ u, locationId }: { u: UnitVM; locationId: string }) {
  const stageCls = STAGE_STYLE[u.stage] ?? "bg-secondary text-muted-foreground border-border";
  const details = detailLine(u.details);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
      <Home className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      <span className="min-w-16 text-sm font-medium">{u.label}</span>
      <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", stageCls)}>
        {u.stage || u.availability || "—"}
      </span>
      {details && <span className="text-xs text-muted-foreground">{details}</span>}
      <span className="flex-1" />
      <PersonChips u={u} locationId={locationId} />
    </div>
  );
}

function TopInterest({ model, locationId }: { model: Model; locationId: string }) {
  const ranked = model.allUnits
    .filter((u) => u.interested.length > 0 || u.holder)
    .sort((a, b) => b.interested.length - a.interested.length || (b.holder ? 1 : 0) - (a.holder ? 1 : 0));
  if (ranked.length === 0) {
    return <p className="py-10 text-center text-muted-foreground">No interest recorded yet — hit Refresh.</p>;
  }
  return (
    <Card>
      <CardContent className="divide-y p-0">
        {ranked.map((u, idx) => (
          <div key={u.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-3">
            <span className="w-6 shrink-0 text-center text-sm font-bold text-muted-foreground">{idx + 1}</span>
            <div className="min-w-40">
              <div className="text-sm font-semibold">{u.label}</div>
              <div className="text-xs text-muted-foreground">{u.crumb}</div>
            </div>
            <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", STAGE_STYLE[u.stage] ?? "bg-secondary text-muted-foreground border-border")}>
              {u.stage || u.availability || "—"}
            </span>
            {detailLine(u.details) && <span className="text-xs text-muted-foreground">{detailLine(u.details)}</span>}
            <span className="flex-1" />
            <PersonChips u={u} locationId={locationId} showEmpty={false} />
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function StageDots({ counts }: { counts: Counts }) {
  const dots: Array<[number, string, string]> = [
    [counts.available, "bg-emerald-500", "Available"],
    [counts.reserved, "bg-amber-500", "Reserved/Locked"],
    [counts.underContract, "bg-sky-500", "Under Contract"],
    [counts.sold, "bg-slate-400", "Closed/Sold"],
  ];
  return (
    <span className="hidden shrink-0 items-center gap-2 sm:inline-flex">
      {dots
        .filter(([n]) => n > 0)
        .map(([n, cls, label]) => (
          <span key={label} className="inline-flex items-center gap-1 text-xs text-muted-foreground" title={label}>
            <span className={cn("h-2 w-2 rounded-full", cls)} />
            {n}
          </span>
        ))}
    </span>
  );
}

function StatChip({ icon: Icon, label, value }: { icon: typeof Home; label: string; value: number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border bg-card px-3 py-1 text-xs font-medium text-foreground">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      {label}
      <span className="font-bold">{value}</span>
    </span>
  );
}

function timeAgo(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const h = Math.round(mins / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// ---------------------------------------------------------------- view model

interface Counts {
  available: number;
  reserved: number;
  underContract: number;
  sold: number;
}
interface Person {
  oppId: string;
  name: string | null;
  oppName: string | null;
  contactId: string | null;
  stageName: string | null;
}
interface UnitVM {
  id: string;
  label: string;
  crumb: string;
  stage: string;
  availability: string;
  details: UnitDetailProps | null;
  holder: Person | null;
  interested: Person[];
}
interface Model {
  projects: Array<{
    id: string;
    name: string;
    unitCount: number;
    counts: Counts;
    buildings: Array<{ id: string; label: string; counts: Counts; units: UnitVM[] }>;
  }>;
  allUnits: UnitVM[];
  totals: { projects: number; buildings: number; units: number; byStage: Record<string, number> };
}

function emptyCounts(): Counts {
  return { available: 0, reserved: 0, underContract: 0, sold: 0 };
}
function bucketOf(stage: string, availability: string): (typeof STAGES)[number] | null {
  if (stage === "Reserved/Locked") return "Reserved/Locked";
  if (stage === "Under Contract") return "Under Contract";
  if (stage === "Closed/Sold") return "Closed/Sold";
  if (stage === "Available" || availability === "Available") return "Available";
  return null;
}
function bump(c: Counts, bucket: string | null) {
  if (bucket === "Available") c.available++;
  else if (bucket === "Reserved/Locked") c.reserved++;
  else if (bucket === "Under Contract") c.underContract++;
  else if (bucket === "Closed/Sold") c.sold++;
}

function interestScore(u: UnitVM): number {
  return u.interested.length * 10 + (u.holder ? 1 : 0);
}

function buildModel(
  data: Tree | undefined,
  q: string,
  stageFilter: Set<string>,
  sortMode: "default" | "interest" | "priceDesc" | "priceAsc",
): Model | null {
  if (!data) return null;
  const needle = q.trim().toLowerCase();

  const byUnit = new Map<string, { holder: Person | null; interested: Person[] }>();
  for (const i of data.interest) {
    const slot = byUnit.get(i.unitId) ?? { holder: null, interested: [] };
    const person: Person = { oppId: i.oppId, name: i.contactName, oppName: i.oppName, contactId: i.contactId, stageName: i.stageName };
    if (i.kind === "locked") slot.holder = person;
    else if (!slot.interested.some((p) => p.oppId === i.oppId)) slot.interested.push(person);
    byUnit.set(i.unitId, slot);
  }

  const totals = { projects: 0, buildings: 0, units: 0, byStage: {} as Record<string, number> };
  const projectsOut: Model["projects"] = [];
  const allUnits: UnitVM[] = [];

  const buildingsByProject = new Map<string | null, typeof data.buildings>();
  for (const b of data.buildings) {
    const arr = buildingsByProject.get(b.projectId) ?? [];
    arr.push(b);
    buildingsByProject.set(b.projectId, arr);
  }
  const unitsByBuilding = new Map<string | null, typeof data.units>();
  for (const u of data.units) {
    const arr = unitsByBuilding.get(u.buildingId) ?? [];
    arr.push(u);
    unitsByBuilding.set(u.buildingId, arr);
  }

  const projectList = [...data.projects, { id: "__none__", name: "Unassigned" }];
  for (const p of projectList) {
    const pKey = p.id === "__none__" ? null : p.id;
    const bs = buildingsByProject.get(pKey) ?? [];
    const looseUnits = p.id === "__none__" ? (unitsByBuilding.get(null) ?? []) : [];
    if (bs.length === 0 && looseUnits.length === 0) continue;

    const pMatch = !needle || p.name.toLowerCase().includes(needle);
    const pCounts = emptyCounts();
    let pUnits = 0;
    const bOut: Model["projects"][number]["buildings"] = [];

    const buildingEntries = [
      ...bs.map((b) => ({ id: b.id, name: b.name, label: stripPrefix(b.name, p.name), units: unitsByBuilding.get(b.id) ?? [] })),
      ...(looseUnits.length > 0 ? [{ id: "__loose__", name: "No building", label: "No building", units: looseUnits }] : []),
    ];

    for (const b of buildingEntries) {
      const bMatch = pMatch || b.label.toLowerCase().includes(needle) || b.name.toLowerCase().includes(needle);
      const bCounts = emptyCounts();
      const uOut: UnitVM[] = [];
      for (const u of b.units) {
        const ints = byUnit.get(u.id) ?? { holder: null, interested: [] };
        // The local hold is a fallback when the deal walk hasn't run yet.
        const holder = ints.holder ?? (u.heldBy ? { oppId: u.heldBy, name: null, oppName: null, contactId: null, stageName: null } : null);
        const label = stripPrefix(u.name, b.name);
        const bucket = bucketOf(u.stage, u.availability);
        if (stageFilter.size > 0 && (!bucket || !stageFilter.has(bucket))) continue;
        const hay = [label, holder?.name ?? "", holder?.oppName ?? "", ...ints.interested.flatMap((x) => [x.name ?? "", x.oppName ?? ""])]
          .join(" ")
          .toLowerCase();
        if (needle && !bMatch && !hay.includes(needle)) continue;
        bump(bCounts, bucket);
        if (bucket) totals.byStage[bucket] = (totals.byStage[bucket] ?? 0) + 1;
        const vm: UnitVM = {
          id: u.id,
          label,
          crumb: p.id === "__none__" ? "Unassigned" : `${p.name} · ${b.label}`,
          stage: u.stage,
          availability: u.availability,
          details: u.details,
          holder,
          interested: ints.interested,
        };
        uOut.push(vm);
        allUnits.push(vm);
      }
      if (uOut.length === 0) continue;

      if (sortMode === "interest") uOut.sort((a, x) => interestScore(x) - interestScore(a));
      else if (sortMode === "priceDesc") uOut.sort((a, x) => (x.details?.price ?? -1) - (a.details?.price ?? -1));
      else if (sortMode === "priceAsc") uOut.sort((a, x) => (a.details?.price ?? Number.MAX_SAFE_INTEGER) - (x.details?.price ?? Number.MAX_SAFE_INTEGER));

      pCounts.available += bCounts.available;
      pCounts.reserved += bCounts.reserved;
      pCounts.underContract += bCounts.underContract;
      pCounts.sold += bCounts.sold;
      pUnits += uOut.length;
      bOut.push({ id: b.id, label: b.label, counts: bCounts, units: uOut });
    }

    if (bOut.length === 0) continue;
    if (sortMode === "interest") {
      bOut.sort((a, x) => x.units.reduce((n, u) => n + interestScore(u), 0) - a.units.reduce((n, u) => n + interestScore(u), 0));
    }

    totals.projects++;
    totals.buildings += bOut.length;
    totals.units += pUnits;
    projectsOut.push({ id: p.id, name: p.name, unitCount: pUnits, counts: pCounts, buildings: bOut });
  }

  if (sortMode === "interest") {
    projectsOut.sort(
      (a, x) =>
        x.buildings.reduce((n, b) => n + b.units.reduce((m, u) => m + interestScore(u), 0), 0) -
        a.buildings.reduce((n, b) => n + b.units.reduce((m, u) => m + interestScore(u), 0), 0),
    );
  }

  return { projects: projectsOut, allUnits, totals };
}
