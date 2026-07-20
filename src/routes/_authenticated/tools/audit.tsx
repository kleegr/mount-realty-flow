import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { auditPipelinesAndInventory } from "@/lib/audit.functions";

export const Route = createFileRoute("/_authenticated/tools/audit")({
  component: AuditPage,
});

interface StageCount {
  stageId: string;
  stageName: string;
  count: number;
}
interface SampleDeal {
  id: string;
  name: string;
  stageId: string;
}
interface Pipe {
  id: string;
  name: string;
  firstStage: { id: string; name: string } | null;
  totalDeals: number;
  stageCounts: StageCount[];
  sampleDeals: SampleDeal[];
}
interface Result {
  locationId: string;
  pipelines: Pipe[];
  inventory: { total: number; available: number; held: number; other: number };
  heldOpportunities: number;
  staleHoldersCheckedFirst: number;
  staleHoldersFound: string[];
}

function AuditPage() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    try {
      const r = (await auditPipelinesAndInventory({ data: { confirm: "AUDIT" } })) as Result;
      setRes(r);
      toast.success("Audit complete");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Pipeline & inventory audit</h1>
        <p className="text-muted-foreground text-sm">
          Read-only. Confirms each pipeline&apos;s first stage and where deals sit, and that inventory holds are sound.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run the audit</CardTitle>
        </CardHeader>
        <CardContent>
          <Button onClick={run} disabled={busy}>
            {busy ? "Auditing..." : "Run audit"}
          </Button>
        </CardContent>
      </Card>

      {res && (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Inventory</CardTitle>
              <CardDescription>
                Held units are never freed by the sweep. Stale holders should be zero.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Units tracked" value={res.inventory.total} />
                <Stat label="Available" value={res.inventory.available} />
                <Stat label="Held by a deal" value={res.inventory.held} />
                <Stat label="Other/blank" value={res.inventory.other} />
              </div>
              <p className="text-sm">
                {res.heldOpportunities} distinct holding opportunities. Checked first{" "}
                {res.staleHoldersCheckedFirst}: {res.staleHoldersFound.length} stale.
              </p>
              {res.staleHoldersFound.length > 0 && (
                <div className="text-destructive text-xs">
                  Stale holders (deal gone, unit still marked held): {res.staleHoldersFound.join(", ")}
                </div>
              )}
            </CardContent>
          </Card>

          {res.pipelines.map((p) => (
            <Card key={p.id}>
              <CardHeader>
                <CardTitle className="text-base">{p.name}</CardTitle>
                <CardDescription>
                  {p.totalDeals} deals - first stage:{" "}
                  <span className="font-medium">{p.firstStage?.name ?? "(none)"}</span>
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                <div className="flex flex-wrap gap-1">
                  {p.stageCounts
                    .filter((s) => s.count > 0)
                    .map((s) => (
                      <Badge key={s.stageId} variant="outline" className="text-[10px]">
                        {s.stageName}: {s.count}
                      </Badge>
                    ))}
                </div>
                {p.totalDeals > 0 && p.totalDeals <= 5 && (
                  <div className="space-y-1">
                    {p.sampleDeals.map((d) => (
                      <div key={d.id} className="rounded border p-2 text-xs">
                        <span className="font-medium">{d.name}</span>{" "}
                        <span className="text-muted-foreground font-mono">{d.id}</span>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
