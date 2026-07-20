import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { getStageConfig, saveStageConfig, type StageStatus } from "@/lib/stage-config.functions";

export const Route = createFileRoute("/_authenticated/tools/stage-config")({
  component: StageConfigPage,
});

interface Stage {
  stageId: string;
  stageName: string;
  status: StageStatus;
}
interface Pipe {
  pipelineId: string;
  pipelineName: string;
  governed: boolean;
  stages: Stage[];
}

const OPTIONS: Array<{ value: StageStatus; label: string; hint: string }> = [
  { value: "available", label: "Available", hint: "offerable, not held" },
  { value: "reserved", label: "Reserved", hint: "held for one buyer" },
  { value: "under_contract", label: "Under Contract", hint: "in legal process" },
  { value: "sold", label: "Closed / Sold", hint: "removed from inventory" },
  { value: "unmapped", label: "No change", hint: "leaves unit as-is" },
];

const COLOR: Record<StageStatus, string> = {
  available: "bg-emerald-100 text-emerald-800 border-emerald-300",
  reserved: "bg-amber-100 text-amber-800 border-amber-300",
  under_contract: "bg-red-100 text-red-800 border-red-300",
  sold: "bg-purple-100 text-purple-800 border-purple-300",
  unmapped: "bg-muted text-muted-foreground",
};

function StageConfigPage() {
  const readFn = useServerFn(getStageConfig);
  const saveFn = useServerFn(saveStageConfig);

  const [pipes, setPipes] = useState<Pipe[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);

  async function load() {
    setBusy(true);
    try {
      const r = await readFn({ data: { confirm: "LOOK" as const } });
      setPipes(r.pipelines as Pipe[]);
      setLoaded(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function setStage(pipelineId: string, stageId: string, status: StageStatus) {
    setPipes((prev) =>
      prev.map((p) =>
        p.pipelineId !== pipelineId
          ? p
          : { ...p, stages: p.stages.map((s) => (s.stageId === stageId ? { ...s, status } : s)) },
      ),
    );
  }

  async function save(p: Pipe) {
    setSavingId(p.pipelineId);
    try {
      const assignments: Record<string, StageStatus> = {};
      for (const s of p.stages) assignments[s.stageName] = s.status;
      const r = await saveFn({
        data: { confirm: "SAVE" as const, pipelineId: p.pipelineId, pipelineName: p.pipelineName, assignments },
      });
      toast.success(
        `Saved: ${r.counts.available} available, ${r.counts.reserved} reserved, ${r.counts.under_contract} under contract, ${r.counts.sold} sold`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Stage &rarr; unit status</h1>
        <p className="text-muted-foreground text-sm">
          Choose what each pipeline stage does to a held unit. A deal in an &quot;Available&quot; stage leaves its unit
          offerable; &quot;Reserved&quot; holds it; &quot;Closed / Sold&quot; removes it from inventory. Changes take
          effect on the next dashboard load or manual sync.
        </p>
      </div>

      {!loaded && (
        <Card>
          <CardHeader>
            <CardTitle>Load pipelines</CardTitle>
            <CardDescription>Reads your live pipeline stages and their current mapping.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={load} disabled={busy}>
              {busy ? "Loading..." : "Load"}
            </Button>
          </CardContent>
        </Card>
      )}

      {pipes.map((p) => (
        <Card key={p.pipelineId}>
          <CardHeader>
            <CardTitle className="text-base">{p.pipelineName}</CardTitle>
            <CardDescription>
              {p.governed ? "Governed by stage rules." : "No rules yet - saving will create them."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {p.stages.map((s) => (
              <div key={s.stageId} className="rounded border p-2">
                <div className="mb-2 flex items-center gap-2">
                  <span className="text-sm font-medium">{s.stageName}</span>
                  <Badge className={`ml-auto border text-[10px] ${COLOR[s.status]}`} variant="outline">
                    {OPTIONS.find((o) => o.value === s.status)?.label}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-1">
                  {OPTIONS.map((o) => (
                    <Button
                      key={o.value}
                      size="sm"
                      variant={s.status === o.value ? "default" : "outline"}
                      className="h-7 text-xs"
                      onClick={() => setStage(p.pipelineId, s.stageId, o.value)}
                      title={o.hint}
                    >
                      {o.label}
                    </Button>
                  ))}
                </div>
              </div>
            ))}
            <Button onClick={() => save(p)} disabled={savingId === p.pipelineId}>
              {savingId === p.pipelineId ? "Saving..." : `Save ${p.pipelineName}`}
            </Button>
          </CardContent>
        </Card>
      ))}

      {loaded && (
        <p className="text-muted-foreground text-xs">
          After saving, open the Dashboard (or run a manual sync) so the engine re-applies statuses to held units.
        </p>
      )}
    </div>
  );
}
