import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import * as XLSX from "xlsx";
import { getOpportunityContext, previewOpportunityImport } from "@/lib/opportunity-import.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, ClipboardCopy } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/import/opportunities")({
  component: OpportunityImportPage,
});

type Row = Record<string, unknown>;

function OpportunityImportPage() {
  const contextFn = useServerFn(getOpportunityContext);
  const previewFn = useServerFn(previewOpportunityImport);

  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [sheet, setSheet] = useState("");
  const [rows, setRows] = useState<Row[]>([]);

  const ctx = useMutation({
    mutationFn: () => contextFn({ data: { confirm: "LOOK" as const } }),
    onError: (e: Error) => toast.error(e.message),
  });
  const preview = useMutation({
    mutationFn: (r: Row[]) => previewFn({ data: { rows: r } }),
    onError: (e: Error) => toast.error(e.message),
  });

  async function onFile(file: File) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    setWorkbook(wb);
    setSheetNames(wb.SheetNames);
    const pick = wb.SheetNames.find((n) => /main/i.test(n)) ?? wb.SheetNames[0];
    setSheet(pick);
    load(wb, pick);
  }

  function load(wb: XLSX.WorkBook, name: string) {
    const parsed = XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { defval: "", raw: false });
    setRows(parsed);
    if (parsed.length) preview.mutate(parsed);
  }

  const c = ctx.data;
  const p = preview.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Opportunity Import</h1>
        <p className="mt-1 text-muted-foreground">
          Nothing on this page writes yet. It reads your live pipelines and measures how much of the sheet can
          actually resolve to a person and a unit.
        </p>
      </div>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="text-sm">
          Deals are the first thing that can move inventory. A wrong unit link doesn&apos;t just make a bad card
          — it marks the wrong apartment Under Contract. So resolution gets measured before anything is created.
        </AlertDescription>
      </Alert>

      {/* ---------------- 1. the pipelines ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">1 · Your pipelines</CardTitle>
          <CardDescription>Read live from GHL. These are the stages a deal can sit in.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={() => ctx.mutate()} disabled={ctx.isPending}>
            {ctx.isPending ? "Reading…" : "Load pipelines"}
          </Button>

          {c?.crmError && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-sm">{c.crmError}</AlertDescription>
            </Alert>
          )}

          {c && (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-3">
                <Stat label="Contacts mapped" value={c.contactsMapped} />
                <Stat label="Units mapped" value={c.unitsMapped} />
                <Stat label="Existing deals" value={c.totalOpenDeals} danger={c.totalOpenDeals > 0} />
              </div>

              {c.totalOpenDeals > 0 && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-sm">
                    {c.totalOpenDeals} opportunities already exist. An import ADDS to these — it does not replace
                    them. Check these aren&apos;t already the Lazers deals.
                  </AlertDescription>
                </Alert>
              )}

              {c.pipelines.map((pl) => (
                <div key={pl.id} className="rounded-md border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="font-medium">{pl.name}</span>
                    <Badge variant="outline">{pl.openDeals ?? "?"} deals</Badge>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {pl.stages.map((s, i) => (
                      <code key={s.id} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {i + 1}. {s.name}
                      </code>
                    ))}
                  </div>
                </div>
              ))}

              <div>
                <h3 className="mb-1.5 text-sm font-semibold">How the engine reads each stage</h3>
                <pre className="max-h-64 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px]">
                  {JSON.stringify(c.stageRules, null, 2)}
                </pre>
                <p className="mt-1 text-xs text-muted-foreground">
                  A stage not in one of these lists leaves the unit untouched. Stage ids are all null here, so
                  everything matches by name — a rename in GHL silently breaks the mapping.
                </p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- 2. the sheet ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">2 · Can the sheet resolve?</CardTitle>
          <CardDescription>
            Every row needs a person AND a unit. This measures both without writing anything.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />

          {sheetNames.length > 1 && (
            <div className="flex flex-wrap gap-1">
              {sheetNames.map((n) => (
                <Button
                  key={n}
                  size="sm"
                  variant={sheet === n ? "default" : "outline"}
                  onClick={() => {
                    setSheet(n);
                    if (workbook) load(workbook, n);
                  }}
                >
                  {n}
                </Button>
              ))}
            </div>
          )}

          {p && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Rows" value={p.totalRows} />
                <Stat label="With a client" value={p.withClient} />
                <Stat label="Person resolved" value={p.contactHit} danger={p.contactHit < p.withClient} />
                <Stat label="Unit resolved" value={p.unitHit} danger={p.unitHit < p.withClient} />
              </div>

              <div>
                <h3 className="mb-1.5 text-sm font-semibold">Every STATUS value in the sheet</h3>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(p.statusCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <code key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {k}: {v}
                      </code>
                    ))}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">
                  Each of these needs a destination stage. That is a business decision, not something to infer.
                </p>
              </div>

              <div>
                <h3 className="mb-1.5 text-sm font-semibold">Columns I found</h3>
                <pre className="overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[11px]">
                  {JSON.stringify(p.headersFound, null, 2)}
                </pre>
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <h3 className="mb-1.5 text-sm font-semibold">Unit names in GHL</h3>
                  <pre className="overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[10px]">
                    {JSON.stringify(p.sampleUnitNames, null, 2)}
                  </pre>
                </div>
                <div>
                  <h3 className="mb-1.5 text-sm font-semibold">Building names in GHL</h3>
                  <pre className="overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-[10px]">
                    {JSON.stringify(p.sampleBuildingNames, null, 2)}
                  </pre>
                </div>
              </div>

              {p.unresolvedUnits.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-sm font-semibold text-destructive">
                    Rows whose unit I could not find (first {p.unresolvedUnits.length})
                  </h3>
                  <div className="max-h-56 space-y-1 overflow-auto">
                    {p.unresolvedUnits.map((u) => (
                      <div key={u.row} className="rounded border p-1.5 font-mono text-[11px]">
                        row {u.row}: {u.key}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {p.unresolvedContacts.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-sm font-semibold text-destructive">
                    Rows whose person I could not find (first {p.unresolvedContacts.length})
                  </h3>
                  <div className="max-h-56 space-y-1 overflow-auto">
                    {p.unresolvedContacts.map((u) => (
                      <div key={`${u.row}-${u.name}`} className="rounded border p-1.5 font-mono text-[11px]">
                        row {u.row}: {u.name}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <Button
                variant="secondary"
                onClick={async () => {
                  await navigator.clipboard.writeText(JSON.stringify({ context: c ?? null, preview: p }, null, 2));
                  toast.success("Copied — paste it into the chat");
                }}
              >
                <ClipboardCopy className="mr-2 h-4 w-4" /> Copy everything
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={danger ? "text-2xl font-bold text-destructive" : "text-2xl font-bold"}>{value}</div>
    </div>
  );
}
