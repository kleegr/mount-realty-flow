import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getDashboardSnapshot } from "@/lib/inventory.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Building2, Home, Layers, Upload, Activity, Webhook } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { PendingEventsCard } from "@/components/kleegr/PendingEventsCard";

export const Route = createFileRoute("/_authenticated/dashboard")({
  component: Dashboard,
});

function Dashboard() {
  const fetch = useServerFn(getDashboardSnapshot);
  const { data, isLoading } = useQuery({ queryKey: ["dashboard"], queryFn: () => fetch() });

  return (
    <div className="space-y-8">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Inventory Dashboard</h1>
          <p className="mt-1 text-muted-foreground">Live view of Projects, Buildings and Units synced with the CRM.</p>
        </div>
        <Button asChild>
          <Link to="/import"><Upload className="mr-2 h-4 w-4" />Start an Import</Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Projects" value={data?.counts.projects ?? "—"} icon={Layers} loading={isLoading} />
        <StatCard label="Buildings" value={data?.counts.buildings ?? "—"} icon={Building2} loading={isLoading} />
        <StatCard label="Units" value={data?.counts.units ?? "—"} icon={Home} loading={isLoading} />
      </div>

      <PendingEventsCard />

      <div className="grid gap-6 lg:grid-cols-2">

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg"><Upload className="h-4 w-4" />Recent Imports</CardTitle>
            <CardDescription>Latest bulk uploads processed by the Import Center.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(data?.recentJobs ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No imports yet. Head to the Import Center to upload your first file.</p>
            )}
            {(data?.recentJobs ?? []).map((j) => (
              <Link
                key={j.id}
                to="/import/$jobId"
                params={{ jobId: j.id }}
                className="flex items-center justify-between rounded-md border px-3 py-2 hover:bg-muted"
              >
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">{j.filename ?? "Untitled"}</div>
                  <div className="text-xs text-muted-foreground">
                    {new Date(j.created_at).toLocaleString()} · {j.units_created + j.units_updated} units
                  </div>
                </div>
                <StatusBadge status={j.status} />
              </Link>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-lg"><Webhook className="h-4 w-4" />Recent Automation Events</CardTitle>
            <CardDescription>Opportunity stage changes and manual corrections.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(data?.recentWebhooks ?? []).length === 0 && (data?.recentAudit ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">No automation events yet.</p>
            )}
            {(data?.recentWebhooks ?? []).map((w) => (
              <div key={w.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">Opportunity → {w.outcome ?? "pending"}</div>
                  <div className="text-xs text-muted-foreground">{new Date(w.received_at).toLocaleString()}</div>
                </div>
                <Badge variant="outline">{w.stage_id?.slice(0, 8) ?? "—"}</Badge>
              </div>
            ))}
            {(data?.recentAudit ?? []).map((a) => (
              <div key={a.id} className="flex items-center justify-between rounded-md border px-3 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium flex items-center gap-2"><Activity className="h-3 w-3" />{a.kind}</div>
                  <div className="truncate text-xs text-muted-foreground">{a.reason ?? "—"}</div>
                </div>
                <span className="text-xs text-muted-foreground">{new Date(a.created_at).toLocaleDateString()}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function StatCard({ label, value, icon: Icon, loading }: { label: string; value: string | number; icon: React.ComponentType<{ className?: string }>; loading?: boolean }) {
  return (
    <Card className="shadow-card">
      <CardContent className="flex items-center gap-4 p-6">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon className="h-6 w-6" />
        </div>
        <div>
          <div className="text-sm font-medium text-muted-foreground">{label}</div>
          <div className="text-3xl font-bold">{loading ? "…" : value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === "success" ? "default" :
    status === "success_with_warnings" ? "secondary" :
    status === "partial_failure" || status === "failed" ? "destructive" : "outline";
  return <Badge variant={variant}>{status.replace(/_/g, " ")}</Badge>;
}
