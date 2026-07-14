import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { getUnitReport, type UnitStatus } from "@/lib/report.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CheckCircle2, Clock, FileSignature, DollarSign, HelpCircle, Users } from "lucide-react";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/report/")({
  component: ReportPage,
});

const STATUS_META: Record<UnitStatus, { label: string; badge: string; row: string }> = {
  available: { label: "Available", badge: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 border-emerald-500/30", row: "" },
  reserved: { label: "Reserved", badge: "bg-amber-500/15 text-amber-700 dark:text-amber-400 border-amber-500/30", row: "" },
  under_contract: { label: "Under Contract", badge: "bg-blue-500/15 text-blue-700 dark:text-blue-400 border-blue-500/30", row: "" },
  sold: { label: "Sold", badge: "bg-rose-500/15 text-rose-700 dark:text-rose-400 border-rose-500/30", row: "" },
  unknown: { label: "Unknown", badge: "bg-muted text-muted-foreground border-border", row: "" },
};

function ReportPage() {
  const fn = useServerFn(getUnitReport);
  const { data, isLoading, isFetching, dataUpdatedAt } = useQuery({
    queryKey: ["unit-report"],
    queryFn: () => fn(),
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
    refetchIntervalInBackground: true,
  });
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<"all" | UnitStatus>("all");

  const rows = useMemo(() => {
    const all = data?.rows ?? [];
    return all.filter((r) => {
      if (filter !== "all" && r.status !== filter) return false;
      if (!q) return true;
      const needle = q.toLowerCase();
      return (
        r.unitName.toLowerCase().includes(needle) ||
        (r.buildingName?.toLowerCase().includes(needle) ?? false) ||
        (r.contactName?.toLowerCase().includes(needle) ?? false) ||
        (r.unitCode?.toLowerCase().includes(needle) ?? false)
      );
    });
  }, [data, q, filter]);

  const totals = data?.totals;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Unit Report</h1>
        <p className="mt-1 text-muted-foreground">Every unit with its current status and the associated lead / contact. <span className="text-xs">· Auto-refreshes every 30s{isFetching ? " · updating…" : dataUpdatedAt ? ` · updated ${new Date(dataUpdatedAt).toLocaleTimeString()}` : ""}</span></p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatusTile label="Available" value={totals?.available} icon={CheckCircle2} tone="success" active={filter === "available"} onClick={() => setFilter(filter === "available" ? "all" : "available")} />
        <StatusTile label="Reserved" value={totals?.reserved} icon={Clock} tone="warning" active={filter === "reserved"} onClick={() => setFilter(filter === "reserved" ? "all" : "reserved")} />
        <StatusTile label="Under Contract" value={totals?.under_contract} icon={FileSignature} tone="info" active={filter === "under_contract"} onClick={() => setFilter(filter === "under_contract" ? "all" : "under_contract")} />
        <StatusTile label="Sold" value={totals?.sold} icon={DollarSign} tone="danger" active={filter === "sold"} onClick={() => setFilter(filter === "sold" ? "all" : "sold")} />
        <StatusTile label="Unknown" value={totals?.unknown} icon={HelpCircle} tone="muted" active={filter === "unknown"} onClick={() => setFilter(filter === "unknown" ? "all" : "unknown")} />
      </div>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2"><Users className="h-4 w-4" />Units &amp; Leads</CardTitle>
            <CardDescription>
              {filter === "all" ? "Showing all units" : `Filtered: ${STATUS_META[filter].label}`} · {rows.length} row{rows.length === 1 ? "" : "s"}
            </CardDescription>
          </div>
          <div className="flex gap-2">
            <Input placeholder="Search unit, building, lead…" value={q} onChange={(e) => setQ(e.target.value)} className="w-64" />
            {filter !== "all" && (
              <Button variant="outline" size="sm" onClick={() => setFilter("all")}>Clear filter</Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Unit</TableHead>
                  <TableHead>Building</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Lead / Contact</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isLoading && (
                  <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">Loading…</TableCell></TableRow>
                )}
                {!isLoading && rows.length === 0 && (
                  <TableRow><TableCell colSpan={5} className="py-8 text-center text-muted-foreground">No units match your filters.</TableCell></TableRow>
                )}
                {rows.map((r) => {
                  const meta = STATUS_META[r.status];
                  return (
                    <TableRow key={r.unitCrmId}>
                      <TableCell>
                        <div className="font-medium">{r.unitName}</div>
                        {r.unitCode && <div className="text-xs text-muted-foreground">{r.unitCode}</div>}
                      </TableCell>
                      <TableCell>
                        <span className="text-sm">{r.buildingName ?? <span className="text-muted-foreground">—</span>}</span>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn("border font-medium", meta.badge)}>{meta.label}</Badge>
                      </TableCell>
                      <TableCell>
                        {r.contactName ? (
                          <span className="font-medium">{r.contactName}</span>
                        ) : (
                          <span className="text-sm text-muted-foreground">—</span>
                        )}
                        {r.opportunityId && (
                          <div className="font-mono text-xs text-muted-foreground">{r.opportunityId.slice(0, 12)}…</div>
                        )}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground whitespace-nowrap">
                        {r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : "—"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusTile({
  label, value, icon: Icon, tone, active, onClick,
}: {
  label: string;
  value: number | undefined;
  icon: React.ComponentType<{ className?: string }>;
  tone: "success" | "warning" | "info" | "danger" | "muted";
  active: boolean;
  onClick: () => void;
}) {
  const toneClasses: Record<string, string> = {
    success: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
    warning: "bg-amber-500/10 text-amber-600 dark:text-amber-400",
    info: "bg-blue-500/10 text-blue-600 dark:text-blue-400",
    danger: "bg-rose-500/10 text-rose-600 dark:text-rose-400",
    muted: "bg-muted text-muted-foreground",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "text-left rounded-lg border bg-card p-4 shadow-card transition-all hover:shadow-md",
        active ? "border-primary ring-2 ring-primary/30" : "border-border",
      )}
    >
      <div className="flex items-center gap-3">
        <div className={cn("flex h-10 w-10 items-center justify-center rounded-lg", toneClasses[tone])}>
          <Icon className="h-5 w-5" />
        </div>
        <div>
          <div className="text-xs font-medium text-muted-foreground">{label}</div>
          <div className="text-2xl font-bold">{value ?? "—"}</div>
        </div>
      </div>
    </button>
  );
}
