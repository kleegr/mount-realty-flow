import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { listPendingEvents, applyPendingWithUnit } from "@/lib/pending-events.functions";
import { searchCrmRecords } from "@/lib/crm-search.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { RefreshCw, Clock, CheckCircle2, AlertCircle, ChevronDown } from "lucide-react";
import { toast } from "sonner";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";

const REFRESH_MS = 60_000;

/**
 * Collapsed by default — this is a power tool, not something customers need
 * to stare at. The header always shows a live count of pending events, so
 * nothing gets missed; one click expands the full list and controls.
 */
export function PendingEventsCard() {
  const list = useServerFn(listPendingEvents);
  const apply = useServerFn(applyPendingWithUnit);
  const [open, setOpen] = useState(false);
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
      <CardHeader className="py-4">
        <button
          type="button"
          className="flex w-full items-center justify-between gap-4 text-left"
          onClick={() => setOpen((v) => !v)}
        >
          <div className="flex items-center gap-2">
            <AlertCircle className="h-4 w-4" />
            <CardTitle className="text-lg">Pending Stage Events</CardTitle>
            {events.length > 0 ? (
              <Badge variant="destructive">{events.length} pending</Badge>
            ) : (
              <Badge variant="outline" className="text-muted-foreground">
                <CheckCircle2 className="mr-1 h-3 w-3 text-green-600" /> all clear
              </Badge>
            )}
          </div>
          <ChevronDown className={cn("h-4 w-4 shrink-0 text-muted-foreground transition-transform", open && "rotate-180")} />
        </button>
        {open && (
          <CardDescription className="pt-1">
            Stage changes waiting to be linked to a Unit or Building. Auto-rescans every minute.
          </CardDescription>
        )}
      </CardHeader>
      {open && (
        <CardContent className="space-y-2">
          <div className="flex items-center justify-end gap-2">
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
              onApply={async (crmId) => {
                try {
                  const res = await apply({ data: { opportunityId: ev.opportunity_id!, unitCrmId: crmId } });
                  toast.success(`Applied ${res.replayed} event(s)`);
                  await query.refetch();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Failed to apply");
                }
              }}
            />
          ))}
        </CardContent>
      )}
    </Card>
  );
}

function PendingRow({
  opportunityId, stageId, pipelineId, receivedAt, onApply,
}: {
  opportunityId: string;
  stageId: string;
  pipelineId: string;
  receivedAt: string;
  onApply: (crmId: string) => Promise<void>;
}) {
  const [scope, setScope] = useState<"unit" | "building">("unit");
  const [selected, setSelected] = useState<{ crmId: string; displayName: string } | null>(null);
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
        <div className="flex gap-1">
          <Button size="sm" variant={scope === "unit" ? "default" : "outline"} onClick={() => { setScope("unit"); setSelected(null); }}>Unit</Button>
          <Button size="sm" variant={scope === "building" ? "default" : "outline"} onClick={() => { setScope("building"); setSelected(null); }}>Building</Button>
        </div>
        <RecordPicker scope={scope} selected={selected} onSelect={setSelected} />
        <Button
          size="sm"
          disabled={!selected || busy}
          onClick={async () => {
            if (!selected) return;
            setBusy(true);
            await onApply(selected.crmId);
            setBusy(false);
            setSelected(null);
          }}
        >
          Apply
        </Button>
      </div>
    </div>
  );
}

function RecordPicker({
  scope, selected, onSelect,
}: {
  scope: "unit" | "building";
  selected: { crmId: string; displayName: string } | null;
  onSelect: (v: { crmId: string; displayName: string } | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const fetchFn = useServerFn(searchCrmRecords);

  const results = useQuery({
    queryKey: ["crm-search", scope, query],
    queryFn: () => fetchFn({ data: { query, scope, limit: 20 } }),
    enabled: open,
  });

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className={cn("flex-1 justify-between font-normal", !selected && "text-muted-foreground")}
        >
          <span className="truncate">
            {selected ? selected.displayName : `Search ${scope}s…`}
          </span>
          <ChevronDown className="ml-2 h-3.5 w-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[320px] p-2" align="start">
        <Input
          autoFocus
          placeholder="Type to search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="mb-2 h-8"
        />
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {results.isLoading && <p className="p-2 text-xs text-muted-foreground">Searching…</p>}
          {!results.isLoading && (results.data?.results ?? []).length === 0 && (
            <p className="p-2 text-xs text-muted-foreground">
              No matches. Run "Sync from CRM" in Settings if records are missing.
            </p>
          )}
          {(results.data?.results ?? []).map((r) => (
            <button
              key={r.crmId}
              type="button"
              onClick={() => { onSelect({ crmId: r.crmId, displayName: r.displayName }); setOpen(false); }}
              className="w-full rounded-sm px-2 py-1.5 text-left hover:bg-accent"
            >
              <div className="text-sm font-medium">{r.displayName}</div>
              <div className="truncate font-mono text-xs text-muted-foreground">
                {r.code ? `${r.code} · ` : ""}{r.crmId}
              </div>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
