import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import * as XLSX from "xlsx";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { reconcileRows } from "@/lib/reconcile.functions";

export const Route = createFileRoute("/_authenticated/tools/reconcile")({
  component: ReconcilePage,
});

type Row = Record<string, unknown>;

interface RowReport {
  row: number;
  client: string;
  developer: string;
  building: string;
  unit: string;
  status: string;
  sheetPhone: string;
  contactPhone: string;
  contactId: string | null;
  unitId: string | null;
  heldBy: string | null;
  category: string;
  reason: string;
}

const LABELS: Record<string, string> = {
  created_or_updatable: "Ready (create or update)",
  missing_phone: "Missing phone",
  missing_contact: "Missing contact",
  missing_building: "Missing building",
  missing_unit: "Missing unit",
  duplicate_unit: "Duplicate unit",
  held_by_other: "Held by another",
  invalid_row: "Invalid row",
  no_status_no_deal: "Blank status (Available)",
};

function ReconcilePage() {
  const [rows, setRows] = useState<Row[]>([]);
  const [fileName, setFileName] = useState("");
  const [busy, setBusy] = useState(false);
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [detail, setDetail] = useState<RowReport[]>([]);
  const [totalRows, setTotalRows] = useState(0);
  const [filter, setFilter] = useState<string>("all");

  async function onFile(file: File) {
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const pick = wb.SheetNames.find((n) => /main/i.test(n)) ?? wb.SheetNames[0];
    const parsed = XLSX.utils.sheet_to_json<Row>(wb.Sheets[pick], { defval: "", raw: false });
    setRows(parsed);
    setFileName(`${file.name} - sheet "${pick}", ${parsed.length} rows`);
    setCounts(null);
    setDetail([]);
  }

  async function run() {
    if (!rows.length) {
      toast.error("Upload the sheet first.");
      return;
    }
    setBusy(true);
    try {
      const r = await reconcileRows({ data: { rows } });
      setCounts(r.counts);
      setDetail(r.detail);
      setTotalRows(r.totalRows);
      toast.success(`Reconciled ${r.accountedFor} rows`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function downloadMissingPhone() {
    const rowsMP = detail.filter((d) => d.category === "missing_phone");
    const header = [
      "Row",
      "Customer",
      "Sheet Phone",
      "GHL Contact Phone",
      "Contact ID",
      "Unit ID",
      "Opportunity Hold",
      "Reason",
      "Recommended Action",
    ];
    const lines = rowsMP.map((d) => {
      const isPlaceholder = /^(owner|secret)/i.test(d.client);
      const action = isPlaceholder
        ? "Placeholder customer - clean up in sheet"
        : "Add phone to the GHL contact, then re-run import or Refresh Names";
      return [
        d.row,
        d.client,
        d.sheetPhone,
        d.contactPhone,
        d.contactId ?? "",
        d.unitId ?? "",
        d.heldBy ?? "",
        d.reason,
        action,
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",");
    });
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "missing-phone-report.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  const shown = filter === "all" ? detail : detail.filter((d) => d.category === filter);
  const sum = counts ? Object.values(counts).reduce((a, b) => a + b, 0) : 0;

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">Reconcile every row</h1>
        <p className="text-muted-foreground text-sm">
          Accounts for every spreadsheet row in exactly one category. Read-only - resolves each row the way the
          importer does, but writes nothing.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Upload the sheet</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <Input
            type="file"
            accept=".xlsx,.xls,.csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          {fileName && <p className="text-muted-foreground text-sm">{fileName}</p>}
          <Button onClick={run} disabled={busy || rows.length === 0}>
            {busy ? "Reconciling..." : "Reconcile"}
          </Button>
        </CardContent>
      </Card>

      {counts && (
        <Card>
          <CardHeader>
            <CardTitle>Totals</CardTitle>
            <CardDescription>
              {sum} rows accounted for of {totalRows} in the sheet. Categories sum to the number of client rows.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {Object.entries(counts).map(([k, v]) => (
                <button
                  key={k}
                  onClick={() => setFilter(k)}
                  className={`rounded border p-2 text-left text-sm ${filter === k ? "border-primary" : ""}`}
                >
                  <div className="text-muted-foreground text-xs">{LABELS[k] ?? k}</div>
                  <div className="text-xl font-bold">{v}</div>
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => setFilter("all")}>
                Show all
              </Button>
              <Button size="sm" variant="outline" onClick={downloadMissingPhone} disabled={!counts.missing_phone}>
                Download missing-phone CSV ({counts.missing_phone})
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {shown.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{filter === "all" ? "All rows" : LABELS[filter] ?? filter}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="max-h-[32rem] space-y-1 overflow-auto">
              {shown.map((d) => (
                <div key={d.row} className="rounded border p-2 text-xs">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="text-[10px]">
                      row {d.row}
                    </Badge>
                    <span className="font-medium">{d.client}</span>
                    <Badge variant="secondary" className="ml-auto text-[10px]">
                      {LABELS[d.category] ?? d.category}
                    </Badge>
                  </div>
                  <div className="text-muted-foreground mt-1">
                    {d.developer} / {d.building} / {d.unit || "(no unit)"} - {d.status || "(blank)"} - {d.reason}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
