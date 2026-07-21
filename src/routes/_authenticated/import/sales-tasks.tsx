import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import * as XLSX from "xlsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Play, Users } from "lucide-react";
import { toast } from "sonner";
import { previewSalesTasks, runSalesTasksChunk } from "@/lib/sales-tasks-import.functions";

export const Route = createFileRoute("/_authenticated/import/sales-tasks")({
  component: SalesTasksPage,
});

type Row = Record<string, unknown>;
type Preview = Awaited<ReturnType<ReturnType<typeof useServerFn<typeof previewSalesTasks>>>>;

function SalesTasksPage() {
  const previewFn = useServerFn(previewSalesTasks);
  const runFn = useServerFn(runSalesTasksChunk);

  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [running, setRunning] = useState(false);
  const [pct, setPct] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [summary, setSummary] = useState<{ created: number; updated: number; failed: number } | null>(null);

  const say = (l: string) => setLog((x) => [...x, l]);

  async function onFile(file: File) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const parsed = XLSX.utils.sheet_to_json<Row>(wb.Sheets[wb.SheetNames[0]], { defval: "", raw: false });
    setRows(parsed);
    setFileName(`${file.name} - ${parsed.length} rows`);
    setPreview(null);
    setSummary(null);
    setLog([]);
    setPct(0);
    try {
      const p = await previewFn({ data: { rows: parsed } });
      setPreview(p);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function run() {
    if (!rows.length) return toast.error("Upload the sheet first.");
    setRunning(true);
    setLog([]);
    setSummary(null);
    setPct(0);
    const totals = { created: 0, updated: 0, failed: 0 };
    try {
      let offset = 0;
      for (let pass = 0; pass < 200; pass++) {
        const r = await runFn({ data: { confirm: "IMPORT" as const, rows, offset, limit: 8 } });
        totals.created += r.created;
        totals.updated += r.updated;
        totals.failed += r.failed;
        for (const res of r.results) {
          if (!res.ok) say(`row ${res.row} ${res.name}: ${res.detail}`);
          else if (/CONFLICT|SKIPPED/.test(res.detail)) say(`row ${res.row} ${res.name}: ${res.detail}`);
        }
        offset = r.nextOffset;
        setPct(Math.round((offset / Math.max(1, r.total)) * 100));
        if (r.remaining === 0 || r.processed === 0) break;
      }
      setSummary(totals);
      toast.success(`Done: ${totals.created} created, ${totals.updated} updated, ${totals.failed} failed`);
    } catch (err) {
      say(`STOPPED: ${err instanceof Error ? err.message : String(err)}`);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  const c = preview?.counts;

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Sales Tasks Import</h1>
        <p className="mt-1 text-muted-foreground">
          Upload the sales team's task export (ClickUp CSV). Every person becomes a deal in the Local Market Pipeline:
          "groveview pending" rows lock their units at Under Contract, priorities set the Priority dropdown, everything
          else lands in the first stage. Existing customers are updated in place - never duplicated. Ambiguous names are
          left out for your review. Safe to run twice.
        </p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-lg">1 - Upload</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          <Input
            type="file"
            accept=".csv,.xlsx,.xls"
            disabled={running}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          {fileName && <p className="text-muted-foreground text-sm">{fileName}</p>}
        </CardContent>
      </Card>

      {c && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">2 - Preview</CardTitle>
            <CardDescription>Nothing has been written yet. This is what the run will do.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Will import" value={c.locked + c.firstStage} />
              <Stat label="Locked Under Contract" value={c.locked} sub={`${c.lockedUnits} units`} />
              <Stat label="First stage" value={c.firstStage} />
              <Stat label="Existing customers (update)" value={c.existing} />
              <Stat label="New contacts (create)" value={c.newContacts} />
              <Stat label="Left for review" value={c.ambiguous} danger={c.ambiguous > 0} />
              <Stat label="Ignored (rentel/listings)" value={c.skipped} />
              <Stat label="Missing phone" value={c.missingPhone} />
            </div>

            {preview!.ambiguousList.length > 0 && (
              <div>
                <div className="mb-1 flex items-center gap-1.5 text-sm font-semibold">
                  <Users className="h-4 w-4" /> Needs your review (not imported)
                </div>
                <div className="max-h-48 overflow-auto rounded border p-2 text-xs">
                  {preview!.ambiguousList.map((a) => (
                    <div key={a.row}>
                      row {a.row}: <b>{a.name}</b> ~ could be {a.candidates.join(" / ")}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">3 - Run</CardTitle>
          <CardDescription>Re-runs update in place; one deal per person; notes are never duplicated.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={run} disabled={running || !preview}>
            <Play className="mr-2 h-4 w-4" />
            {running ? "Importing..." : "Import sales tasks"}
          </Button>
          {(running || pct > 0) && <Progress value={pct} />}
        </CardContent>
      </Card>

      {summary && (
        <Card>
          <CardHeader><CardTitle className="text-lg">Summary</CardTitle></CardHeader>
          <CardContent className="grid grid-cols-3 gap-3">
            <Stat label="Created" value={summary.created} />
            <Stat label="Updated" value={summary.updated} />
            <Stat label="Failed" value={summary.failed} danger={summary.failed > 0} />
          </CardContent>
        </Card>
      )}

      {summary && summary.failed > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-sm">Some rows failed - the log shows the reason per row.</AlertDescription>
        </Alert>
      )}

      {log.length > 0 && (
        <Card>
          <CardHeader><CardTitle className="text-lg">Log</CardTitle></CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap">{log.join("\n")}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, sub, danger }: { label: string; value: number; sub?: string; danger?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={danger ? "text-2xl font-bold text-destructive" : "text-2xl font-bold"}>{value}</div>
      {sub && <div className="text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
