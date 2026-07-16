import { createFileRoute } from "@tanstack/react-router";
import { useMutation } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import * as XLSX from "xlsx";
import {
  previewContactImport,
  runContactImportChunk,
  undoContactImport,
} from "@/lib/contact-import.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertTriangle, Check, X, Users, Undo2 } from "lucide-react";
import { toast } from "sonner";

/**
 * Contact import UI. Contacts only — no opportunities.
 *
 * The run loop calls the server in chunks of 25 rather than one long request,
 * because ~150 sequential CRM calls will outlive a serverless invocation. Each
 * chunk is independently resumable: the server skips anyone already in
 * contact_id_map, so a timeout mid-run costs nothing but a click.
 */

export const Route = createFileRoute("/_authenticated/import/contacts")({
  component: ContactImportPage,
});

type Row = Record<string, unknown>;
type RunResult = { stableId: string; name: string; ok: boolean; action: string; detail: string };

function ContactImportPage() {
  const previewFn = useServerFn(previewContactImport);
  const runFn = useServerFn(runContactImportChunk);
  const undoFn = useServerFn(undoContactImport);

  const [sheetNames, setSheetNames] = useState<string[]>([]);
  const [workbook, setWorkbook] = useState<XLSX.WorkBook | null>(null);
  const [sheet, setSheet] = useState<string>("");
  const [rows, setRows] = useState<Row[]>([]);
  const [contactType, setContactType] = useState("Buyer");
  const [jobId, setJobId] = useState<string>("");
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ imported: 0, total: 0, remaining: 0 });
  const [results, setResults] = useState<RunResult[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  const preview = useMutation({
    mutationFn: (r: Row[]) => previewFn({ data: { rows: r } }),
    onError: (e: Error) => toast.error(e.message),
  });

  async function onFile(file: File) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    setWorkbook(wb);
    setSheetNames(wb.SheetNames);
    const pick = wb.SheetNames.find((n) => /main/i.test(n)) ?? wb.SheetNames[0];
    setSheet(pick);
    loadSheet(wb, pick);
  }

  function loadSheet(wb: XLSX.WorkBook, name: string) {
    const parsed = XLSX.utils.sheet_to_json<Row>(wb.Sheets[name], { defval: "", raw: false });
    setRows(parsed);
    setResults([]);
    setFatal(null);
    setProgress({ imported: 0, total: 0, remaining: 0 });
    if (parsed.length) preview.mutate(parsed);
  }

  async function run() {
    if (!rows.length) return;
    const id = jobId || crypto.randomUUID();
    setJobId(id);
    setRunning(true);
    setFatal(null);
    const acc: RunResult[] = [];

    try {
      for (let pass = 0; pass < 40; pass++) {
        const res = await runFn({ data: { jobId: id, rows, overrides: [], contactType, limit: 25 } });
        acc.push(...res.results);
        setResults([...acc]);
        setProgress({ imported: res.imported, total: res.totalPeople, remaining: res.remaining });

        const aborted = res.results.find((r) => /ABORTED AFTER ONE ROW/.test(r.detail));
        if (aborted) {
          setFatal(aborted.detail);
          break;
        }
        // No progress and nothing left to do, or the chunk did nothing at all.
        if (res.remaining === 0 || res.processed === 0) break;
      }
    } catch (e) {
      setFatal(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  }

  const undo = useMutation({
    mutationFn: () => undoFn({ data: { jobId, confirm: "UNDO" as const } }),
    onSuccess: (d) => {
      toast.success(`Deleted ${d.deleted} contacts this run created`);
      setResults([]);
      setProgress({ imported: 0, total: 0, remaining: 0 });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const p = preview.data;
  const pct = progress.total ? Math.round((progress.imported / progress.total) * 100) : 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Contact Import</h1>
        <p className="mt-1 text-muted-foreground">
          People only — no opportunities, no units. Rows are collapsed to one contact per person, so a
          buyer with six units becomes one record.
        </p>
      </div>

      {/* ---------------- file ---------------- */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg">1 · The sheet</CardTitle>
          <CardDescription>Nothing is written until you press Import.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />

          {sheetNames.length > 1 && (
            <div className="space-y-1.5">
              <Label>Tab</Label>
              <div className="flex flex-wrap gap-1">
                {sheetNames.map((n) => (
                  <Button
                    key={n}
                    size="sm"
                    variant={sheet === n ? "default" : "outline"}
                    onClick={() => {
                      setSheet(n);
                      if (workbook) loadSheet(workbook, n);
                    }}
                  >
                    {n}
                  </Button>
                ))}
              </div>
            </div>
          )}

          {rows.length > 0 && (
            <p className="text-sm text-muted-foreground">
              {rows.length} rows · {Object.keys(rows[0] ?? {}).length} columns
            </p>
          )}
        </CardContent>
      </Card>

      {/* ---------------- preview ---------------- */}
      {p?.ok && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">2 · What will happen</CardTitle>
            <CardDescription>
              Column mapping is read live from GHL, so picklist values are matched against the real
              options rather than guessed.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              <Stat label="Rows" value={p.totalRows} />
              <Stat label="Distinct people" value={p.distinctPeople} />
              <Stat label="To import" value={p.toImport} />
              <Stat label="Already imported" value={p.alreadyImported} />
            </div>

            {p.usingDerivedIds && (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="text-sm">
                  No stable ID column found, so identity is derived from the name. Two different people
                  with identical names would merge into one contact. Add an ID column (C001, C002…) to
                  remove that risk.
                </AlertDescription>
              </Alert>
            )}

            {p.rowsWithoutName > 0 && (
              <p className="text-sm text-muted-foreground">
                {p.rowsWithoutName} rows have no name and will be skipped.
              </p>
            )}
            {p.noContactInfo > 0 && (
              <p className="text-sm text-muted-foreground">
                {p.noContactInfo} people have neither phone nor email — imported anyway, tagged{" "}
                <code className="rounded bg-muted px-1 text-xs">needs-contact-info</code>.
              </p>
            )}

            <div>
              <h3 className="mb-2 text-sm font-semibold">Column mapping</h3>
              <div className="space-y-1">
                {p.mapping.map((m) => (
                  <div
                    key={m.header}
                    className="flex items-center justify-between gap-3 rounded-md border p-2 text-sm"
                  >
                    <span className="truncate font-medium">{m.header}</span>
                    <div className="flex shrink-0 items-center gap-2">
                      <span
                        className={
                          m.kind === "ignored" ? "text-xs text-muted-foreground" : "text-xs"
                        }
                      >
                        {m.targetLabel}
                      </span>
                      <Badge variant={m.kind === "ignored" ? "outline" : "secondary"} className="text-[10px]">
                        {m.kind}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ct">Contact Type for newly created people</Label>
              <Input id="ct" value={contactType} onChange={(e) => setContactType(e.target.value)} className="max-w-xs" />
              <p className="text-xs text-muted-foreground">
                Applied only to contacts this run creates — an existing Seller is never silently flipped
                to Buyer. Matched case-insensitively against the real options.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* ---------------- run ---------------- */}
      {p?.ok && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">3 · Import</CardTitle>
            <CardDescription>
              Runs in chunks of 25 and resumes automatically — if it stops, press Import again and it
              carries on from where it stopped.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="flex flex-wrap gap-2">
              <Button onClick={run} disabled={running || !rows.length}>
                <Users className="mr-2 h-4 w-4" />
                {running ? "Importing…" : progress.imported > 0 ? "Continue import" : "Import contacts"}
              </Button>
              {jobId && progress.imported > 0 && (
                <Button variant="outline" onClick={() => undo.mutate()} disabled={undo.isPending || running}>
                  <Undo2 className="mr-2 h-4 w-4" />
                  {undo.isPending ? "Undoing…" : "Undo this run"}
                </Button>
              )}
            </div>

            {progress.total > 0 && (
              <div className="space-y-1.5">
                <Progress value={pct} />
                <p className="text-sm text-muted-foreground">
                  {progress.imported} of {progress.total} people · {progress.remaining} remaining
                </p>
              </div>
            )}

            {fatal && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="break-words text-sm">{fatal}</AlertDescription>
              </Alert>
            )}

            {results.length > 0 && (
              <div className="max-h-96 space-y-1 overflow-auto">
                {results.map((r, i) => (
                  <div key={`${r.stableId}-${i}`} className="flex items-start gap-2 rounded-md border p-2">
                    {r.ok ? (
                      <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                    ) : (
                      <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate text-sm font-medium">{r.name}</span>
                        <Badge variant="outline" className="shrink-0 text-[10px]">{r.action}</Badge>
                      </div>
                      <div className="break-words font-mono text-[11px] text-muted-foreground">{r.detail}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-2xl font-bold">{value}</div>
    </div>
  );
}
