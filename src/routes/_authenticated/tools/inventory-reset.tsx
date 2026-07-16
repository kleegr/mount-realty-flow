import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { resetInventoryChunk, finalizeInventoryReset } from "@/lib/inventory-reset.functions";
import { inspectHierarchy, inspectSchema, repairHierarchyChunk, hierarchyCoverage } from "@/lib/hierarchy-repair.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Wrench, Check, Search, ClipboardCopy, ListTree } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/tools/inventory-reset")({
  component: InventoryResetPage,
});

type Line = { ok: boolean; text: string };

function InventoryResetPage() {
  const repairFn = useServerFn(repairHierarchyChunk);
  const resetFn = useServerFn(resetInventoryChunk);
  const finalizeFn = useServerFn(finalizeInventoryReset);
  const inspectFn = useServerFn(inspectHierarchy);
  const schemaFn = useServerFn(inspectSchema);
  const coverageFn = useServerFn(hierarchyCoverage);

  const [running, setRunning] = useState(false);
  const [phase, setPhase] = useState("");
  const [pct, setPct] = useState(0);
  const [log, setLog] = useState<Line[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  const inspect = useMutation({
    mutationFn: () => inspectFn({ data: { confirm: "LOOK" as const } }),
    onError: (e: Error) => toast.error(e.message),
  });
  const schema = useMutation({
    mutationFn: () => schemaFn({ data: { confirm: "LOOK" as const } }),
    onError: (e: Error) => toast.error(e.message),
  });

  const say = (ok: boolean, text: string) => setLog((l) => [...l, { ok, text }]);

  async function runAll() {
    setRunning(true);
    setFatal(null);
    setLog([]);
    setPct(0);

    try {
      let offset = 0;
      let units = 0;
      let builds = 0;
      for (let pass = 0; pass < 20; pass++) {
        setPhase(`Rebuilding hierarchy from GHL… (${offset} buildings read)`);
        const r = await repairFn({ data: { confirm: "REPAIR" as const, offset, limit: 15 } });
        units += r.unitsLinked;
        builds += r.buildingsLinked;
        setPct(r.totalBuildings ? Math.round((r.nextOffset / r.totalBuildings) * 33) : 0);
        for (const f of r.failures) say(false, `${f.name ?? f.crmId}: ${f.detail}`);
        offset = r.nextOffset;
        if (r.remaining === 0 || r.processed === 0) break;
      }
      say(true, `Linked ${units} units to their buildings and ${builds} buildings to their projects.`);

      const cov = await coverageFn({ data: { confirm: "COUNT" as const } });
      // Projects are the root of the tree — they have no parent and never should.
      say(true, `building: ${cov.building?.withParent ?? 0} of ${cov.building?.total ?? 0} have a project`);
      say(true, `unit: ${cov.unit?.withParent ?? 0} of ${cov.unit?.total ?? 0} have a building`);
      if ((cov.unit?.withParent ?? 0) === 0) {
        throw new Error(
          "No unit got a parent. The recalc would still skip everything, so stopping here rather than pretending it worked.",
        );
      }

      offset = 0;
      for (let pass = 0; pass < 30; pass++) {
        setPhase(`Setting units Available… (${offset})`);
        const r = await resetFn({ data: { confirm: "RESET" as const, offset, limit: 25 } });
        setPct(33 + (r.totalUnits ? Math.round((r.nextOffset / r.totalUnits) * 50) : 0));
        for (const f of r.failed) say(false, `${f.unitCrmId}: ${f.detail}`);
        offset = r.nextOffset;
        if (r.remaining === 0 || r.processed === 0) break;
      }
      say(true, "All units set to Available.");

      setPhase("Recalculating totals…");
      const rc = await finalizeFn({ data: { confirm: "RECALC" as const } });
      setPct(100);
      const zero = rc.buildings === 0 && rc.projects === 0;
      say(!zero, `Recalculated ${rc.buildings} buildings and ${rc.projects} projects.`);
      for (const f of rc.failed.slice(0, 20)) say(false, `${f.scope} ${f.crmId}: ${f.message}`);
      if (rc.skipped) say(false, `Skipped: ${rc.skipped}`);
      setPhase("");
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e));
      setPhase("");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Inventory Reset</h1>
        <p className="mt-1 text-muted-foreground">
          Rebuilds the Project → Building → Unit hierarchy from GHL, sets every unit Available, then recomputes
          every total from what is actually there.
        </p>
      </div>

      {/* ---------------- which field am I writing ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ListTree className="h-4 w-4" /> Which fields am I writing?
          </CardTitle>
          <CardDescription>
            Read-only. Lists every field on each object and marks which one each mapped key resolves to. Keys
            that match nothing are dropped silently — so a column reading 0 is not proof anything wrote it.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={() => schema.mutate()} disabled={schema.isPending}>
            {schema.isPending ? "Reading…" : "Show field resolution"}
          </Button>
          {schema.data && (
            <>
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(JSON.stringify(schema.data, null, 2));
                    toast.success("Copied — paste it into the chat");
                  }}
                >
                  <ClipboardCopy className="mr-2 h-4 w-4" /> Copy
                </Button>
              </div>
              <pre className="max-h-[32rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                {JSON.stringify(schema.data, null, 2)}
              </pre>
            </>
          )}
        </CardContent>
      </Card>

      <Alert>
        <AlertTriangle className="h-4 w-4" />
        <AlertDescription className="text-sm">
          <strong>Safe only while both pipelines are empty.</strong> Unit status is derived from where a deal
          sits; with opportunities present, self-heal would re-apply their stages and undo the reset.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Repair and reset</CardTitle>
          <CardDescription>
            Reads ~71 buildings from GHL, links their units and projects, sets 332 units Available, then
            recalculates. Safe to re-run — it is idempotent.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={runAll} disabled={running}>
            <Wrench className="mr-2 h-4 w-4" />
            {running ? "Working…" : "Repair hierarchy and reset inventory"}
          </Button>

          {(running || pct > 0) && (
            <div className="space-y-1.5">
              <Progress value={pct} />
              {phase && <p className="text-sm text-muted-foreground">{phase}</p>}
            </div>
          )}

          {fatal && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="break-words text-sm">{fatal}</AlertDescription>
            </Alert>
          )}

          {log.length > 0 && (
            <div className="max-h-96 space-y-1 overflow-auto">
              {log.map((l, i) => (
                <div key={i} className="flex items-start gap-2 rounded-md border p-2">
                  {l.ok ? (
                    <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  ) : (
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  )}
                  <span className="break-words text-xs">{l.text}</span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Search className="h-4 w-4" /> Hierarchy check
          </CardTitle>
          <CardDescription>Read-only. Raw association definitions and one sample relation per scope.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" size="sm" onClick={() => inspect.mutate()} disabled={inspect.isPending}>
            {inspect.isPending ? "Looking…" : "Inspect hierarchy"}
          </Button>
          {inspect.data && (
            <pre className="max-h-[28rem] overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
              {JSON.stringify(inspect.data, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
