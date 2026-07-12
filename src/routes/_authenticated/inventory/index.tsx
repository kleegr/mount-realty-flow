import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useQuery } from "@tanstack/react-query";
import { getInventory } from "@/lib/inventory.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { useState } from "react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

export const Route = createFileRoute("/_authenticated/inventory/")({
  component: Inventory,
});

function Inventory() {
  const fn = useServerFn(getInventory);
  const { data } = useQuery({ queryKey: ["inventory"], queryFn: () => fn() });
  const [q, setQ] = useState("");

  const records = (data?.records ?? []).filter(
    (r) => !q || r.external_import_id.toLowerCase().includes(q.toLowerCase()) || r.crm_record_id.toLowerCase().includes(q.toLowerCase()),
  );

  const byScope = {
    project: records.filter((r) => r.scope === "project"),
    building: records.filter((r) => r.scope === "building"),
    unit: records.filter((r) => r.scope === "unit"),
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Inventory Browser</h1>
        <p className="mt-1 text-muted-foreground">All CRM records this portal has created or updated, grouped by scope.</p>
      </div>

      <Input placeholder="Search by import ID or CRM ID…" value={q} onChange={(e) => setQ(e.target.value)} className="max-w-md" />

      {(["project", "building", "unit"] as const).map((scope) => (
        <Card key={scope}>
          <CardHeader>
            <CardTitle className="capitalize">{scope}s <Badge variant="outline" className="ml-2">{byScope[scope].length}</Badge></CardTitle>
            <CardDescription>External Import IDs mapped to CRM record IDs.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Import ID</TableHead>
                  <TableHead>CRM Record ID</TableHead>
                  <TableHead>First Seen</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {byScope[scope].map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-sm">{r.external_import_id}</TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">{r.crm_record_id}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">{new Date(r.created_at).toLocaleDateString()}</TableCell>
                  </TableRow>
                ))}
                {byScope[scope].length === 0 && (
                  <TableRow><TableCell colSpan={3} className="text-center text-muted-foreground py-4">No {scope}s yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
