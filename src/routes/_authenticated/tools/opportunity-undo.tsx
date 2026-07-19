import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  previewUndo,
  undoOpportunities,
  clearStaleHolds,
  sweepAvailableUnits,
  recalcAll,
  showUnitFieldResolution,
} from "@/lib/opportunity-undo.functions";
import { getOpportunityContext } from "@/lib/opportunity-import.functions";

export const Route = createFileRoute("/_authenticated/tools/opportunity-undo")({
  component: OpportunityUndoPage,
});

interface PipelineRow {
  id: string;
  name: string;
  deals: number;
  governed: boolean;
}

interface OppFieldRow {
  id: string;
  name: string;
  key: string;
  dataType: string;
  options: string[];
}

function OpportunityUndoPage() {
  const [busy, setBusy] = useState<string | null>(null);
  const [pipelines, setPipelines] = useState<PipelineRow[]>([]);
  const [heldUnits, setHeldUnits] = useState(0);
  const [totalUnits, setTotalUnits] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const [dump, setDump] = useState<unknown>(null);
  const [oppFields, setOppFields] = useState<OppFieldRow[] | null>(null);

  const say = (line: string) => setLog((l) => [...l, line]);

  async function look() {
    setBusy("look");
    setLog([]);
    try {
      const r = await previewUndo({ data: { confirm: "LOOK" } });
      setPipelines(r.pipelines);
      setHeldUnits(r.heldUnits);
      setTotalUnits(r.totalUnits);
      say(`${r.heldUnits} of ${r.totalUnits} units are marked held by a deal.`);
      for (const p of r.pipelines) {
        say(`${p.name}: ${p.deals} deals${p.governed ? "" : " (ungoverned)"}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // The one-button flow: clear stale holds -> set Available -> recalc.
  async function resetToAvailable() {
    setBusy("reset");
    setLog([]);
    try {
      // 1) Clear holds whose deal was deleted in GHL.
      say("Step 1: clearing holds for deals that no longer exist in GHL...");
      let offset = 0;
      let cleared = 0;
      let kept = 0;
      for (;;) {
        const r = await clearStaleHolds({ data: { confirm: "CLEAR", offset, limit: 20 } });
        cleared += r.cleared;
        kept += r.kept;
        for (const f of r.failed) say(`  read error ${f.unit}: ${f.detail}`);
        offset = r.nextOffset;
        if (r.remaining === 0 || r.processed === 0) break;
      }
      say(`  ${cleared} stale holds cleared, ${kept} live holds kept.`);

      // 2) Set every unheld unit to Available.
      say("Step 2: setting all free units to Available...");
      let so = 0;
      let setDone = 0;
      let aborted = false;
      for (;;) {
        const r = await sweepAvailableUnits({ data: { confirm: "SWEEP", dryRun: false, offset: so, limit: 15 } });
        setDone += r.succeeded;
        for (const f of r.failed) say(`  FAILED ${f.unit}: ${f.detail}`);
        if (r.failed.some((f) => /ABORTED AFTER ONE UNIT/.test(f.detail))) {
          say("  STOPPED - the Available write did not land. See the error above.");
          aborted = true;
          break;
        }
        so = r.nextOffset;
        if (r.remaining === 0 || r.processed === 0) break;
      }
      say(`  ${setDone} units set to Available.`);
      if (aborted) {
        toast.error("Stopped - Available write failed. Check the log.");
        return;
      }

      // 3) Recalculate rollups.
      say("Step 3: recalculating building and project counts...");
      const rc = await recalcAll({ data: { confirm: "RECALC" } });
      say(`  recalculated ${JSON.stringify(rc)}`);

      say("Done. Inventory is back to Available. You can re-import now.");
      toast.success(`Reset complete: ${setDone} units Available`);
      await look();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      say(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  async function loadOppFields() {
    setBusy("oppfields");
    try {
      const r = await getOpportunityContext({ data: { confirm: "LOOK" } });
      setOppFields(r.opportunityFields);
      if (r.fieldsError) toast.error(`Field read error: ${r.fieldsError}`);
      else if (r.opportunityFields.length === 0) toast.warning("GHL has NO opportunity custom fields");
      else toast.success(`${r.opportunityFields.length} opportunity fields found`);
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
      toast.success("Field resolution loaded");
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
        if (++guard > 60) break;
      }
      toast.success("Deals deleted");
      await look();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      say(`ERROR: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Reset inventory</h1>
        <p className="text-muted-foreground text-sm">
          After deleting the deals, put all inventory back to Available in one pass, then re-import.
        </p>
      </div>

      <Card className="border-primary">
        <CardHeader>
          <CardTitle>Reset everything to Available</CardTitle>
          <CardDescription>
            One button. Clears holds for deals that were deleted in GHL, sets every free unit to Available (Stage
            cleared, Inventory Deducted = No), and recalculates the building and project counts. Held units for deals
            that still exist are left alone. Stops immediately if a write does not land.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={resetToAvailable} disabled={busy !== null}>
            {busy === "reset" ? "Working..." : "Reset inventory to Available"}
          </Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Check state</CardTitle>
          <CardDescription>See what is in the CRM right now.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button variant="outline" onClick={look} disabled={busy !== null}>
            {busy === "look" ? "Reading..." : "Look at the CRM"}
          </Button>
          {totalUnits > 0 && (
            <p className="text-sm">
              {heldUnits} of {totalUnits} units marked held.
            </p>
          )}
          {pipelines.map((p) => (
            <div key={p.id} className="flex items-center justify-between rounded border p-3">
              <div>
                <p className="font-medium">{p.name}</p>
                <p className="text-muted-foreground text-xs">
                  {p.deals} deals{p.governed ? "" : " (ungoverned)"}
                </p>
              </div>
              <Button
                variant="destructive"
                disabled={busy !== null || p.deals === 0}
                onClick={() => deleteAll(p.id, p.name)}
              >
                {busy === "delete" ? "Deleting..." : `Delete ${p.deals}`}
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Diagnostics</CardTitle>
          <CardDescription>Opportunity payment fields and unit field resolution.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Button variant="outline" onClick={loadOppFields} disabled={busy !== null}>
              {busy === "oppfields" ? "Reading..." : "List opportunity fields"}
            </Button>
            <Button variant="outline" onClick={fields} disabled={busy !== null}>
              Show unit field resolution
            </Button>
          </div>
          {oppFields !== null && oppFields.length === 0 && (
            <p className="text-destructive text-sm font-medium">GHL has no custom fields on opportunities.</p>
          )}
          {oppFields !== null && oppFields.length > 0 && (
            <div className="space-y-1">
              {oppFields.map((f) => (
                <div key={f.id} className="rounded border p-2 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium">{f.name}</span>
                    <span className="text-muted-foreground">{f.dataType}</span>
                  </div>
                  <div className="text-muted-foreground font-mono">
                    id: {f.id} - key: {f.key}
                  </div>
                </div>
              ))}
            </div>
          )}
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
            <CardTitle>Unit field resolution</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-96 overflow-auto text-xs">{JSON.stringify(dump, null, 2)}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
