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
    if (parsed.length) preview.mutate(parsed);
  }

  const c = ctx.data;
  const p = preview.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Opportunity Import</h1>
        <p className="mt-1 text-muted-foreground">
          Nothing here writes yet. It measures how much of the sheet can actually resolve to a person and a unit.
        </p>
      </div>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="text-sm">
          A wrong contact link makes a bad card. A wrong <strong>unit</strong> link marks the wrong apartment
          Under Contract for the wrong family. So resolution is measured, and anything ambiguous is reported
          rather than guessed.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">1 · Pipelines</CardTitle>
          <CardDescription>Live from GHL. “Governed” means the engine has stage rules for it.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={() => ctx.mutate()} disabled={ctx.isPending}>
            {ctx.isPending ? "Reading…" : "Load pipelines"}
          </Button>

          {c && (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Contacts mapped" value={c.contactsMapped} />
                <Stat label="Units mapped" value={c.unitsMapped} />
                <Stat label="Deals (governed)" value={c.dealsInGovernedPipelines} danger={c.dealsInGovernedPipelines > 0} />
                <Stat label="Deals (ungoverned)" value={c.dealsInUngovernedPipelines} />
              </div>

              {c.pipelines.map((pl) => (
                <div key={pl.id} className="rounded-md border p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-medium">{pl.name}</span>
                    <Badge variant={pl.governed ? "secondary" : "outline"} className="text-[10px]">
                      {pl.governed ? "drives inventory" : "invisible to engine"}
                    </Badge>
                    <Badge variant="outline" className="ml-auto">{pl.openDeals ?? "?"} deals</Badge>
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
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">2 · Can the sheet resolve?</CardTitle>
          <CardDescription>Every deal needs a person AND a unit.</CardDescription>
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
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                <Stat label="With a client" value={p.withClient} />
                <Stat label="Person found" value={p.contactHit} danger={p.contactHit < p.withClient} />
                <Stat label="Building found" value={p.buildingHit} danger={p.buildingHit < p.withClient} />
                <Stat label="Unit found" value={p.unitHit} danger={p.unitHit < p.withClient} />
                <Stat label="Importable" value={p.importable} />
              </div>

              <div>
                <h3 className="mb-1.5 text-sm font-semibold">STATUS values</h3>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(p.statusCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([k, v]) => (
                      <code key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                        {k}: {v}
                      </code>
                    ))}
                </div>
              </div>

              <div>
                <h3 className="mb-1.5 text-sm font-semibold">Resolution by developer</h3>
                <div className="space-y-1">
                  {Object.entries(p.byDeveloper)
                    .sort((a, b) => b[1].rows - a[1].rows)
                    .map(([dev, s]) => (
                      <div key={dev} className="flex items-center justify-between rounded border p-1.5 text-xs">
                        <span className="truncate">{dev}</span>
                        <Badge variant={s.resolved === s.rows ? "secondary" : "destructive"} className="text-[10px]">
                          {s.resolved} / {s.rows}
                        </Badge>
                      </div>
                    ))}
                </div>
              </div>

              {p.doubleClaimed.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-sm font-semibold text-destructive">
                    Same unit claimed by more than one row ({p.doubleClaimed.length})
                  </h3>
                  <p className="mb-1.5 text-xs text-muted-foreground">
                    Two families cannot both be under contract on one apartment. These are excluded until you say
                    which is right.
                  </p>
                  <div className="max-h-56 space-y-1 overflow-auto">
                    {p.doubleClaimed.map((d) => (
                      <div key={d.unitId} className="rounded border p-1.5 font-mono text-[11px]">
                        {d.rows.join("  ·  ")}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {p.conflicts.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-sm font-semibold text-destructive">
                    Building and UNIT disagree ({p.conflicts.length})
                  </h3>
                  <div className="max-h-56 space-y-1 overflow-auto">
                    {p.conflicts.map((x) => (
                      <div key={x.row} className="rounded border p-1.5 text-[11px]">
                        <code>row {x.row}: {x.key}</code>
                        <div className="text-muted-foreground">{x.detail}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {p.unresolvedUnits.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-sm font-semibold text-destructive">
                    Unit not found ({p.unresolvedUnits.length} shown)
                  </h3>
                  <div className="max-h-64 space-y-1 overflow-auto">
                    {p.unresolvedUnits.map((u) => (
                      <div key={u.row} className="rounded border p-1.5 text-[11px]">
                        <code>row {u.row}: {u.key}</code>
                        <div className="text-muted-foreground">{u.why}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {p.unresolvedContacts.length > 0 && (
                <div>
                  <h3 className="mb-1.5 text-sm font-semibold text-destructive">
                    Person not found ({p.unresolvedContacts.length} shown)
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
                  await navigator.clipboard.writeText(JSON.stringify(p, null, 2));
                  toast.success("Copied — paste it into the chat");
                }}
              >
                <ClipboardCopy className="mr-2 h-4 w-4" /> Copy preview
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
