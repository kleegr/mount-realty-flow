import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { previewUndo } from "@/lib/opportunity-undo.functions";
import { refreshOpportunityNames } from "@/lib/refresh-names.functions";

export const Route = createFileRoute("/_authenticated/tools/refresh-names")({
  component: RefreshNamesPage,
});

interface PipelineRow {
  id: string;
  name: string;
  deals: number;
}

interface ResultRow {
  oppId: string;
  from: string;
  to: string;
  action: string;
}

function RefreshNamesPage() {
  const [busy, setBusy] = useState(false);
  const [pipelines, setPipelines] = useState<PipelineRow[]>([]);
  const [selected, setSelected] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [rows, setRows] = useState<ResultRow[]>([]);

  const say = (line: string) => setLog((l) => [...l, line]);

  async function loadPipelines() {
    setBusy(true);
    try {
      const r = await previewUndo({ data: { confirm: "LOOK" } });
      setPipelines(r.pipelines.map((p) => ({ id: p.id, name: p.name, deals: p.deals })));
      const target = r.pipelines.find((p) => p.deals > 0);
      if (target) setSelected(target.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function run(dryRun: boolean) {
    if (!selected) {
      toast.error("Pick a pipeline first.");
      return;
    }
    setBusy(true);
    setLog([]);
    setRows([]);
    const acc: ResultRow[] = [];
    try {
      let offset = 0;
      let renamed = 0;
      let would = 0;
      let already = 0;
      for (let pass = 0; pass < 80; pass++) {
        const r = await refreshOpportunityNames({
          data: { confirm: "REFRESH", pipelineId: selected, dryRun, offset, limit: 15 },
        });
        acc.push(...r.results);
        setRows([...acc]);
        renamed += r.renamed;
        would += r.wouldRename;
        already += r.alreadyCorrect;
        for (const e of r.errors) say(`  error ${e.oppId}: ${e.action}`);
        offset = r.nextOffset;
        say(`Processed ${offset} of ${r.total}...`);
        if (r.remaining === 0 || r.processed === 0) break;
      }
      if (dryRun) {
        say(`Dry run done: ${would} would be renamed, ${already} already correct.`);
        toast.success(`${would} names would change`);
      } else {
        say(`Done: ${renamed} renamed, ${already} already correct.`);
        toast.success(`${renamed} deals renamed`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      say(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  }

  const changing = rows.filter((r) => r.action === "would rename" || r.action === "renamed");

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Refresh opportunity names</h1>
        <p className="text-muted-foreground text-sm">
          Rebuilds each deal&apos;s name as &quot;full name + phone&quot; from the linked contact&apos;s current info in
          GHL. Rename only - no deletes, no duplicates. Add a missing phone to the contact first, then run this to push
          it onto the card.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1 - Pick the pipeline</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={loadPipelines} disabled={busy}>
            {busy ? "Loading..." : "Load pipelines"}
          </Button>
          <div className="flex flex-wrap gap-1">
            {pipelines.map((p) => (
              <Button
                key={p.id}
                size="sm"
                variant={selected === p.id ? "default" : "outline"}
                onClick={() => setSelected(p.id)}
              >
                {p.name} ({p.deals})
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2 - Preview, then apply</CardTitle>
          <CardDescription>Dry run shows what would change without touching anything.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button variant="outline" onClick={() => run(true)} disabled={busy || !selected}>
            Dry run
          </Button>
          <Button onClick={() => run(false)} disabled={busy || !selected}>
            {busy ? "Working..." : "Rename for real"}
          </Button>
        </CardContent>
      </Card>

      {changing.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Names changing ({changing.length})</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-96 space-y-1 overflow-auto">
              {changing.map((r) => (
                <div key={r.oppId} className="rounded border p-2 text-xs">
                  <div className="text-muted-foreground line-through">{r.from || "(empty)"}</div>
                  <div className="font-medium">{r.to}</div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {log.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Log</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-72 overflow-auto text-xs whitespace-pre-wrap">{log.join("\n")}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
