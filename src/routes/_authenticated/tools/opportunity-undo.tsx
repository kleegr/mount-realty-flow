import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  previewUndo,
  undoOpportunities,
  sweepAvailableUnits,
  recalcAll,
  showUnitFieldResolution,
} from "@/lib/opportunity-undo.functions";

export const Route = createFileRoute("/_authenticated/tools/opportunity-undo")({
  component: OpportunityUndoPage,
});

interface PipelineRow {
  id: string;
  name: string;
  deals: number;
  governed: boolean;
}

function OpportunityUndoPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<PipelineRow[]>([]);
  const [heldUnits, setHeldUnits] = useState(0);
  const [totalUnits, setTotalUnits] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [dump, setDump] = useState<unknown>(null);

  const say = (line: string) => setLog((l) => [...l, line]);

  async function look() {
    setBusy("look");
    setLog([]);
    try {
      const r = await previewUndo({ data: { confirm: "LOOK" } });
      setPipelines(r.pipelines);
      setHeldUnits(r.heldUnits);
      setTotalUnits(r.totalUnits);
      say(`${r.heldUnits} of ${r.totalUnits} units are held by a deal.`);
      for (const p of r.pipelines) {
        say(`${p.name}: ${p.deals} deals${p.governed ? "" : " (UNGOVERNED \u2014 not managed by the engine)"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function fields() {
    setBusy("fields");
    try {
      const r = await showUnitFieldResolution({ data: { confirm: "LOOK" } });
      setDump(r);
      toast.success("Field resolution loaded \u2014 look for any writes:false");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function deleteAll(pipelineId: string, name: string) {
    if (!confirm(`Delete ALL deals in "${name}"? This cannot be undone.`)) return;
    setBusy("delete");
    setLog([]);
    try {
      let guard = 0;
      for (;;) {
        const r = await undoOpportunities({ data: { confirm: "DELETE", pipelineId, limit: 15 } });
        say(`Deleted ${r.deleted}, ${r.remaining} left`);
        for (const f of r.failed) say(`  FAILED ${f.name}: ${f.detail}`);
        if (r.remaining === 0 || r.processed === 0) break;
        if (++guard > 60) {
          say("Stopped after 60 passes \u2014 press again to continue.");
          break;
        }
      }
      say("Deals deleted. Now press \u201cSet Available\u201d.");
      toast.success("Deals deleted");
      await look();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      say(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function sweep(dryRun: boolean) {
    setBusy("sweep");
    setLog([]);
    try {
      const first = await sweepAvailableUnits({ data: { confirm: "SWEEP", dryRun, offset: 0, limit: 15 } });
      if (dryRun) {
        say(`${first.wouldSetAvailable} units would be set Available. ${first.heldByDeal} are held by a deal and stay put.`);
        for (const s of first.sample) say(`  ${s}`);
        return;
      }
      let offset = 0;
      let done = 0;
      for (;;) {
        const r = await sweepAvailableUnits({ data: { confirm: "SWEEP", dryRun: false, offset, limit: 15 } });
        done += r.succeeded;
        for (const f of r.failed) say(`  FAILED ${f.unit}: ${f.detail}`);
        if (r.failed.some((f) => /ABORTED AFTER ONE UNIT/.test(f.detail))) {
          say("STOPPED \u2014 the write did not land. Press \u201cShow field resolution\u201d.");
          break;
        }
        offset = r.nextOffset;
        say(`${done} set Available, ${r.remaining} left`);
        if (r.remaining === 0 || r.processed === 0) break;
      }
      toast.success(`${done} units set Available`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      say(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function recalc() {
    setBusy("recalc");
    try {
      const r = await recalcAll({ data: { confirm: "RECALC" } });
      say(`Recalculated: ${JSON.stringify(r)}`);
      toast.success("Rollups recalculated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Undo opportunities</h1>
        <p className="text-muted-foreground text-sm">
          Delete every deal, then put all unheld inventory back to Available. Run the steps in order.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>1 \u00b7 Look</CardTitle>
          <CardDescription>See what is actually in the CRM right now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button onClick={look} disabled={busy !== null}>
            {busy === "look" ? "Reading\u2026" : "Look at the CRM"}
          </Button>
          {totalUnits > 0 && (
            <p className="text-sm">
              {heldUnits} of {totalUnits} units held by a deal.
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>2 \u00b7 Delete the deals</CardTitle>
          <CardDescription>Associations are removed with the deal. This cannot be undone.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {pipelines.length === 0 && <p className="text-muted-foreground text-sm">Press \u201cLook at the CRM\u201d first.</p>}
          {pipelines.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded border p-3">
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="text-muted-foreground text-xs">
                  {p.deals} deals{p.governed ? "" : " \u00b7 ungoverned"}
                </p>
              </div>
              <Button
                variant="destructive"
                disabled={busy !== null || p.deals === 0}
                onClick={() => deleteAll(p.id, p.name)}
              >
                {busy === "delete" ? "Deleting\u2026" : `Delete ${p.deals}`}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>3 \u00b7 Set everything Available</CardTitle>
          <CardDescription>
            Every unit with no deal gets Available, Stage cleared, Inventory Deducted = No. Stops immediately if GHL
            accepts the write but stores nothing.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button variant="outline" onClick={() => sweep(true)} disabled={busy !== null}>
            Dry run
          </Button>
          <Button onClick={() => sweep(false)} disabled={busy !== null}>
            {busy === "sweep" ? "Sweeping\u2026" : "Set Available"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>4 \u00b7 Recalculate</CardTitle>
          <CardDescription>Rebuilds building and project counts from real unit state.</CardDescription>
        </CardHeader>
        <CardContent className="flex gap-2">
          <Button onClick={recalc} disabled={busy !== null}>
            {busy === "recalc" ? "Recalculating\u2026" : "Recalculate rollups"}
          </Button>
          <Button variant="outline" onClick={fields} disabled={busy !== null}>
            Show field resolution
          </Button>
        </CardContent>
      </Card>

      {log.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Log</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto text-xs whitespace-pre-wrap">{log.join("\n")}</pre>
          </CardContent>
        </Card>
      )}

      {dump !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Field resolution</CardTitle>
            <CardDescription>Any writes:false is a key GHL does not know \u2014 those writes vanish silently.</CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto text-xs">{JSON.stringify(dump, null, 2)}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
