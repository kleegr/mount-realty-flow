import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { confirmImport, getJob } from "@/lib/import.functions";
import { flexUndo, flexFailedCsv } from "@/lib/flex-import.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AlertCircle, ArrowLeft, CheckCircle2, Copy, Download, PlayCircle, Undo2 } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/import/$jobId")({
  component: JobPage,
});

function JobPage() {
  const { jobId } = Route.useParams();
  const qc = useQueryClient();
  const getJobFn = useServerFn(getJob);
  const confirmFn = useServerFn(confirmImport);
  const undoFn = useServerFn(flexUndo);
  const failedCsvFn = useServerFn(flexFailedCsv);

  const { data, isLoading } = useQuery({
    queryKey: ["import-job", jobId],
    queryFn: () => getJobFn({ data: { jobId } }),
    refetchInterval: (q) => (q.state.data?.job.status === "running" ? 1500 : false),
  });

  const confirm = useMutation({
    mutationFn: () => confirmFn({ data: { jobId } }),
    onSuccess: (res) => {
      toast.success(`Import ${res.report.status.replace(/_/g, " ")}`);
      qc.invalidateQueries({ queryKey: ["import-job", jobId] });
      qc.invalidateQueries({ queryKey: ["dashboard"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Import failed"),
  });

  const undo = useMutation({
    mutationFn: () => undoFn({ data: { jobId } }),
    onSuccess: (res) => {
      toast.success(`Undo complete — reversed ${res.reversed}, failed ${res.failed}`);
      qc.invalidateQueries({ queryKey: ["import-job", jobId] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Undo failed"),
  });

  async function downloadFailedRows() {
    const { csv } = await failedCsvFn({ data: { jobId } });
    if (!csv) return toast.info("No failed rows for this job");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `failed-rows-${jobId}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  if (isLoading || !data) return <div className="text-muted-foreground">Loading job…</div>;

  const job = data.job;
  const items = data.items;
  const validation = (job.validation_snapshot ?? {}) as {
    mode?: string;
    projects?: unknown[];
    buildings?: unknown[];
    units?: unknown[];
    errors?: { message: string; rowNumber?: number }[];
    warnings?: { message: string; rowNumber?: number }[];
  };
  const errors = validation.errors ?? [];
  const warnings = validation.warnings ?? [];
  const canConfirm = job.status === "awaiting_confirm" && errors.length === 0;
  const isTerminal = ["success", "success_with_warnings", "partial_failure", "failed"].includes(job.status);
  const report = (job.report ?? null) as null | {
    projects_created?: number; projects_updated?: number;
    buildings_created?: number; buildings_updated?: number;
    units_created?: number; units_updated?: number;
    associations_ok?: number; associations_failed?: number;
    rollup_ok?: number; rollup_failed?: number;
    errors?: { scope: string; ref: string; message: string }[];
    warnings?: string[];
    per_scope?: {
      project?: { created?: number; updated?: number; skipped?: number; failed?: number };
      building?: { created?: number; updated?: number; skipped?: number; failed?: number };
      unit?: { created?: number; updated?: number; skipped?: number; failed?: number };
    };
  };

  function copyReport() {
    navigator.clipboard.writeText(JSON.stringify({ job, report }, null, 2));
    toast.success("Report copied to clipboard");
  }

  function downloadReport() {
    const rows = [
      ["Field", "Value"],
      ["Job ID", job.id],
      ["Filename", job.filename ?? ""],
      ["Mode", job.mode ?? ""],
      ["Status", job.status],
      ["Started", job.started_at ?? ""],
      ["Completed", job.completed_at ?? ""],
      ["Projects created", String(job.projects_created)],
      ["Projects updated", String(job.projects_updated)],
      ["Buildings created", String(job.buildings_created)],
      ["Buildings updated", String(job.buildings_updated)],
      ["Units created", String(job.units_created)],
      ["Units updated", String(job.units_updated)],
      ["Errors", String(job.errors_count)],
      ["Warnings", String(job.warnings_count)],
    ];
    const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `import-report-${job.id}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" asChild><Link to="/import"><ArrowLeft className="mr-2 h-4 w-4" />Back</Link></Button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{job.filename ?? "Import Job"}</h1>
          <div className="mt-1 flex items-center gap-2 text-sm text-muted-foreground">
            <Badge variant="outline">{job.mode ?? "unknown mode"}</Badge>
            <StatusBadge status={job.status} />
            <span>{new Date(job.created_at).toLocaleString()}</span>
          </div>
        </div>
        <div className="flex gap-2">
          {job.status === "awaiting_confirm" && (
            <Button onClick={() => confirm.mutate()} disabled={!canConfirm || confirm.isPending} size="lg">
              <PlayCircle className="mr-2 h-4 w-4" />
              {confirm.isPending ? "Running…" : "Confirm Import"}
            </Button>
          )}
          {isTerminal && (
            <>
              <Button variant="outline" onClick={copyReport}><Copy className="mr-2 h-4 w-4" />Copy Report</Button>
              <Button variant="outline" onClick={downloadReport}><Download className="mr-2 h-4 w-4" />Download CSV</Button>
              {job.mode === "flexible" && (
                <>
                  <Button variant="outline" onClick={downloadFailedRows}><Download className="mr-2 h-4 w-4" />Failed Rows CSV</Button>
                  {!job.undone_at && (
                    <Button variant="destructive" onClick={() => { if (confirm.isPending) return; if (window.confirm("Undo this import? This deletes newly-created records and reverts updates.")) undo.mutate(); }} disabled={undo.isPending}>
                      <Undo2 className="mr-2 h-4 w-4" />{undo.isPending ? "Undoing…" : "Undo Import"}
                    </Button>
                  )}
                  {job.undone_at && <Badge variant="outline">Undone {new Date(job.undone_at).toLocaleDateString()}</Badge>}
                </>
              )}
            </>
          )}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total rows" value={job.row_count} />
        <Stat label="Projects" value={(validation.projects ?? []).length} />
        <Stat label="Buildings" value={(validation.buildings ?? []).length} />
        <Stat label="Units" value={(validation.units ?? []).length} />
      </div>

      {errors.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>{errors.length} blocking error{errors.length === 1 ? "" : "s"} — import disabled</AlertTitle>
          <AlertDescription>Fix your file and re-upload before confirming.</AlertDescription>
        </Alert>
      )}
      {errors.length === 0 && job.status === "awaiting_confirm" && (
        <Alert>
          <CheckCircle2 className="h-4 w-4" />
          <AlertTitle>Ready to import</AlertTitle>
          <AlertDescription>No blocking errors. Review previews then click Confirm Import.</AlertDescription>
        </Alert>
      )}

      {report && (() => {
        const reportWarnings = report.warnings ?? [];
        const reportErrors = report.errors ?? [];
        const projectsCreated = report.projects_created ?? report.per_scope?.project?.created ?? 0;
        const projectsUpdated = report.projects_updated ?? report.per_scope?.project?.updated ?? 0;
        const buildingsCreated = report.buildings_created ?? report.per_scope?.building?.created ?? 0;
        const buildingsUpdated = report.buildings_updated ?? report.per_scope?.building?.updated ?? 0;
        const unitsCreated = report.units_created ?? report.per_scope?.unit?.created ?? 0;
        const unitsUpdated = report.units_updated ?? report.per_scope?.unit?.updated ?? 0;
        return (
        <Card>
          <CardHeader>
            <CardTitle>Final Import Report</CardTitle>
            <CardDescription>Read-back verified results from the CRM.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
            <ReportRow label="Projects created / updated" value={`${projectsCreated} / ${projectsUpdated}`} />
            <ReportRow label="Buildings created / updated" value={`${buildingsCreated} / ${buildingsUpdated}`} />
            <ReportRow label="Units created / updated" value={`${unitsCreated} / ${unitsUpdated}`} />
            <ReportRow label="Associations OK / failed" value={`${report.associations_ok ?? 0} / ${report.associations_failed ?? 0}`} />
            <ReportRow label="Rollups OK / failed" value={`${report.rollup_ok ?? 0} / ${report.rollup_failed ?? 0}`} />
            <ReportRow label="Warnings" value={String(reportWarnings.length)} />
            {reportErrors.length > 0 && (
              <div className="col-span-full">
                <div className="mb-1 text-sm font-semibold text-destructive">Errors ({reportErrors.length})</div>
                <ul className="space-y-1 text-sm">
                  {reportErrors.map((e, i) => (
                    <li key={i} className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1">
                      <b>{e.scope}</b> {e.ref}: {e.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </CardContent>
        </Card>
        );
      })()}

      <Tabs defaultValue="projects">
        <TabsList>
          <TabsTrigger value="projects">Projects ({(validation.projects ?? []).length})</TabsTrigger>
          <TabsTrigger value="buildings">Buildings ({(validation.buildings ?? []).length})</TabsTrigger>
          <TabsTrigger value="units">Units ({(validation.units ?? []).length})</TabsTrigger>
          <TabsTrigger value="issues">Errors & Warnings ({errors.length + warnings.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="projects">
          <PreviewList items={items.filter((i) => i.scope === "project")} scopeLabel="Project" />
        </TabsContent>
        <TabsContent value="buildings">
          <PreviewList items={items.filter((i) => i.scope === "building")} scopeLabel="Building" />
        </TabsContent>
        <TabsContent value="units">
          <PreviewList items={items.filter((i) => i.scope === "unit")} scopeLabel="Unit" />
        </TabsContent>
        <TabsContent value="issues">
          <Card>
            <CardContent className="space-y-2 py-4">
              {errors.length === 0 && warnings.length === 0 && (
                <p className="text-sm text-muted-foreground">No issues found.</p>
              )}
              {errors.map((e, i) => (
                <div key={"e" + i} className="rounded border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm">
                  <Badge variant="destructive" className="mr-2">Error</Badge>
                  {e.rowNumber ? <span className="text-muted-foreground">Row {e.rowNumber}: </span> : null}
                  {e.message}
                </div>
              ))}
              {warnings.map((w, i) => (
                <div key={"w" + i} className="rounded border border-warning/40 bg-warning/5 px-3 py-2 text-sm">
                  <Badge className="mr-2 bg-warning text-warning-foreground">Warning</Badge>
                  {w.rowNumber ? <span className="text-muted-foreground">Row {w.rowNumber}: </span> : null}
                  {w.message}
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <Card>
      <CardContent className="py-4">
        <div className="text-xs uppercase text-muted-foreground">{label}</div>
        <div className="text-2xl font-bold">{value}</div>
      </CardContent>
    </Card>
  );
}

function ReportRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border px-3 py-2">
      <div className="text-xs uppercase text-muted-foreground">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const variant = status === "success" ? "default" :
    status === "success_with_warnings" ? "secondary" :
    status === "partial_failure" || status === "failed" ? "destructive" : "outline";
  return <Badge variant={variant}>{status.replace(/_/g, " ")}</Badge>;
}

type Item = {
  id: string;
  scope: string;
  external_import_id: string | null;
  import_row_id: string | null;
  action: string;
  matched_crm_id: string | null;
  source: unknown;
  proposed: unknown;
  messages: unknown;
};

function PreviewList({ items, scopeLabel }: { items: Item[]; scopeLabel: string }) {
  if (items.length === 0) return <Card><CardContent className="py-6 text-center text-sm text-muted-foreground">No {scopeLabel.toLowerCase()}s in this import.</CardContent></Card>;
  return (
    <div className="space-y-2">
      {items.map((it) => {
        const proposed = (it.proposed ?? {}) as Record<string, unknown>;
        const messages = (it.messages ?? []) as Array<{ level: string; message: string }>;
        return (
          <Card key={it.id}>
            <CardContent className="py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={it.action === "error" ? "destructive" : "default"}>{it.action.toUpperCase()}</Badge>
                <span className="font-semibold">{scopeLabel} {it.external_import_id}</span>
                {it.matched_crm_id && <Badge variant="outline">matched {it.matched_crm_id.slice(0, 10)}…</Badge>}
              </div>
              <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2 md:grid-cols-3">
                {Object.entries(proposed).slice(0, 8).map(([k, v]) => (
                  <div key={k}><b className="text-foreground">{k}</b>: {String(v ?? "")}</div>
                ))}
              </div>
              {messages.length > 0 && (
                <div className="mt-2 space-y-1">
                  {messages.map((m, i) => (
                    <div key={i} className={`text-xs ${m.level === "error" ? "text-destructive" : "text-warning-foreground"}`}>• {m.message}</div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
