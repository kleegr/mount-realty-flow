import { createFileRoute } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { searchCrmRecords } from "@/lib/crm-search.functions";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Search } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/tools/id-lookup")({
  component: IdLookupPage,
});

function IdLookupPage() {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<"all" | "project" | "building" | "unit">("all");
  const fetchFn = useServerFn(searchCrmRecords);

  const results = useQuery({
    queryKey: ["crm-search", scope, query],
    queryFn: () =>
      fetchFn({
        data: {
          query,
          scope: scope === "all" ? undefined : scope,
          limit: 50,
        },
      }),
  });

  const copy = async (id: string) => {
    await navigator.clipboard.writeText(id);
    toast.success("Copied");
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">CRM ID Lookup</h1>
        <p className="mt-1 text-muted-foreground">
          Search your Projects, Buildings and Units by name or code. Click the copy icon to grab a CRM ID
          for GHL workflow setup or manual pending-event resolution.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-lg">Search</CardTitle>
          <CardDescription>Populated by the "Sync from CRM" action in Settings.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search by name, code, or paste an ID…"
                className="pl-9"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="flex gap-1">
              {(["all", "project", "building", "unit"] as const).map((s) => (
                <Button
                  key={s}
                  size="sm"
                  variant={scope === s ? "default" : "outline"}
                  onClick={() => setScope(s)}
                  className="capitalize"
                >
                  {s}
                </Button>
              ))}
            </div>
          </div>

          <div className="space-y-1.5">
            {results.isLoading && <p className="text-sm text-muted-foreground">Searching…</p>}
            {!results.isLoading && (results.data?.results ?? []).length === 0 && (
              <p className="text-sm text-muted-foreground">
                No matches. Try running "Sync from CRM" in Settings if your records aren't showing up.
              </p>
            )}
            {(results.data?.results ?? []).map((r) => (
              <div
                key={r.crmId}
                className="flex items-center justify-between gap-3 rounded-md border p-2.5 hover:bg-muted/40"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className="capitalize">{r.scope}</Badge>
                    <span className="truncate text-sm font-medium">{r.displayName}</span>
                    {r.code && <span className="text-xs text-muted-foreground">· {r.code}</span>}
                  </div>
                  <code className="mt-0.5 block truncate font-mono text-xs text-muted-foreground">
                    {r.crmId}
                  </code>
                </div>
                <Button size="sm" variant="ghost" onClick={() => copy(r.crmId)}>
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
