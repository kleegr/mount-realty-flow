import { createFileRoute, useRouter, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { flexUpload, flexConfirm } from "@/lib/flex-import.functions";
import { FIELD_CATALOG, type FlexScope } from "@/lib/import/flex-mapping";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ArrowLeft, ArrowRight, Upload, PlayCircle, Sparkles } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/import/flex")({
  component: FlexImport,
});

type Options = {
  duplicateStrategy: "skip" | "update" | "create_duplicate";
  duplicateKey: "record_id" | "external_id" | "code" | "name";
  missingParentProject: "auto_create" | "unassigned" | "fail";
  missingParentBuilding: "auto_create" | "unassigned" | "fail";
};

const DEFAULT_OPTIONS: Options = {
  duplicateStrategy: "update",
  duplicateKey: "external_id",
  missingParentProject: "unassigned",
  missingParentBuilding: "unassigned",
};

function FlexImport() {
  const router = useRouter();
  const uploadFn = useServerFn(flexUpload);
  const confirmFn = useServerFn(flexConfirm);

  const [step, setStep] = useState<"upload" | "mapping" | "options" | "running">("upload");
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  const [jobId, setJobId] = useState<string | null>(null);
  const [headers, setHeaders] = useState<string[]>([]);
  const [preview, setPreview] = useState<Array<Record<string, string>>>([]);
  const [rowCount, setRowCount] = useState(0);
  const [scopes, setScopes] = useState<FlexScope[]>([]);
  const [columnMap, setColumnMap] = useState<Record<string, Record<string, string>>>({});
  const [options, setOptions] = useState<Options>(DEFAULT_OPTIONS);

  async function onUpload() {
    if (!file) return toast.error("Choose a file first");
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = ""; for (const b of bytes) bin += String.fromCharCode(b);
      const res = await uploadFn({ data: { filename: file.name, fileBase64: btoa(bin) } });
      setJobId(res.jobId);
      setHeaders(res.headers);
      setPreview(res.preview);
      setRowCount(res.rowCount);
      setScopes(res.detectedScopes as FlexScope[]);
      setColumnMap(res.suggestedMap);
      setStep("mapping");
      toast.success(`Parsed ${res.rowCount} rows. Detected: ${res.detectedScopes.join(", ") || "none"}.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally { setBusy(false); }
  }

  function toggleScope(s: FlexScope, on: boolean) {
    setScopes((prev) => on ? [...new Set([...prev, s])] : prev.filter((x) => x !== s));
    if (!on) setColumnMap((prev) => { const next = { ...prev }; delete next[s]; return next; });
    else setColumnMap((prev) => ({ ...prev, [s]: prev[s] ?? {} }));
  }

  function updateMapping(scope: FlexScope, header: string, fieldKey: string) {
    setColumnMap((prev) => {
      const next = { ...prev, [scope]: { ...(prev[scope] ?? {}) } };
      if (!fieldKey || fieldKey === "__ignore__") delete next[scope][header];
      else next[scope][header] = fieldKey;
      return next;
    });
  }

  async function onConfirm() {
    if (!jobId) return;
    if (scopes.length === 0) return toast.error("Pick at least one entity type to import.");
    setBusy(true); setStep("running");
    try {
      const res = await confirmFn({ data: { jobId, scopes, columnMap, options } });
      toast.success(`Import ${res.report.status.replace(/_/g, " ")}`);
      router.navigate({ to: "/import/$jobId", params: { jobId } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Import failed");
      setStep("options");
    } finally { setBusy(false); }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Flexible Import</h1>
          <p className="mt-1 text-muted-foreground">Import Projects, Buildings, or Units — separately or together. Map any CSV.</p>
        </div>
        <Button variant="ghost" size="sm" asChild><Link to="/import"><ArrowLeft className="mr-2 h-4 w-4" />Back to Import Center</Link></Button>
      </div>

      <Stepper current={step} />

      {step === "upload" && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Upload className="h-4 w-4" />Upload CSV or Excel</CardTitle>
            <CardDescription>Headers can be anything — you'll map them next. Any combination of Project/Building/Unit columns is allowed.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="flex-file">File</Label>
              <Input id="flex-file" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <Button onClick={onUpload} disabled={!file || busy} size="lg">
              {busy ? "Uploading…" : "Upload & Detect"}
              <ArrowRight className="ml-2 h-4 w-4" />
            </Button>
          </CardContent>
        </Card>
      )}

      {step === "mapping" && (
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4" />Detected scopes</CardTitle>
              <CardDescription>
                {rowCount} rows parsed. Check the entity types you want to import from this file.
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-4">
              {(["project", "building", "unit"] as FlexScope[]).map((s) => (
                <label key={s} className="flex items-center gap-2 rounded border px-3 py-2 cursor-pointer">
                  <Checkbox checked={scopes.includes(s)} onCheckedChange={(v) => toggleScope(s, Boolean(v))} />
                  <span className="capitalize font-medium">{s}s</span>
                  {scopes.includes(s) && <Badge variant="secondary">{Object.keys(columnMap[s] ?? {}).length} mapped</Badge>}
                </label>
              ))}
            </CardContent>
          </Card>

          {scopes.map((scope) => (
            <Card key={scope}>
              <CardHeader>
                <CardTitle className="capitalize">{scope} column mapping</CardTitle>
                <CardDescription>Match your CSV columns to {scope} fields. Unmapped columns are ignored.</CardDescription>
              </CardHeader>
              <CardContent>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>CSV column</TableHead>
                      <TableHead>Sample</TableHead>
                      <TableHead>Maps to</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {headers.map((h) => {
                      const current = columnMap[scope]?.[h] ?? "__ignore__";
                      const sample = preview[0]?.[h] ?? "";
                      return (
                        <TableRow key={h}>
                          <TableCell className="font-medium">{h}</TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-xs truncate">{sample}</TableCell>
                          <TableCell>
                            <Select value={current} onValueChange={(v) => updateMapping(scope, h, v)}>
                              <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="__ignore__">— Ignore —</SelectItem>
                                {FIELD_CATALOG[scope].map((f) => (
                                  <SelectItem key={f.key} value={f.key}>{f.label}</SelectItem>
                                ))}
                              </SelectContent>
                            </Select>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}

          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("upload")}><ArrowLeft className="mr-2 h-4 w-4" />Back</Button>
            <Button onClick={() => setStep("options")}>Next: Options<ArrowRight className="ml-2 h-4 w-4" /></Button>
          </div>
        </div>
      )}

      {step === "options" && (
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>Duplicate handling</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <OptionSelect label="If a matching record already exists" value={options.duplicateStrategy} onChange={(v) => setOptions({ ...options, duplicateStrategy: v as Options["duplicateStrategy"] })}
                items={[{ v: "skip", l: "Skip (no changes)" }, { v: "update", l: "Update existing" }, { v: "create_duplicate", l: "Create a duplicate anyway" }]} />
              <OptionSelect label="Match records by" value={options.duplicateKey} onChange={(v) => setOptions({ ...options, duplicateKey: v as Options["duplicateKey"] })}
                items={[{ v: "external_id", l: "External / Import ID" }, { v: "record_id", l: "CRM Record ID" }, { v: "code", l: "Code" }, { v: "name", l: "Name" }]} />
            </CardContent>
          </Card>
          <Card>
            <CardHeader><CardTitle>Missing parents</CardTitle></CardHeader>
            <CardContent className="grid gap-4 md:grid-cols-2">
              <OptionSelect label="If a Unit's Building is not found" value={options.missingParentBuilding} onChange={(v) => setOptions({ ...options, missingParentBuilding: v as Options["missingParentBuilding"] })}
                items={[{ v: "auto_create", l: "Auto-create the Building" }, { v: "unassigned", l: "Leave Unit unassigned" }, { v: "fail", l: "Fail the row" }]} />
              <OptionSelect label="If a Building's Project is not found" value={options.missingParentProject} onChange={(v) => setOptions({ ...options, missingParentProject: v as Options["missingParentProject"] })}
                items={[{ v: "auto_create", l: "Auto-create the Project" }, { v: "unassigned", l: "Leave Building unassigned" }, { v: "fail", l: "Fail the row" }]} />
            </CardContent>
          </Card>
          <Alert>
            <AlertTitle>Ready to import</AlertTitle>
            <AlertDescription>
              {rowCount} rows will be processed for: <b>{scopes.join(", ")}</b>. Failed rows won't stop the run — you can download them from the report page.
            </AlertDescription>
          </Alert>
          <div className="flex justify-between">
            <Button variant="ghost" onClick={() => setStep("mapping")}><ArrowLeft className="mr-2 h-4 w-4" />Back</Button>
            <Button onClick={onConfirm} disabled={busy} size="lg">
              <PlayCircle className="mr-2 h-4 w-4" />
              {busy ? "Running…" : "Confirm & Import"}
            </Button>
          </div>
        </div>
      )}

      {step === "running" && (
        <Card><CardContent className="py-10 text-center space-y-2">
          <PlayCircle className="mx-auto h-8 w-8 animate-pulse text-primary" />
          <div className="font-medium">Importing {rowCount} rows…</div>
          <div className="text-sm text-muted-foreground">You'll be redirected to the job report when it finishes.</div>
        </CardContent></Card>
      )}
    </div>
  );
}

function Stepper({ current }: { current: string }) {
  const steps = [
    { id: "upload", label: "1. Upload" },
    { id: "mapping", label: "2. Map columns" },
    { id: "options", label: "3. Options" },
    { id: "running", label: "4. Import" },
  ];
  const currentIdx = steps.findIndex((s) => s.id === current);
  return (
    <div className="flex gap-2 flex-wrap">
      {steps.map((s, i) => (
        <div key={s.id} className={`rounded-full px-3 py-1 text-xs ${i === currentIdx ? "bg-primary text-primary-foreground" : i < currentIdx ? "bg-muted" : "border"}`}>
          {s.label}
        </div>
      ))}
    </div>
  );
}

function OptionSelect({ label, value, onChange, items }: { label: string; value: string; onChange: (v: string) => void; items: Array<{ v: string; l: string }> }) {
  return (
    <div className="space-y-2">
      <Label>{label}</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger><SelectValue /></SelectTrigger>
        <SelectContent>
          {items.map((it) => <SelectItem key={it.v} value={it.v}>{it.l}</SelectItem>)}
        </SelectContent>
      </Select>
    </div>
  );
}
