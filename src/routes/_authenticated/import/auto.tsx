import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import * as XLSX from "xlsx";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Check, Play } from "lucide-react";
import { toast } from "sonner";
import { clearStaleHolds, sweepAvailableUnits, recalcAll } from "@/lib/opportunity-undo.functions";
import {
  getOpportunityContext,
  previewOpportunityImport,
  runOpportunityImportChunk,
} from "@/lib/opportunity-import.functions";

export const Route = createFileRoute("/_authenticated/import/auto")({
  component: AutoRunPage,
});

type Row = Record<string, unknown>;

interface Pipe {
  id: string;
  name: string;
  governed: boolean;
  openDeals: number | null;
  stages: Array<{ id: string; name: string }>;
}

interface StepState {
  key: string;
  label: string;
  status: "pending" | "running" | "done" | "failed" | "skipped";
  detail: string;
}

const INITIAL_STEPS: StepState[] = [
  { key: "read", label: "Read the sheet and the CRM", status: "pending", detail: "" },
  { key: "holds", label: "Clear holds for deleted deals", status: "pending", detail: "" },
  { key: "available", label: "Set free units to Available", status: "pending", detail: "" },
  { key: "recalc", label: "Recalculate building & project counts", status: "pending", detail: "" },
  { key: "import", label: "Import opportunities (name, payments, lock / inquiry)", status: "pending", detail: "" },
];

function AutoRunPage() {
  const contextFn = useServerFn(getOpportunityContext);
  const previewFn = useServerFn(previewOpportunityImport);
  const runFn = useServerFn(runOpportunityImportChunk);
  const clearFn = useServerFn(clearStaleHolds);
  const sweepFn = useServerFn(sweepAvailableUnits);
  const recalcFn = useServerFn(recalcAll);

  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState("");
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<StepState[]>(INITIAL_STEPS);
  const [log, setLog] = useState<string[]>([]);
  const [summary, setSummary] = useState<Record<string, number> | null>(null);
  const [pct, setPct] = useState(0);

  const [pipes, setPipes] = useState<Pipe[]>([]);
  const [chosenPipe, setChosenPipe] = useState<string>("");

  const say = (line: string) => setLog((l) => [...l, line]);
  const setStep = (key: string, patch: Partial<StepState>) =>
    setSteps((s) => s.map((st) => (st.key === key ? { ...st, ...patch } : st)));

  async function onFile(file: File) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const pick = wb.SheetNames.find((n) => /main/i.test(n)) ?? wb.SheetNames[0];
    const parsed = XLSX.utils.sheet_to_json<Row>(wb.Sheets[pick], { defval: "", raw: false });
    setRows(parsed);
    setFileName(`${file.name} - sheet "${pick}", ${parsed.length} rows`);
    setSteps(INITIAL_STEPS);
    setSummary(null);
    setLog([]);
    setPct(0);

    try {
      const ctx = await contextFn({ data: { confirm: "LOOK" as const } });
      const governed = ctx.pipelines.filter((p) => p.governed);
      const ranked = [...governed].sort((a, b) => (b.openDeals ?? 0) - (a.openDeals ?? 0));
      setPipes(ranked);
      setChosenPipe(ranked[0]?.id ?? governed[0]?.id ?? "");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function runAll() {
    if (!rows.length) {
      toast.error("Upload the sheet first.");
      return;
    }
    if (!chosenPipe) {
      toast.error("No pipeline selected.");
      return;
    }
    setRunning(true);
    setSteps(INITIAL_STEPS.map((s) => ({ ...s, status: "pending", detail: "" })));
    setLog([]);
    setSummary(null);
    setPct(0);

    const totals = {
      staleCleared: 0,
      liveKept: 0,
      setAvailable: 0,
      dealsCreated: 0,
      dealsUpdated: 0,
      inquiries: 0,
      dealsFailed: 0,
    };

    try {
      // ---- Step 1: read context, resolve the CHOSEN pipeline + stage map.
      setStep("read", { status: "running" });
      say("Reading the CRM: pipelines, stages, payment fields...");
      const ctx = await contextFn({ data: { confirm: "LOOK" as const } });
      const pipeline = ctx.pipelines.find((p) => p.id === chosenPipe);
      if (!pipeline) throw new Error("Chosen pipeline not found in CRM.");
      if (!pipeline.governed)
        say(`  WARNING: \"${pipeline.name}\" has no stage rules - units will not change status.`);
      const find = (re: RegExp) => pipeline.stages.find((s) => re.test(s.name))?.id ?? "";
      const stageMap: Record<string, string> = {
        undercontract: find(/contract signed|unit locked/i),
        reserved: find(/negotiation|unit reserved/i),
        closed: find(/^closing$/i),
      };
      const missing = Object.entries(stageMap).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) say(`  warning: no stage matched for ${missing.join(", ")} - those rows will be skipped.`);

      // Blank-status client rows become inquiries at the FIRST stage.
      const newInquiryStageId = find(/new inquiry|initial call/i) || pipeline.stages[0]?.id || "";
      if (newInquiryStageId) say(`  Blank-status rows -> New Inquiry stage + suggested unit (units stay Available).`);
      else say("  warning: no New Inquiry stage found - blank-status rows will be skipped.");

      const preview = await previewFn({ data: { rows } });
      say(
        `  TARGET PIPELINE: \"${pipeline.name}\" (${pipeline.openDeals ?? 0} existing deals). ` +
          `${ctx.opportunityFields.length} payment fields, ` +
          `${preview.contactHit}/${preview.withClient} contacts, ${preview.unitHit} units, ` +
          `${preview.withPhone} with phone / ${preview.missingPhone} missing, ` +
          `${preview.blankStatusInquiries ?? 0} blank-status inquiries.`,
      );
      if (ctx.opportunityFields.length === 0)
        say("  warning: GHL has no opportunity payment fields - payment data cannot import.");
      setStep("read", {
        status: "done",
        detail: `${pipeline.name} (${pipeline.openDeals ?? 0} deals), ${preview.unitHit} units`,
      });
      setPct(10);

      // ---- Step 2: clear stale holds.
      setStep("holds", { status: "running", detail: "checking..." });
      let offset = 0;
      for (;;) {
        const r = await clearFn({ data: { confirm: "CLEAR" as const, offset, limit: 20 } });
        totals.staleCleared += r.cleared;
        totals.liveKept += r.kept;
        offset = r.nextOffset;
        setStep("holds", { status: "running", detail: `checked ${offset} of ${r.totalHeld}...` });
        if (r.remaining === 0 || r.processed === 0) break;
      }
      say(`Cleared ${totals.staleCleared} stale holds, kept ${totals.liveKept} live ones.`);
      setStep("holds", { status: "done", detail: `${totals.staleCleared} cleared, ${totals.liveKept} kept` });
      setPct(25);

      // ---- Step 3: set Available.
      setStep("available", { status: "running", detail: "starting..." });
      let so = 0;
      let aborted = false;
      for (;;) {
        const r = await sweepFn({ data: { confirm: "SWEEP" as const, dryRun: false, offset: so, limit: 15 } });
        totals.setAvailable += r.succeeded;
        for (const f of r.failed) say(`  Available FAILED ${f.unit}: ${f.detail}`);
        if (r.failed.some((f) => /ABORTED AFTER ONE UNIT/.test(f.detail))) {
          aborted = true;
          break;
        }
        so = r.nextOffset;
        const totalToDo = totals.setAvailable + r.remaining;
        setStep("available", { status: "running", detail: `${totals.setAvailable} of ${totalToDo}...` });
        setPct(25 + Math.round((totals.setAvailable / Math.max(1, totalToDo)) * 20));
        if (r.remaining === 0 || r.processed === 0) break;
      }
      if (aborted) {
        setStep("available", { status: "failed", detail: "write did not land - see log" });
        throw new Error("Available write did not land in GHL. Stopped before importing.");
      }
      say(`Set ${totals.setAvailable} units to Available.`);
      setStep("available", { status: "done", detail: `${totals.setAvailable} units` });
      setPct(45);

      // ---- Step 4: recalc.
      setStep("recalc", { status: "running", detail: "rebuilding..." });
      const rc = await recalcFn({ data: { confirm: "RECALC" as const } });
      say(`Recalculated ${JSON.stringify(rc)}`);
      setStep("recalc", { status: "done", detail: "counts rebuilt" });
      setPct(55);

      // ---- Step 5: import opportunities (locked rows + inquiries).
      setStep("import", { status: "running", detail: "starting..." });
      let io = 0;
      let total = 0;
      for (let pass = 0; pass < 100; pass++) {
        const r = await runFn({
          data: {
            confirm: "IMPORT" as const,
            rows,
            pipelineId: pipeline.id,
            stageMap,
            newInquiryStageId: newInquiryStageId || undefined,
            offset: io,
            limit: 10,
          },
        });
        total = r.totalDeals;
        totals.dealsCreated += r.created;
        totals.dealsUpdated += r.updated;
        totals.inquiries += (r as { inquiries?: number }).inquiries ?? 0;
        for (const res of r.results) {
          if (!res.ok) {
            totals.dealsFailed++;
            say(`  row ${res.row} ${res.client}: ${res.detail}`);
          }
        }
        if (r.results.some((x) => /ABORTED AFTER ONE ROW/.test(x.detail))) {
          setStep("import", { status: "failed", detail: "payment write did not land - see log" });
          throw new Error("Payment fields did not store on the first deal. Stopped.");
        }
        io = r.nextOffset;
        setStep("import", { status: "running", detail: `${io} of ${total}...` });
        setPct(55 + Math.round((io / Math.max(1, total)) * 45));
        if (r.remaining === 0 || r.processed === 0) break;
      }
      say(
        `Import done: ${totals.dealsCreated} created, ${totals.dealsUpdated} updated, ` +
          `${totals.inquiries} inquiries, ${totals.dealsFailed} failed.`,
      );
      setStep("import", {
        status: "done",
        detail: `${totals.dealsCreated} created, ${totals.dealsUpdated} updated, ${totals.inquiries} inquiries, ${totals.dealsFailed} failed`,
      });
      setPct(100);

      setSummary(totals);
      toast.success(`Done: ${totals.dealsCreated} created, ${totals.dealsUpdated} updated, ${totals.inquiries} inquiries`);
    } catch (err) {
      say(`STOPPED: ${err instanceof Error ? err.message : String(err)}`);
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Run everything</h1>
        <p className="mt-1 text-muted-foreground">
          Upload the sheet, choose the pipeline, press one button. Clears old holds, sets inventory to Available,
          recalculates counts, then imports: status rows lock their unit with payments; blank-status buyers become New
          Inquiry deals with a suggested unit. Safe to run twice. Stops if any write does not land.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">1 - Upload</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Input
            type="file"
            accept=".xlsx,.xls,.csv"
            disabled={running}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          {fileName && <p className="text-muted-foreground text-sm">{fileName}</p>}
        </CardContent>
      </Card>

      {pipes.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">2 - Pipeline</CardTitle>
            <CardDescription>
              Target the pipeline that holds your deals. Default is the one with the most existing deals.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-1">
            {pipes.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={chosenPipe === p.id ? "default" : "outline"}
                disabled={running}
                onClick={() => setChosenPipe(p.id)}
              >
                {p.name} ({p.openDeals ?? 0})
              </Button>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">3 - Run</CardTitle>
          <CardDescription>
            Safe to run more than once. Held units for live deals are updated in place, never duplicated. One inquiry
            deal per buyer - re-runs never duplicate inquiries either.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={runAll} disabled={running || rows.length === 0 || !chosenPipe}>
            <Play className="mr-2 h-4 w-4" />
            {running ? "Running..." : "Run everything"}
          </Button>

          {(running || pct > 0) && <Progress value={pct} />}

          <div className="space-y-1">
            {steps.map((s) => (
              <div key={s.key} className="flex items-center gap-2 rounded border p-2 text-sm">
                <span className="w-5 shrink-0">
                  {s.status === "done" && <Check className="h-4 w-4 text-emerald-600" />}
                  {s.status === "running" && <span className="text-primary">...</span>}
                  {s.status === "failed" && <AlertTriangle className="h-4 w-4 text-destructive" />}
                </span>
                <span className={s.status === "failed" ? "text-destructive" : ""}>{s.label}</span>
                {s.detail && <span className="text-muted-foreground ml-auto text-xs">{s.detail}</span>}
              </div>
            ))}
          </div>
        </CardContent>
      </Card>

      {summary && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Summary</CardTitle>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Stat label="Deals created" value={summary.dealsCreated} />
            <Stat label="Deals updated" value={summary.dealsUpdated} />
            <Stat label="Inquiries" value={summary.inquiries} />
            <Stat label="Units Available" value={summary.setAvailable} />
            <Stat label="Stale holds cleared" value={summary.staleCleared} />
            <Stat label="Deals failed" value={summary.dealsFailed} danger={summary.dealsFailed > 0} />
            <Stat label="Live holds kept" value={summary.liveKept} />
          </CardContent>
        </Card>
      )}

      {summary && summary.dealsFailed > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription className="text-sm">
            Some rows failed - see the log for the exact reason per row.
          </AlertDescription>
        </Alert>
      )}

      {log.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Log</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap">{log.join("\n")}</pre>
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
