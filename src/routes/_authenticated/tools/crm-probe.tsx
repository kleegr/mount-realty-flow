import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCrmFieldSchema, probeCrmWriteScopes, type CrmField } from "@/lib/crm-probe.functions";
import { getInventoryPosture } from "@/lib/inventory-posture.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Check, X, FlaskConical, ListTree, Copy, AlertTriangle, ClipboardCopy, Activity } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/tools/crm-probe")({
  component: CrmProbePage,
});

function CrmProbePage() {
  const schemaFn = useServerFn(getCrmFieldSchema);
  const probeFn = useServerFn(probeCrmWriteScopes);
  const postureFn = useServerFn(getInventoryPosture);

  const posture = useMutation({
    mutationFn: () => postureFn(),
    onError: (e: Error) => toast.error(e.message),
  });
  const schema = useMutation({
    mutationFn: () => schemaFn(),
    onError: (e: Error) => toast.error(e.message),
  });
  const probe = useMutation({
    mutationFn: () => probeFn({ data: { confirm: "RUN" as const } }),
    onError: (e: Error) => toast.error(e.message),
  });

  const copy = async (v: string, label = "Copied") => {
    await navigator.clipboard.writeText(v);
    toast.success(label);
  };

  const copyAll = async () => {
    if (!schema.data?.ok) return;
    const compact = (fs: CrmField[]) =>
      fs.map((f) => ({ name: f.name, key: f.fieldKey, id: f.id, type: f.dataType, ...(f.options.length ? { options: f.options } : {}) }));
    const payload = {
      contact: compact(schema.data.contact),
      opportunity: compact(schema.data.opportunity),
      other: compact(schema.data.other),
    };
    await copy(JSON.stringify(payload, null, 2), "Schema copied — paste it into the chat");
  };

  const p = posture.data;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">CRM Probe</h1>
        <p className="mt-1 text-muted-foreground">
          What is actually in GHL right now, what the token may write, and the exact field schema.
        </p>
      </div>

      {/* ---------------- posture ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Activity className="h-4 w-4" /> Inventory posture
          </CardTitle>
          <CardDescription>
            Read-only. Answers two questions before anything destructive: would a recalc be safe, and do
            opportunities already exist.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={() => posture.mutate()} disabled={posture.isPending}>
            {posture.isPending ? "Reading…" : "Check posture"}
          </Button>

          {p && (
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <Stat label="Units" value={p.inventory.units} />
                <Stat label="Buildings" value={p.inventory.buildings} />
                <Stat label="Projects" value={p.inventory.projects} />
                <Stat label="Contacts mapped" value={p.contactsMapped} />
              </div>

              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                <Stat label="unit_state rows" value={p.mirror.unitStateRows} />
                <Stat label="Units with NO state" value={p.mirror.unitsWithoutState} danger={p.mirror.unitsWithoutState > 0} />
                <Stat label="Units holding a stage" value={p.mirror.unitsWithAStage} />
              </div>

              {p.mirror.unitsWithoutState > 0 && (
                <Alert variant="destructive">
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription className="text-sm">{p.readings.recalcWouldZero}</AlertDescription>
                </Alert>
              )}

              <div>
                <h3 className="mb-2 text-sm font-semibold">Opportunities in GHL</h3>
                {p.crmError ? (
                  <Alert variant="destructive">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription className="text-sm">{p.crmError}</AlertDescription>
                  </Alert>
                ) : (
                  <div className="space-y-1.5">
                    {p.pipelines.map((pl) => (
                      <div key={pl.id} className="flex items-center justify-between gap-3 rounded-md border p-2.5">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{pl.name}</div>
                          {pl.note && <div className="font-mono text-[11px] text-muted-foreground">{pl.note}</div>}
                        </div>
                        <Badge variant={pl.opportunities ? "secondary" : "outline"} className="shrink-0">
                          {pl.opportunities ?? "?"}
                        </Badge>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <Alert variant={p.totalOpportunities > 0 ? "destructive" : "default"}>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">{p.readings.opportunityRisk}</AlertDescription>
              </Alert>

              <div>
                <h3 className="mb-1.5 text-sm font-semibold">Mirrored availability</h3>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(p.mirror.byAvailability).map(([k, v]) => (
                    <code key={k} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
                      {k}: {v}
                    </code>
                  ))}
                </div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- field schema ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ListTree className="h-4 w-4" /> Field schema
          </CardTitle>
          <CardDescription>
            Read-only. Load it, then hit <strong>Copy schema JSON</strong> and paste that into the chat.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => schema.mutate()} disabled={schema.isPending}>
              {schema.isPending ? "Reading…" : "Load field schema"}
            </Button>
            {schema.data?.ok && (
              <Button variant="secondary" onClick={copyAll}>
                <ClipboardCopy className="mr-2 h-4 w-4" /> Copy schema JSON
              </Button>
            )}
          </div>

          {schema.data && !schema.data.ok && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                <div className="font-medium">{schema.data.error}</div>
                <div className="mt-1 text-xs opacity-90">{schema.data.hint}</div>
              </AlertDescription>
            </Alert>
          )}

          {schema.data?.ok && (
            <div className="space-y-5">
              <p className="text-sm text-muted-foreground">
                {schema.data.count} custom fields · {schema.data.contact.length} contact ·{" "}
                {schema.data.opportunity.length} opportunity · {schema.data.other.length} other
              </p>
              <FieldTable title="Contact fields" fields={schema.data.contact} onCopy={copy} />
              <FieldTable title="Opportunity fields" fields={schema.data.opportunity} onCopy={copy} />
              {schema.data.other.length > 0 && (
                <FieldTable title="Other / unclassified" fields={schema.data.other} onCopy={copy} />
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ---------------- write scopes ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <FlaskConical className="h-4 w-4" /> Write scopes
          </CardTitle>
          <CardDescription>
            Creates a throwaway contact, opportunity and association, then deletes all three. Safe by
            construction: release stage (maps to Available) + the <strong>Suggested</strong> label, which
            the engine ignores end to end.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button variant="outline" onClick={() => probe.mutate()} disabled={probe.isPending}>
            {probe.isPending ? "Probing…" : "Run write probe"}
          </Button>

          {probe.data && (
            <>
              <div className="space-y-1.5">
                {probe.data.steps.map((s, i) => (
                  <div key={i} className="flex items-start gap-3 rounded-md border p-2.5">
                    {s.ok ? (
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                    ) : (
                      <X className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{s.step}</div>
                      <div className="mt-0.5 break-words font-mono text-xs text-muted-foreground">{s.detail}</div>
                    </div>
                  </div>
                ))}
              </div>

              {probe.data.relationSample != null && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-semibold">Real relation — raw shape</h3>
                    <Button size="sm" variant="ghost" onClick={() => copy(JSON.stringify(probe.data.relationSample, null, 2))}>
                      <Copy className="mr-2 h-3.5 w-3.5" /> Copy
                    </Button>
                  </div>
                  <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
                    {JSON.stringify(probe.data.relationSample, null, 2)}
                  </pre>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={danger ? "text-2xl font-bold text-destructive" : "text-2xl font-bold"}>{value}</div>
    </div>
  );
}

function FieldTable({ title, fields, onCopy }: { title: string; fields: CrmField[]; onCopy: (v: string) => void }) {
  if (fields.length === 0) {
    return (
      <div>
        <h3 className="mb-2 text-sm font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">None found.</p>
      </div>
    );
  }
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold">
        {title} <span className="font-normal text-muted-foreground">({fields.length})</span>
      </h3>
      <div className="space-y-1.5">
        {fields.map((f) => (
          <div key={f.id} className="rounded-md border p-2.5">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">{f.name || "(unnamed)"}</span>
                <Badge variant="outline" className="shrink-0 text-[10px]">{f.dataType || "?"}</Badge>
              </div>
              <Button size="sm" variant="ghost" onClick={() => onCopy(f.fieldKey || f.id)}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <code className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
              {f.fieldKey || "—"} · {f.id}
            </code>
            {f.options.length > 0 && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                {f.options.map((o) => (
                  <code key={o} className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]" title="Exact value the API expects">
                    {o}
                  </code>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
