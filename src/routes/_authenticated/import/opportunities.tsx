import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import * as XLSX from "xlsx";
import {
  getOpportunityContext,
  previewOpportunityImport,
  runOpportunityImportChunk,
} from "@/lib/opportunity-import.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Check, X, Upload } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/import/opportunities")({
  component: OpportunityImportPage,
});

type Row = Record<string, unknown>;
type Res = { row: number; client: string; ok: boolean; detail: string };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

function OpportunityImportPage() {
  const contextFn = useServerFn(getOpportunityContext);
  const previewFn = useServerFn(previewOpportunityImport);
  const runFn = useServerFn(runOpportunityImportChunk);

  const [rows, setRows] = useState<Row[]>([]);
  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [sheet, setSheet] = useState("");
  const [pipelineId, setPipelineId] = useState("");
  const [stageMap, setStageMap] = useState<Record<string, string>>({});
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [results, setResults] = useState<Res[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  const ctx = useMutation({
    mutationFn: () => contextFn({ data: { confirm: "LOOK" as const } }),
    onSuccess: (d) => {
      const local =
        d.pipelines.find((p) => p.governed && (p.openDeals ?? 0) === 0) ?? d.pipelines.find((p) => p.governed);
      if (local) {
        setPipelineId(local.id);
        const find = (re: RegExp) => local.stages.find((s) => re.test(s.name))?.id ?? "";
        setStageMap({
          undercontract: find(/contract signed|unit locked/i),
          reserved: find(/negotiation|unit reserved/i),
          closed: find(/^closing$/i),
        });
      }
    },
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
    ctx.mutate();
  }

  function load(wb: XLSX.WorkBook, name: string) {
    const parsed = XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { defval: "", raw: false });
    setRows(parsed);
    setResults([]);
    setDone(0);
    setTotal(0);
    if (parsed.length) preview.mutate(parsed);
  }

  async function run() {
    if (!rows.length || !pipelineId) return;
    setRunning(true);
    setFatal(null);
    const acc: Res[] = [];
    try {
      let offset = 0;
      for (let pass = 0; pass < 60; pass++) {
        const r = await runFn({
          data: { confirm: "IMPORT" as const, rows, pipelineId, stageMap, offset, limit: 10 },
        });
        acc.push(...r.results);
        setResults([...acc]);
        setTotal(r.totalDeals);
        setDone(r.nextOffset);
        offset = r.nextOffset;
        if (r.remaining === 0 || r.processed === 0) break;
      }
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const c = ctx.data;
  const p = preview.data;
  const pipeline = c?.pipelines.find((x) => x.id === pipelineId);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const statuses = p ? Object.keys(p.statusCounts).filter((s) => s !== "(blank)") : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Opportunity Import</h1>
        <p className="mt-1 text-muted-foreground">
          Creates a deal per row, locks its unit, and lets the engine set the unit&apos;s status from the stage.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">1 · The sheet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
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
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="With a client" value={p.withClient} />
              <Stat label="Person found" value={p.contactHit} danger={p.contactHit < p.withClient} />
              <Stat label="Unit found" value={p.unitHit} danger={p.unitHit < p.withClient} />
              <Stat label="Importable" value={p.importable} />
            </div>
          )}

          {p && p.doubleClaimed.length > 0 && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="space-y-1 text-sm">
                <p>{p.doubleClaimed.length} units are claimed by more than one row.</p>
                <p className="text-xs">
                  The first row wins the lock; the rest are skipped and reported. Two families cannot both be under
                  contract on one apartment, so nothing is overwritten.
                </p>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {p && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">2 · Where each status lands</CardTitle>
            <CardDescription>
              Every stage in the engine&apos;s under-contract list produces the same unit status, so this choice
              decides which column the card sits in — not what happens to the apartment.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {c && (
              <div className="space-y-1.5">
                <Label>Pipeline</Label>
                <div className="flex flex-wrap gap-1">
                  {c.pipelines.map((pl) => (
                    <Button
                      key={pl.id}
                      size="sm"
                      variant={pipelineId === pl.id ? "default" : "outline"}
                      onClick={() => setPipelineId(pl.id)}
                    >
                      {pl.name}
                      {!pl.governed && " · no rules"}
                    </Button>
                  ))}
                </div>
                {pipeline && !pipeline.governed && (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-sm">
                      The engine has no stage rules for this pipeline. Deals would be created and every unit would
                      stay Available.
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            )}

            {pipeline &&
              statuses.map((s) => (
                <div key={s} className="space-y-1.5">
                  <Label>
                    <code>{s}</code> <span className="text-muted-foreground">({p.statusCounts[s]} rows)</span>
                  </Label>
                  <div className="flex flex-wrap gap-1">
                    {pipeline.stages.map((st) => (
                      <Button
                        key={st.id}
                        size="sm"
                        variant={stageMap[norm(s)] === st.id ? "default" : "outline"}
                        onClick={() => setStageMap((m) => ({ ...m, [norm(s)]: st.id }))}
                      >
                        {st.name}
                      </Button>
                    ))}
                  </div>
                </div>
              ))}

            <p className="text-xs text-muted-foreground">
              Rows with a blank status get no deal — their unit stays Available. A status with no stage selected is
              skipped entirely.
            </p>
          </CardContent>
        </Card>
      )}

      {p && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">3 · Import</CardTitle>
            <CardDescription>
              Batches of 10, resumable. A unit already locked to a deal is skipped, so re-running is safe.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <Button onClick={run} disabled={running || !pipelineId}>
              <Upload className="mr-2 h-4 w-4" />
              {running ? "Importing…" : done > 0 ? "Continue import" : "Create deals and lock units"}
            </Button>

            {total > 0 && (
              <div className="space-y-1.5">
                <Progress value={pct} />
                <p className="text-sm text-muted-foreground">
                  {done} of {total} deals
                </p>
              </div>
            )}

            {fatal && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="break-words text-sm">{fatal}</AlertDescription>
              </Alert>
            )}

            {results.length > 0 && (
              <div className="max-h-96 space-y-1 overflow-auto">
                {results.map((r, i) => (
                  <div key={`${r.row}-${i}`} className="flex items-start gap-2 rounded-md border p-2">
                    {r.ok ? (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    ) : (
                      <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{r.client}</span>
                        <Badge variant="outline" className="shrink-0 text-[10px]">
                          row {r.row}
                        </Badge>
                      </div>
                      <div className="break-words font-mono text-[11px] text-muted-foreground">{r.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
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
