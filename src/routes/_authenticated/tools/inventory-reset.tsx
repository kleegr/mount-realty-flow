import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { resetInventoryChunk, finalizeInventoryReset } from "@/lib/inventory-reset.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, RotateCcw, Check } from "lucide-react";

/**
 * Inventory reset UI.
 *
 * Chunked at 25 for the same reason the contact import is: ~332 sequential CRM
 * writes will outlive a serverless invocation. Resumable by offset — a stall
 * costs a click, not a restart.
 */

export const Route = createFileRoute("/_authenticated/tools/inventory-reset")({
  component: InventoryResetPage,
});

type Failure = { unitCrmId: string; detail: string };

function InventoryResetPage() {
  const resetFn = useServerFn(resetInventoryChunk);
  const finalizeFn = useServerFn(finalizeInventoryReset);

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState<string>("");
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [failures, setFailures] = useState<Failure[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [finished, setFinished] = useState<string | null>(null);

  async function run() {
    setRunning(true);
    setFatal(null);
    setFinished(null);
    setFailures([]);
    setDone(0);
    const fails: Failure[] = [];

    try {
      let offset = 0;
      // 332 units / 25 per pass = ~14. 30 is headroom, not an expectation.
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Inventory Reset</h1>
        <p className="mt-1 text-muted-foreground">
          Puts every unit back to Available and recomputes every building and project total from what is
          actually there.
        </p>
      </div>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="space-y-2 text-sm">
          <p>
            <strong>This is only safe while both pipelines are empty.</strong> Unit status is derived from
            where a deal sits. With opportunities present, self-heal would re-apply their stages within about
            two minutes and quietly undo this. The reset refuses to run if any unit is still recorded as held.
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
            Roughly 332 units in batches of 25, then one rollup pass. A minute or two.
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
            <Alert>
              <Check className="h-4 w-4" />
              <AlertDescription className="text-sm">{finished}</AlertDescription>
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
