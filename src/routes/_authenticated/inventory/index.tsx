import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { getInventoryTree, syncUnitInterestChunk } from "@/lib/inventory-view.functions";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useMemo, useState } from "react";
import { Building2, ChevronRight, FolderOpen, Home, RefreshCw, Search, UserRound, Lock } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/inventory/")({
  component: InventoryPage,
});

/**
 * INVENTORY - a clean, read-only catalog of Projects > Buildings > Units,
 * with live interest on every unit (who it's suggested to, who holds it),
 * each name linking straight into the CRM. Nothing here writes anything.
 */

type Tree = Awaited<ReturnType<ReturnType<typeof useServerFn<typeof getInventoryTree>>>>;

const STAGE_STYLE: Record<string, string> = {
  Available: "bg-emerald-50 text-emerald-700 border-emerald-200",
  "Reserved/Locked": "bg-amber-50 text-amber-700 border-amber-200",
  "Under Contract": "bg-sky-50 text-sky-700 border-sky-200",
  "Closed/Sold": "bg-slate-100 text-slate-600 border-slate-200",
};

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
function opportunityUrl(locationId: string, oppId: string): string {
  return `${crmBase()}/v2/location/${locationId}/opportunities/list?opportunityId=${oppId}`;
}

function InventoryPage() {
  const treeFn = useServerFn(getInventoryTree);
  const syncFn = useServerFn(syncUnitInterestChunk);
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["inventory-tree"], queryFn: () => treeFn() });

  const [q, setQ] = useState("");
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [syncing, setSyncing] = useState<string | null>(null);

  async function refreshInterest() {
    setSyncing("Starting…");
    try {
      let offset = 0;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const r = await syncFn({ data: { offset } });
        const done = r.total - r.remaining;
        setSyncing(`Syncing deals ${Math.min(done, r.total)}/${r.total}…`);
        if (r.remaining <= 0 || r.processed === 0) break;
        offset = r.nextOffset;
      }
      await qc.invalidateQueries({ queryKey: ["inventory-tree"] });
    } finally {
      setSyncing(null);
    }
  }

  const model = useMemo(() => buildModel(data, q), [data, q]);
  const searching = q.trim().length > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Inventory</h1>
          <p className="mt-1 text-muted-foreground">
            Every project, building and unit — with who's interested and who's serious. Read-only.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {data?.lastSyncedAt && !syncing && (
            <span className="text-xs text-muted-foreground">Interest synced {timeAgo(data.lastSyncedAt)}</span>
          )}
          <Button variant="outline" size="sm" onClick={refreshInterest} disabled={!!syncing}>
            <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", syncing && "animate-spin")} />
            {syncing ?? "Refresh interest"}
          </Button>
        </div>
      </div>

      {/* Summary */}
      {model && (
        <div className="flex flex-wrap gap-2">
          <StatChip icon={FolderOpen} label="Projects" value={model.totals.projects} />
          <StatChip icon={Building2} label="Buildings" value={model.totals.buildings} />
          <StatChip icon={Home} label="Units" value={model.totals.units} />
          <span className="mx-1 hidden w-px self-stretch bg-border sm:block" />
          {(
            [
              ["Available", model.totals.available],
              ["Reserved/Locked", model.totals.reserved],
              ["Under Contract", model.totals.underContract],
              ["Closed/Sold", model.totals.sold],
            ] as const
          ).map(([label, n]) => (
            <span
              key={label}
              className={cn("inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium", STAGE_STYLE[label])}
            >
              {label}
              <span className="font-bold">{n}</span>
            </span>
          ))}
        </div>
      )}

      {/* Search */}
      <div className="relative max-w-xl">
        <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search projects, buildings, units or customer names…"
          className="pl-9"
        />
      </div>

      {isLoading && <p className="py-10 text-center text-muted-foreground">Loading inventory…</p>}

      {model && model.projects.length === 0 && (
        <p className="py-10 text-center text-muted-foreground">Nothing matches “{q}”.</p>
      )}

      {model?.projects.map((p) => {
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

function UnitRow({ u, locationId }: { u: UnitVM; locationId: string }) {
  const stageCls = STAGE_STYLE[u.stage] ?? "bg-secondary text-muted-foreground border-border";
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5">
      <Home className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      <span className="min-w-24 text-sm font-medium">{u.label}</span>
      <span className={cn("inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium", stageCls)}>
        {u.stage || u.availability || "—"}
      </span>

      <span className="flex-1" />

      {/* Serious: the person holding this unit */}
      {u.holder && (
        <a
          href={opportunityUrl(locationId, u.holder.oppId)}
          target="_top"
          className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/5 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/10"
          title={`${u.holder.name ?? "Deal"} — ${u.holder.stageName ?? u.stage} (open in CRM)`}
        >
          <Lock className="h-3 w-3" />
          {u.holder.name ?? u.holder.oppName ?? "View deal"}
          {u.holder.stageName && <span className="font-normal text-primary/70">· {u.holder.stageName}</span>}
        </a>
      )}

      {/* Interested: everyone this unit was suggested to */}
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

      {!u.holder && u.interested.length === 0 && (
        <span className="text-[11px] text-muted-foreground/50">no interest yet</span>
      )}
    </div>
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
  stage: string;
  availability: string;
  holder: Person | null;
  interested: Person[];
}

function emptyCounts(): Counts {
  return { available: 0, reserved: 0, underContract: 0, sold: 0 };
}
function bump(c: Counts, stage: string, availability: string) {
  if (stage === "Reserved/Locked") c.reserved++;
  else if (stage === "Under Contract") c.underContract++;
  else if (stage === "Closed/Sold") c.sold++;
  else if (stage === "Available" || availability === "Available") c.available++;
}

function buildModel(data: Tree | undefined, q: string) {
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

  const unitHay = (label: string, ints: { holder: Person | null; interested: Person[] }) =>
    [label, ints.holder?.name ?? "", ints.holder?.oppName ?? "", ...ints.interested.flatMap((p) => [p.name ?? "", p.oppName ?? ""])]
      .join(" ")
      .toLowerCase();

  const totals = { projects: 0, buildings: 0, units: 0, ...emptyCounts() };
  const projectsOut = [] as Array<{
    id: string;
    name: string;
    unitCount: number;
    counts: Counts;
    buildings: Array<{ id: string; label: string; counts: Counts; units: UnitVM[] }>;
  }>;

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
    const bOut: Array<{ id: string; label: string; counts: Counts; units: UnitVM[] }> = [];

    const buildingEntries = [
      ...bs.map((b) => ({ id: b.id, name: b.name, label: stripPrefix(b.name, p.name), units: unitsByBuilding.get(b.id) ?? [] })),
      ...(looseUnits.length > 0 ? [{ id: "__loose__", name: "No building", label: "No building", units: looseUnits }] : []),
    ];

    for (const b of buildingEntries) {
      const bMatch = pMatch || !needle || b.label.toLowerCase().includes(needle) || b.name.toLowerCase().includes(needle);
      const bCounts = emptyCounts();
      const uOut: UnitVM[] = [];
      for (const u of b.units) {
        const ints = byUnit.get(u.id) ?? { holder: null, interested: [] };
        const label = stripPrefix(u.name, b.name);
        const keep = bMatch || !needle || unitHay(label, ints).includes(needle);
        if (!keep) continue;
        bump(bCounts, u.stage, u.availability);
        uOut.push({ id: u.id, label, stage: u.stage, availability: u.availability, holder: ints.holder, interested: ints.interested });
      }
      if (uOut.length === 0 && needle && !bMatch) continue;
      if (uOut.length === 0 && b.units.length === 0 && needle) continue;
      pCounts.available += bCounts.available;
      pCounts.reserved += bCounts.reserved;
      pCounts.underContract += bCounts.underContract;
      pCounts.sold += bCounts.sold;
      pUnits += uOut.length;
      bOut.push({ id: b.id, label: b.label, counts: bCounts, units: uOut });
    }

    if (needle && bOut.every((b) => b.units.length === 0) && !pMatch) continue;
    if (bOut.length === 0) continue;

    totals.projects++;
    totals.buildings += bOut.length;
    totals.units += pUnits;
    totals.available += pCounts.available;
    totals.reserved += pCounts.reserved;
    totals.underContract += pCounts.underContract;
    totals.sold += pCounts.sold;
    projectsOut.push({ id: p.id, name: p.name, unitCount: pUnits, counts: pCounts, buildings: bOut });
  }

  return { projects: projectsOut, totals };
}
