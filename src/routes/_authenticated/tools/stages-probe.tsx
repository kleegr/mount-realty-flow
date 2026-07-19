import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { probeStagesField } from "@/lib/stages-probe.functions";

export const Route = createFileRoute("/_authenticated/tools/stages-probe")({
  component: StagesProbePage,
});

function StagesProbePage() {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<unknown>(null);

  async function run() {
    setBusy(true);
    try {
      const r = await probeStagesField({ data: { confirm: "PROBE" } });
      setResult(r);
      const winner = (r as { winner?: string }).winner ?? "";
      if (winner.startsWith("NONE")) toast.warning("No shape stuck - the field may have no options defined in GHL");
      else toast.success(`Winner: ${winner}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Stages field probe</h1>
        <p className="text-muted-foreground text-sm">
          Writes one unit&apos;s Stages field four different ways and reads it back after each, to find the shape GHL
          actually stores. Restores the original value when done. Read-only to every other unit.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Run the probe</CardTitle>
          <CardDescription>Touches a single unit. Safe to run repeatedly.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={run} disabled={busy}>
            {busy ? "Probing..." : "Probe Stages field"}
          </Button>
        </CardContent>
      </Card>

      {result !== null && (
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
            <CardDescription>
              Look at winner. If NONE stuck, check stagesFieldRawOptions - an empty list means the picklist has no
              options defined in GHL and must be configured there first.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[32rem] overflow-auto text-xs">{JSON.stringify(result, null, 2)}</pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
