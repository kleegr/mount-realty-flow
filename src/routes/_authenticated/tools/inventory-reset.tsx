import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { resetInventoryChunk, finalizeInventoryReset } from "@/lib/inventory-reset.functions";
import { inspectHierarchy } from "@/lib/hierarchy-repair.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, RotateCcw, Check, Search, ClipboardCopy } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/tools/inventory-reset")({
  component: InventoryResetPage,
});

type Failure = { unitCrmId: string; detail: string };

function InventoryResetPage() {
  const resetFn = useServerFn(resetInventoryChunk);
  const finalizeFn = useServerFn(finalizeInventoryReset);
  const inspectFn = useServerFn(inspectHierarchy);

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null);

  const inspect = useMutation({
    mutationFn: () => inspectFn({ data: { confirm: "LOOK" as const } }),
    onError: (e: Error) => toast.error(e.message),
  });

  async function run() {
    setRunning(true);
    setFatal(null);
    setFinished(null);
    setFailures([]);
    setDone(0);
    const fails: Failure[] = [];

    try {
      let offset = 0;
      for (let pass = 0; pass < 30; pass++) {
        setPhase(`Releasing units… pass ${pass + 1}`);
        const res = await resetFn({ data: { confirm: "RESET" as const, offset, limit: 25 } });
        setTotal(res.totalUnits);
        setDone(res.nextOffset);
        if (res.failed.length) {
          fails.push(...res.failed);
          setFailures([...fails]);
        }
        offset = res.nextOffset;
        if (res.remaining === 0 || res.processed === 0) break;
      }

      setPhase("Recalculating building and project totals…");
      const rc = await finalizeFn({ data: { confirm: "RECALC" as const } });
      setFinished(
        `Recalculated ${rc.buildings} buildings and ${rc.projects} projects.` +
          (rc.failed.length ? ` ${rc.failed.length} failed.` : "") +
          (rc.skipped ? ` Skipped: ${rc.skipped}` : ""),
      );
      setPhase("");
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e));
      setPhase("");
    } finally {
      setRunning(false);
    }
  }

  const pct = total ? Math.round((done / total) * 100) : 0;
  const zeroRecalc = finished?.includes("Recalculated 0 buildings");

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Inventory Reset</h1>
        <p className="mt-1 text-muted-foreground">
          Puts every unit back to Available and recomputes every building and project total from what is
          actually there.
        </p>
      </div>

      {/* ---------------- the actual blocker ---------------- */}
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Search className="h-4 w-4" /> Hierarchy check
          </CardTitle>
          <CardDescription>
            Read-only. Every unit, building and project has a NULL parent in the mapping table, which is why
            the recalc touched nothing — it skips any unit with no parent. This shows whether the links still
            exist in GHL and can be rebuilt from there.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={() => inspect.mutate()} disabled={inspect.isPending}>
            {inspect.isPending ? "Looking…" : "Inspect hierarchy"}
          </Button>

          {inspect.data && (
            <>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(JSON.stringify(inspect.data, null, 2));
                    toast.success("Copied — paste it into the chat");
                  }}
                >
                  <ClipboardCopy className="mr-2 h-4 w-4" /> Copy result
                </Button>
              </div>
              <pre className="max-h-[32rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(inspect.data, null, 2)}
              </pre>
            </>
          )}
        </CardContent>
      </Card>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="space-y-2 text-sm">
          <p>
            <strong>This is only safe while both pipelines are empty.</strong> Unit status is derived from
            where a deal sits. With opportunities present, self-heal would re-apply their stages within about
            two minutes and quietly undo this.
          </p>
          <p>
            No records are deleted. Units keep their identity — only availability, stage and lock date are
            cleared, which is exactly what a normal release does.
          </p>
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Run the reset</CardTitle>
          <CardDescription>
            Sets every unit to Available. The totals will not move until parentage is repaired.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={run} disabled={running}>
            <RotateCcw className="mr-2 h-4 w-4" />
            {running ? "Working…" : "Reset everything to Available"}
          </Button>

          {(running || total > 0) && (
            <div className="space-y-1.5">
              <Progress value={pct} />
              <p className="text-sm text-muted-foreground">
                {done} of {total} units{phase ? ` · ${phase}` : ""}
              </p>
            </div>
          )}

          {fatal && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="break-words text-sm">{fatal}</AlertDescription>
            </Alert>
          )}

          {finished && (
            <Alert variant={zeroRecalc ? "destructive" : "default"}>
              {zeroRecalc ? <AlertTriangle className="h-4 w-4" /> : <Check className="h-4 w-4" />}
              <AlertDescription className="space-y-1 text-sm">
                <p>{finished}</p>
                {zeroRecalc && (
                  <p>
                    Zero means every unit was skipped for having no parent building. The units are Available;
                    the totals cannot be computed until the hierarchy is repaired. Run the hierarchy check
                    above.
                  </p>
                )}
              </AlertDescription>
            </Alert>
          )}

          {failures.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-destructive">{failures.length} units failed</h3>
              <div className="max-h-72 space-y-1 overflow-auto">
                {failures.map((f) => (
                  <div key={f.unitCrmId} className="rounded-md border p-2">
                    <code className="font-mono text-[11px]">{f.unitCrmId}</code>
                    <div className="break-words text-xs text-muted-foreground">{f.detail}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
