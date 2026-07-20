import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import { diagnoseBuildingMatch } from "@/lib/diagnose-building.functions";

export const Route = createFileRoute("/_authenticated/tools/diagnose-building")({
  component: DiagnoseBuildingPage,
});

const NEEDLES = [
  "319 Lake Shore - 319 Lake Shore",
  "Yoely Katz/Accord - 73 Duelk",
  "Indigo/diamond circle - Building 1",
];

function DiagnoseBuildingPage() {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<unknown>(null);

  async function run() {
    setBusy(true);
    try {
      const r = await diagnoseBuildingMatch({ data: { confirm: "DIAG", needles: NEEDLES } });
      setRes(r);
      toast.success("Diagnostic complete");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Building match diagnostic</h1>
        <p className="text-muted-foreground text-sm">
          Shows what building names are recorded vs what the opportunity importer looks for. Read-only.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Run</CardTitle>
          <CardDescription>Checks the 3 failing developer buildings against external_id_map.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button onClick={run} disabled={busy}>
            {busy ? "Checking..." : "Run diagnostic"}
          </Button>
        </CardContent>
      </Card>
      {res != null && (
        <Card>
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardContent>
            <pre className="max-h-[40rem] overflow-auto text-xs whitespace-pre-wrap">
              {JSON.stringify(res, null, 2)}
            </pre>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
