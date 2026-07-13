import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getCrmConfig, updateCrmConfig, getMyRoles, listPipelines, upsertPipeline, deletePipeline } from "@/lib/crm-config.functions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { useEffect, useState } from "react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/crm")({
  component: Settings,
});

function Settings() {
  const qc = useQueryClient();
  const cfgFn = useServerFn(getCrmConfig);
  const updFn = useServerFn(updateCrmConfig);
  const roleFn = useServerFn(getMyRoles);
  const { data } = useQuery({ queryKey: ["crm-config"], queryFn: () => cfgFn() });
  const { data: roles } = useQuery({ queryKey: ["my-roles"], queryFn: () => roleFn() });
  const isAdmin = (roles?.roles ?? []).includes("admin");

  const [form, setForm] = useState<Record<string, string>>({});
  useEffect(() => {
    if (data?.config) {
      const c = data.config as unknown as Record<string, string | null>;
      const init: Record<string, string> = {};
      for (const k of Object.keys(c)) init[k] = c[k] == null ? "" : String(c[k]);
      setForm(init);
    }
  }, [data]);

  const save = useMutation({
    mutationFn: (payload: Record<string, string>) => updFn({ data: payload }),
    onSuccess: () => { toast.success("Settings saved"); qc.invalidateQueries({ queryKey: ["crm-config"] }); },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!isAdmin) return toast.error("Admin role required");
    save.mutate({
      location_id: form.location_id ?? "",
      api_base_url: form.api_base_url ?? "https://services.leadconnectorhq.com",
      project_object_key: form.project_object_key ?? "custom_objects.projects",
      building_object_key: form.building_object_key ?? "custom_objects.buildings",
      unit_object_key: form.unit_object_key ?? "custom_objects.units",
      project_object_id: form.project_object_id ?? "",
      building_object_id: form.building_object_id ?? "",
      unit_object_id: form.unit_object_id ?? "",
      opportunity_pipeline_id: form.opportunity_pipeline_id ?? "",
      stage_reserved_id: form.stage_reserved_id ?? "",
      stage_under_contract_id: form.stage_under_contract_id ?? "",
      stage_closed_id: form.stage_closed_id ?? "",
      stage_release_id: form.stage_release_id ?? "",
      template_xlsx_url: form.template_xlsx_url ?? "",
    });
  }

  const webhookUrl = typeof window !== "undefined"
    ? `${window.location.origin}/api/public/webhooks/ghl/opportunity-stage`
    : "/api/public/webhooks/ghl/opportunity-stage";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">CRM Settings</h1>
        <p className="mt-1 text-muted-foreground">CRM connection, object IDs, pipeline stage mapping and webhook.</p>
      </div>

      {!isAdmin && <Alert><AlertTitle>Read-only view</AlertTitle><AlertDescription>Only admins can change these values.</AlertDescription></Alert>}
      <Alert variant={data?.tokenConfigured ? "default" : "destructive"}>
        <AlertTitle>CRM Token</AlertTitle>
        <AlertDescription>
          {data?.tokenConfigured
            ? "A CRM token is configured (server-side, not shown here)."
            : "No CRM token configured. Ask an admin to add the KLEEGR_CRM_TOKEN secret."}
        </AlertDescription>
      </Alert>

      <form onSubmit={onSubmit} className="space-y-6">
        <Card>
          <CardHeader><CardTitle>Connection</CardTitle></CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Location ID" k="location_id" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="API Base URL" k="api_base_url" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="Excel template URL (public)" k="template_xlsx_url" form={form} setForm={setForm} readOnly={!isAdmin} />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Custom Objects</CardTitle>
            <CardDescription>Use the schema keys from CRM Custom Objects, for example custom_objects.project.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-3">
            <Field label="Project schema key" k="project_object_key" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="Building schema key" k="building_object_key" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="Unit schema key" k="unit_object_key" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="Project object ID" k="project_object_id" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="Building object ID" k="building_object_id" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="Unit object ID" k="unit_object_id" form={form} setForm={setForm} readOnly={!isAdmin} />
          </CardContent>
        </Card>

        {/* Legacy single-pipeline fields kept as fallback; the multi-pipeline manager below is preferred. */}
      </form>

      <PipelinesManager isAdmin={isAdmin} />

      <form onSubmit={onSubmit} className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>Legacy Single-Pipeline Mapping (Fallback)</CardTitle>
            <CardDescription>Used only when a webhook arrives for a pipeline that is not listed above.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 md:grid-cols-2">
            <Field label="Pipeline ID" k="opportunity_pipeline_id" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="Stage → Reserved / Locked" k="stage_reserved_id" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="Stage → Under Contract" k="stage_under_contract_id" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="Stage → Closed / Sold" k="stage_closed_id" form={form} setForm={setForm} readOnly={!isAdmin} />
            <Field label="Stage → Release (Available)" k="stage_release_id" form={form} setForm={setForm} readOnly={!isAdmin} />
          </CardContent>
        </Card>

        {isAdmin && (
          <div className="flex justify-end">
            <Button type="submit" disabled={save.isPending} size="lg">{save.isPending ? "Saving…" : "Save Settings"}</Button>
          </div>
        )}
      </form>

      <Card>
        <CardHeader>
          <CardTitle>Webhook</CardTitle>
          <CardDescription>Point the CRM Opportunity Stage Changed workflow at this URL. Include a header <code>x-kleegr-secret</code> with the shared secret (or sign the body with <code>x-kleegr-signature: sha256=&lt;hex&gt;</code>).</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md bg-muted px-3 py-2 font-mono text-sm break-all">{webhookUrl}</div>
          <p className="text-sm text-muted-foreground">
            Send JSON with <code>pipeline_id</code>, <code>stage_id</code>, <code>opportunity_id</code>, and a <code>unit_crm_id</code> or <code>unit_external_import_id</code>. Duplicate events are deduped via <code>event_id</code>.
          </p>
          <div className="flex gap-2">
            <Badge variant="outline">HMAC-verified</Badge>
            <Badge variant="outline">Idempotent</Badge>
            <Badge variant="outline">Sold-reversal protected</Badge>
            <Badge variant="outline">Double-reservation guard</Badge>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, k, form, setForm, readOnly }: {
  label: string; k: string;
  form: Record<string, string>; setForm: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={k}>{label}</Label>
      <Input
        id={k}
        value={form[k] ?? ""}
        onChange={(e) => setForm((prev) => ({ ...prev, [k]: e.target.value }))}
        readOnly={readOnly}
      />
    </div>
  );
}

type PipelineRow = {
  id: string;
  pipeline_id: string;
  label: string | null;
  stage_reserved_id: string | null;
  stage_under_contract_id: string | null;
  stage_closed_id: string | null;
  stage_release_id: string | null;
};

function PipelinesManager({ isAdmin }: { isAdmin: boolean }) {
  const qc = useQueryClient();
  const listFn = useServerFn(listPipelines);
  const upsertFn = useServerFn(upsertPipeline);
  const deleteFn = useServerFn(deletePipeline);
  const { data } = useQuery({ queryKey: ["crm-pipelines"], queryFn: () => listFn() });
  const pipelines = (data?.pipelines ?? []) as PipelineRow[];

  const emptyDraft = {
    pipeline_id: "",
    label: "",
    stage_reserved_id: "",
    stage_under_contract_id: "",
    stage_closed_id: "",
    stage_release_id: "",
  };
  const [draft, setDraft] = useState<Record<string, string>>(emptyDraft);

  const save = useMutation({
    mutationFn: (payload: Record<string, string> & { id?: string }) => upsertFn({ data: payload }),
    onSuccess: () => {
      toast.success("Pipeline saved");
      qc.invalidateQueries({ queryKey: ["crm-pipelines"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Save failed"),
  });

  const del = useMutation({
    mutationFn: (id: string) => deleteFn({ data: { id } }),
    onSuccess: () => {
      toast.success("Pipeline removed");
      qc.invalidateQueries({ queryKey: ["crm-pipelines"] });
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : "Delete failed"),
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle>Pipelines → Unit Stage Mapping</CardTitle>
        <CardDescription>
          Add every CRM pipeline that should drive inventory. Each pipeline gets its own 4 stage IDs
          (Reserved/Locked, Under Contract, Closed/Sold, Release). The webhook picks the matching
          pipeline automatically — so 2+ pipelines run in parallel.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {pipelines.length === 0 && (
          <p className="text-sm text-muted-foreground">No pipelines added yet.</p>
        )}
        {pipelines.map((p) => (
          <PipelineRowEditor key={p.id} row={p} isAdmin={isAdmin} onSave={(payload) => save.mutate({ ...payload, id: p.id })} onDelete={() => del.mutate(p.id)} />
        ))}

        {isAdmin && (
          <div className="rounded-md border p-4 space-y-4">
            <div className="text-sm font-medium">Add a new pipeline</div>
            <div className="grid gap-4 md:grid-cols-2">
              <DraftField label="Label (any name)" k="label" draft={draft} setDraft={setDraft} />
              <DraftField label="Pipeline ID" k="pipeline_id" draft={draft} setDraft={setDraft} />
              <DraftField label="Stage → Reserved / Locked" k="stage_reserved_id" draft={draft} setDraft={setDraft} />
              <DraftField label="Stage → Under Contract" k="stage_under_contract_id" draft={draft} setDraft={setDraft} />
              <DraftField label="Stage → Closed / Sold" k="stage_closed_id" draft={draft} setDraft={setDraft} />
              <DraftField label="Stage → Release (Available)" k="stage_release_id" draft={draft} setDraft={setDraft} />
            </div>
            <div className="flex justify-end">
              <Button
                type="button"
                disabled={save.isPending || !draft.pipeline_id}
                onClick={() => {
                  save.mutate(draft);
                  setDraft(emptyDraft);
                }}
              >
                Add pipeline
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PipelineRowEditor({ row, isAdmin, onSave, onDelete }: {
  row: PipelineRow; isAdmin: boolean;
  onSave: (payload: Record<string, string>) => void;
  onDelete: () => void;
}) {
  const [form, setForm] = useState<Record<string, string>>({
    pipeline_id: row.pipeline_id,
    label: row.label ?? "",
    stage_reserved_id: row.stage_reserved_id ?? "",
    stage_under_contract_id: row.stage_under_contract_id ?? "",
    stage_closed_id: row.stage_closed_id ?? "",
    stage_release_id: row.stage_release_id ?? "",
  });
  return (
    <div className="rounded-md border p-4 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium">{row.label || row.pipeline_id}</div>
        {isAdmin && (
          <Button type="button" variant="ghost" size="sm" onClick={onDelete}>Remove</Button>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <DraftField label="Label" k="label" draft={form} setDraft={setForm} readOnly={!isAdmin} />
        <DraftField label="Pipeline ID" k="pipeline_id" draft={form} setDraft={setForm} readOnly={!isAdmin} />
        <DraftField label="Stage → Reserved / Locked" k="stage_reserved_id" draft={form} setDraft={setForm} readOnly={!isAdmin} />
        <DraftField label="Stage → Under Contract" k="stage_under_contract_id" draft={form} setDraft={setForm} readOnly={!isAdmin} />
        <DraftField label="Stage → Closed / Sold" k="stage_closed_id" draft={form} setDraft={setForm} readOnly={!isAdmin} />
        <DraftField label="Stage → Release (Available)" k="stage_release_id" draft={form} setDraft={setForm} readOnly={!isAdmin} />
      </div>
      {isAdmin && (
        <div className="flex justify-end">
          <Button type="button" onClick={() => onSave(form)}>Save</Button>
        </div>
      )}
    </div>
  );
}

function DraftField({ label, k, draft, setDraft, readOnly }: {
  label: string; k: string;
  draft: Record<string, string>;
  setDraft: (fn: (prev: Record<string, string>) => Record<string, string>) => void;
  readOnly?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={`d-${k}`}>{label}</Label>
      <Input
        id={`d-${k}`}
        value={draft[k] ?? ""}
        onChange={(e) => setDraft((prev) => ({ ...prev, [k]: e.target.value }))}
        readOnly={readOnly}
      />
    </div>
  );
}
