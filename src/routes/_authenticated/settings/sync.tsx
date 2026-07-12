import { createFileRoute } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useEffect } from "react";
import { startCrmSync, listSyncJobs } from "@/lib/sync.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Layers, Building2, Home, RefreshCw, Loader2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/sync")({
  component: SyncPage,
});

function SyncPage() {
  const startFn = useServerFn(startCrmSync);
  const listFn = useServerFn(listSyncJobs);
  const qc = useQueryClient();

  const jobs = useQuery({
    queryKey: ["sync-jobs"],
    queryFn: () => listFn(),
    refetchInterval: 3000,
  });

  const running = (jobs.data?.jobs ?? []).some((j) => j.status === "running");
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => qc.invalidateQueries({ queryKey: ["sync-jobs"] }), 2000);
    return () => clearInterval(id);
  }, [running, qc]);

  const start = useMutation({
    mutationFn: (scope: "project" | "building" | "unit" | "all") => startFn({ data: { scope } }),
    onSuccess: () => {
      toast.success("Sync started");
      jobs.refetch();
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Failed to start sync"),
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Sync from CRM</h1>
        <p className="mt-1 text-muted-foreground">
          Pull existing Projects, Buildings and Units from GHL into the app so they appear in the dashboard and inventory list.
          Safe to run anytime — updates existing mappings, never creates duplicates in GHL.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SyncButton
          label="Sync Projects" scope="project" icon={Layers}
          disabled={start.isPending || running} onClick={() => start.mutate("project")}
        />
        <SyncButton
          label="Sync Buildings" scope="building" icon={Building2}
          disabled={start.isPending || running} onClick={() => start.mutate("building")}
        />
        <SyncButton
          label="Sync Units" scope="unit" icon={Home}
          disabled={start.isPending || running} onClick={() => start.mutate("unit")}
        />
        <SyncButton
          label="Sync Everything" scope="all" icon={RefreshCw} primary
          disabled={start.isPending || running} onClick={() => start.mutate("all")}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Sync History</CardTitle>
          <CardDescription>Most recent 20 runs.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2">
          {jobs.isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
          {!jobs.isLoading && (jobs.data?.jobs ?? []).length === 0 && (
            <p className="text-sm text-muted-foreground">No syncs yet. Click a button above to start one.</p>
          )}
          {(jobs.data?.jobs ?? []).map((j) => {
            const pct = j.total > 0 ? Math.round((j.processed / j.total) * 100) : j.status === "running" ? 5 : 100;
            return (
              <div key={j.id} className="rounded-md border p-3 space-y-2">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm">
                    {j.status === "running" && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                    <span className="font-medium capitalize">{j.scope}</span>
                    <StatusBadge status={j.status} />
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {new Date(j.started_at).toLocaleString()}
                  </span>
                </div>
                <Progress value={pct} className="h-1.5" />
                <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
                  <span>Processed: <strong className="text-foreground">{j.processed} / {j.total || "?"}</strong></span>
                  <span>Created: <strong className="text-foreground">{j.created_count}</strong></span>
                  <span>Updated: <strong className="text-foreground">{j.updated_count}</strong></span>
                  {j.error_count > 0 && <span>Errors: <strong className="text-destructive">{j.error_count}</strong></span>}
                </div>
                {j.error_summary && (
                  <div className="text-xs text-destructive truncate" title={j.error_summary}>
                    {j.error_summary}
                  </div>
                )}
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}

function SyncButton({
  label, icon: Icon, disabled, onClick, primary,
}: {
  label: string;
  scope: string;
  icon: React.ComponentType<{ className?: string }>;
  disabled: boolean;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <Card className={primary ? "border-primary" : ""}>
      <CardContent className="flex flex-col items-start gap-3 p-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-5 w-5" />
        </div>
        <div className="text-sm font-medium">{label}</div>
        <Button
          size="sm"
          variant={primary ? "default" : "outline"}
          className="w-full"
          disabled={disabled}
          onClick={onClick}
        >
          {disabled ? "…" : "Start"}
        </Button>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant =
    status === "success" ? "default" :
    status === "running" ? "secondary" :
    status === "partial" ? "outline" :
    "destructive";
  return <Badge variant={variant}>{status}</Badge>;
}
