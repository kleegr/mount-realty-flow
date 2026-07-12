import { createFileRoute, Link } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { listJobs } from "@/lib/import.functions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/import/history")({
  component: History,
});

function History() {
  const fn = useServerFn(listJobs);
  const { data } = useQuery({ queryKey: ["jobs"], queryFn: () => fn() });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Import History</h1>
        <p className="mt-1 text-muted-foreground">Every upload with its final outcome and record counts.</p>
      </div>
      <Card>
        <CardHeader><CardTitle>All Imports</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>File</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Errors</TableHead>
                <TableHead>Created</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data?.jobs ?? []).map((j) => (
                <TableRow key={j.id}>
                  <TableCell>
                    <Link to="/import/$jobId" params={{ jobId: j.id }} className="font-medium hover:underline">
                      {j.filename ?? "Untitled"}
                    </Link>
                  </TableCell>
                  <TableCell><Badge variant="outline">{j.mode ?? "—"}</Badge></TableCell>
                  <TableCell><Badge>{j.status.replace(/_/g, " ")}</Badge></TableCell>
                  <TableCell className="text-right">{j.units_created + j.units_updated}</TableCell>
                  <TableCell className="text-right">{j.errors_count}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm text-muted-foreground">{new Date(j.created_at).toLocaleString()}</TableCell>
                </TableRow>
              ))}
              {(data?.jobs ?? []).length === 0 && (
                <TableRow><TableCell colSpan={6} className="text-center text-muted-foreground py-6">No imports yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
