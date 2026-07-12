import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPendingEvents, applyPendingWithUnit } from "@/lib/pending-events.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Clock, CheckCircle2, AlertCircle } from "lucide-react";
import { toast } from "sonner";

const REFRESH_MS = 60_000;

export function PendingEventsCard() {
  const list = useServerFn(listPendingEvents);
  const apply = useServerFn(applyPendingWithUnit);
  const query = useQuery({
    queryKey: ["pending-events"],
    queryFn: () => list(),
    refetchInterval: REFRESH_MS,
    refetchIntervalInBackground: true,
  });

  const [secondsLeft, setSecondsLeft] = useState(REFRESH_MS / 1000);
  useEffect(() => {
    setSecondsLeft(REFRESH_MS / 1000);
    const id = setInterval(() => {
      setSecondsLeft((s) => (s <= 1 ? REFRESH_MS / 1000 : s - 1));
    }, 1000);
    return () => clearInterval(id);
  }, [query.dataUpdatedAt]);

  const events = query.data?.events ?? [];

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="flex items-center gap-2 text-lg">
              <AlertCircle className="h-4 w-4" />
              Pending Stage Events
            </CardTitle>
            <CardDescription>
              Stage changes waiting for a Unit to be associated. Auto-rescans every minute.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1.5 rounded-md border bg-muted/40 px-2.5 py-1 text-xs tabular-nums text-muted-foreground">
              <Clock className="h-3 w-3" />
              Rescan in {secondsLeft}s
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => query.refetch()}
              disabled={query.isFetching}
            >
              <RefreshCw className={`mr-1.5 h-3.5 w-3.5 ${query.isFetching ? "animate-spin" : ""}`} />
              Rescan now
            </Button>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        {query.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
        {!query.isLoading && events.length === 0 && (
          <div className="flex items-center gap-2 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-green-600" />
            No pending events. All stage changes have been applied.
          </div>
        )}
        {events.map((ev) => (
          <PendingRow
            key={ev.id}
            opportunityId={ev.opportunity_id ?? ""}
            stageId={ev.stage_id ?? ""}
            pipelineId={ev.pipeline_id ?? ""}
            receivedAt={ev.received_at}
            onApply={async (unitCrmId) => {
              try {
                const res = await apply({ data: { opportunityId: ev.opportunity_id!, unitCrmId } });
                toast.success(`Applied ${res.replayed} event(s)`);
                await query.refetch();
              } catch (err) {
                toast.error(err instanceof Error ? err.message : "Failed to apply");
              }
            }}
          />
        ))}
      </CardContent>
    </Card>
  );
}

function PendingRow({
  opportunityId,
  stageId,
  pipelineId,
  receivedAt,
  onApply,
}: {
  opportunityId: string;
  stageId: string;
  pipelineId: string;
  receivedAt: string;
  onApply: (unitCrmId: string) => Promise<void>;
}) {
  const [unitId, setUnitId] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="rounded-md border p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">
            Opportunity <code className="font-mono text-xs">{opportunityId.slice(0, 12)}…</code>
          </div>
          <div className="text-xs text-muted-foreground">
            {new Date(receivedAt).toLocaleString()} · pipeline{" "}
            <code className="font-mono">{pipelineId.slice(0, 8)}…</code> · stage{" "}
            <code className="font-mono">{stageId.slice(0, 8)}…</code>
          </div>
        </div>
        <Badge variant="outline">pending</Badge>
      </div>
      <div className="flex gap-2">
        <Input
          placeholder="Paste Unit CRM ID from GHL (after linking)"
          value={unitId}
          onChange={(e) => setUnitId(e.target.value)}
          className="h-9 font-mono text-xs"
        />
        <Button
          size="sm"
          disabled={!unitId.trim() || busy}
          onClick={async () => {
            setBusy(true);
            await onApply(unitId.trim());
            setBusy(false);
            setUnitId("");
          }}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}
