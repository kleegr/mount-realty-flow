import { createFileRoute, useRouter, Link } from "@tanstack/react-router";
import { useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { uploadAndValidate, getCsvTemplate } from "@/lib/import.functions";
import { getCrmConfig } from "@/lib/crm-config.functions";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Download, Upload, FileText, Info, Sparkles } from "lucide-react";
import { IMPORT_COLUMNS, ALLOWED } from "@/lib/kleegr/field-map";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/import/")({
  component: ImportCenter,
});

function ImportCenter() {
  const router = useRouter();
  const uploadFn = useServerFn(uploadAndValidate);
  const csvFn = useServerFn(getCsvTemplate);
  const cfgFn = useServerFn(getCrmConfig);
  const { data: cfg } = useQuery({ queryKey: ["crm-config"], queryFn: () => cfgFn() });

  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);

  async function onUpload() {
    if (!file) return toast.error("Choose a file first");
    setBusy(true);
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      const base64 = btoa(bin);
      const res = await uploadFn({ data: { filename: file.name, fileBase64: base64 } });
      toast.success("Parsed and validated. Review the preview.");
      router.navigate({ to: "/import/$jobId", params: { jobId: res.jobId } });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  }

  async function downloadCsv() {
    const { csv } = await csvFn();
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "Mount_Realty_Kleegr_Inventory_Import_Template.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const templateUrl = cfg?.config?.template_xlsx_url;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Import Center</h1>
        <p className="mt-1 text-muted-foreground">
          Upload an Excel or CSV file to bulk-create Projects, Buildings and Units. Files are validated and previewed before anything is written to the CRM.
        </p>
      </div>

      <Card className="border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Sparkles className="h-4 w-4" />Flexible Import (new)</CardTitle>
          <CardDescription>
            Import Projects, Buildings, or Units — independently or together. Map any CSV columns, choose how to handle duplicates and missing parents, and download failed rows after the run.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Button asChild size="lg"><Link to="/import/flex">Start a flexible import</Link></Button>
        </CardContent>
      </Card>

      {!cfg?.tokenConfigured && (
        <Alert variant="destructive">
          <AlertTitle>CRM token is not configured</AlertTitle>
          <AlertDescription>
            An admin must save a valid CRM token in Settings before you can confirm an import. You can still upload and preview.
          </AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><Upload className="h-4 w-4" />Upload File</CardTitle>
            <CardDescription>Supported: .xlsx, .xls, .csv. Only the sheet named "Inventory Import" is parsed from Excel workbooks.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="file">Inventory file</Label>
              <Input id="file" type="file" accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            </div>
            <Button onClick={onUpload} disabled={!file || busy} size="lg">
              {busy ? "Parsing…" : "Parse & Validate"}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2"><FileText className="h-4 w-4" />Template</CardTitle>
            <CardDescription>Get the required column layout.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button variant="outline" className="w-full" onClick={downloadCsv}>
              <Download className="mr-2 h-4 w-4" />Download CSV template
            </Button>
            {templateUrl ? (
              <Button variant="outline" className="w-full" asChild>
                <a href={templateUrl} target="_blank" rel="noreferrer">
                  <Download className="mr-2 h-4 w-4" />Download Excel template
                </a>
              </Button>
            ) : (
              <p className="text-xs text-muted-foreground">Excel template link not configured. Ask an admin to set it in Settings.</p>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2"><Info className="h-4 w-4" />Template specification</CardTitle>
          <CardDescription>The upload must have these 30 columns, in any order. Each row represents one Unit.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div>
            <h3 className="mb-2 text-sm font-semibold">Required columns</h3>
            <ul className="grid list-disc grid-cols-2 gap-x-6 gap-y-1 pl-4 text-sm md:grid-cols-3">
              {IMPORT_COLUMNS.map((c) => (<li key={c}>{c}</li>))}
            </ul>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <ValueGroup label="Import Modes" values={["Project + Buildings + Units", "Building + Units", "Units Only"]} />
            <ValueGroup label="Project Status" values={ALLOWED.projectStatus} />
            <ValueGroup label="Property Type" values={ALLOWED.projectPropertyType} />
            <ValueGroup label="Building Status" values={ALLOWED.buildingStatus} />
            <ValueGroup label="Unit Availability" values={ALLOWED.unitAvailability} />
            <ValueGroup label="Unit Stage" values={ALLOWED.unitStage} />
            <ValueGroup label="Unit Style" values={ALLOWED.unitStyle} />
          </div>
          <Alert>
            <AlertTitle>Rules</AlertTitle>
            <AlertDescription>
              A Project cannot be imported without at least one Building AND one Unit. A Building cannot be imported without at least one Unit. Standalone Units are allowed (Units Only mode). Duplicate Import Row IDs and Unit Import IDs are blocked.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    </div>
  );
}

function ValueGroup({ label, values }: { label: string; values: readonly string[] }) {
  return (
    <div>
      <div className="mb-1 text-xs font-semibold uppercase text-muted-foreground">{label}</div>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <span key={v} className="rounded border px-2 py-0.5 text-xs">{v}</span>
        ))}
      </div>
    </div>
  );
}
