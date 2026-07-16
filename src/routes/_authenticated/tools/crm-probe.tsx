import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getCrmFieldSchema, probeCrmWriteScopes, type CrmField } from "@/lib/crm-probe.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Check, X, FlaskConical, ListTree, Copy, AlertTriangle } from "lucide-react";
import { toast } from "sonner";

/**
 * Groundwork for the Lazers contact + opportunity import.
 *
 * Two things have to be true before 750 API calls get written:
 *   1. we know the exact contact/opportunity field keys and picklist values
 *   2. the token actually holds contacts.write, opportunities.write and
 *      associations/relation.write
 *
 * Discovering either at row 400 of a live import is the expensive way. This
 * page discovers both in about ten seconds.
 */

export const Route = createFileRoute("/_authenticated/tools/crm-probe")({
  component: CrmProbePage,
});

function CrmProbePage() {
  const schemaFn = useServerFn(getCrmFieldSchema);
  const probeFn = useServerFn(probeCrmWriteScopes);

  const schema = useMutation({
    mutationFn: () => schemaFn(),
    onError: (e: Error) => toast.error(e.message),
  });

  const probe = useMutation({
    mutationFn: () => probeFn({ data: { confirm: "RUN" as const } }),
    onError: (e: Error) => toast.error(e.message),
  });

  const copy = async (v: string) => {
    await navigator.clipboard.writeText(v);
    toast.success("Copied");
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">CRM Probe</h1>
        <p className="mt-1 text-muted-foreground">
          Groundwork for the contact import. Reads the real field schema out of GHL, and verifies the
          token holds the write permissions the import needs.
        </p>
      </div>

      {/* ---------------- field schema ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <ListTree className="h-4 w-4" /> Field schema
          </CardTitle>
          <CardDescription>
            Read-only. Nothing is written. This settles the exact picklist values &mdash; “Buyer” vs
            “buyer” is the difference between a clean run and 183 rows of 422s.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={() => schema.mutate()} disabled={schema.isPending}>
            {schema.isPending ? "Reading…" : "Load field schema"}
          </Button>

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
            Creates a throwaway contact, a throwaway opportunity and one association, then deletes all
            three. Safe by construction: the opportunity goes into a <strong>release stage</strong> (maps
            to Available, so it can’t reserve anything) and the association uses the{" "}
            <strong>Suggested</strong> label, which the engine ignores end to end. Nothing here can move
            real inventory even if every cleanup step failed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button variant="outline" onClick={() => probe.mutate()} disabled={probe.isPending}>
            {probe.isPending ? "Probing…" : "Run write probe"}
          </Button>

          {probe.data && (
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
                    <div className="mt-0.5 break-words font-mono text-xs text-muted-foreground">
                      {s.detail}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FieldTable({
  title,
  fields,
  onCopy,
}: {
  title: string;
  fields: CrmField[];
  onCopy: (v: string) => void;
}) {
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
                <Badge variant="outline" className="shrink-0 text-[10px]">
                  {f.dataType || "?"}
                </Badge>
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
                  <code
                    key={o}
                    className="rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]"
                    title="Exact value the API expects"
                  >
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
