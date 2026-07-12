import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/kleegr/AppShell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Copy, Check, ExternalLink } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/webhook-guide")({
  component: WebhookGuidePage,
  head: () => ({
    meta: [{ title: "Webhook Setup Guide — Kleegr" }],
  }),
  errorComponent: ({ error }) => (
    <AppShell>
      <div className="text-destructive">Failed to load: {error.message}</div>
    </AppShell>
  ),
  notFoundComponent: () => (
    <AppShell>
      <div>Page not found</div>
    </AppShell>
  ),
});

const WEBHOOK_URL =
  "https://mount-realty-flow.lovable.app/api/public/webhooks/ghl/opportunity-stage";

function CopyBlock({ label, value }: { label?: string; value: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    await navigator.clipboard.writeText(value);
    setCopied(true);
    toast.success("Copied");
    setTimeout(() => setCopied(false), 1500);
  }
  return (
    <div className="space-y-1">
      {label && <div className="text-xs font-medium text-muted-foreground">{label}</div>}
      <div className="group relative rounded-md border bg-muted/40 p-3 font-mono text-xs">
        <pre className="overflow-x-auto whitespace-pre-wrap break-all pr-10">{value}</pre>
        <Button
          size="icon"
          variant="ghost"
          className="absolute right-1 top-1 h-7 w-7"
          onClick={copy}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
        {n}
      </div>
      <div className="flex-1 space-y-2">
        <h4 className="font-semibold leading-tight">{title}</h4>
        <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

const UNIT_BODY = `{
  "opportunity_id": "{{opportunity.id}}",
  "stage": "{{opportunity.pipeline_stage}}",
  "unit_crm_id": "{{opportunity.locked_reserved_units.id}}",
  "unit_name":   "{{opportunity.locked_reserved_units.name}}"
}`;

const BUILDING_BODY = `{
  "opportunity_id": "{{opportunity.id}}",
  "stage": "{{opportunity.pipeline_stage}}",
  "building_crm_id": "{{opportunity.custom_field.building_crm_id}}",
  "building_name":   "{{opportunity.custom_field.building_name}}"
}`;

function WebhookGuidePage() {
  return (
    <AppShell>
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-bold">Webhook Setup Guide</h1>
        <p className="text-sm text-muted-foreground">
          Configure GHL workflows to auto-sync stage changes into Kleegr — no manual ID
          copy-pasting required.
        </p>
      </div>

      <Card className="mb-6 border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="text-base">Your webhook endpoint</CardTitle>
          <CardDescription>
            One URL handles both Unit-level and Building-level pipelines. Payload shape decides
            which record is updated.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <CopyBlock value={WEBHOOK_URL} />
        </CardContent>
      </Card>

      <Tabs defaultValue="unit" className="space-y-6">
        <TabsList className="grid w-full max-w-md grid-cols-2">
          <TabsTrigger value="unit">Pipeline A — Unit sales</TabsTrigger>
          <TabsTrigger value="building">Pipeline B — Building sales</TabsTrigger>
        </TabsList>

        {/* ================= UNIT ================= */}
        <TabsContent value="unit" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Unit Sales Pipeline
                <Badge variant="secondary">Most common</Badge>
              </CardTitle>
              <CardDescription>
                Use this when the opportunity is a lead buying <b>one specific unit</b>{" "}
                (apartment / villa / plot). Relies on the <b>Locked/Reserved Units</b>{" "}
                association (1-to-1) on the Opportunity.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Step n={1} title="Prerequisite in GHL">
                <p>
                  On the Opportunity object, the <b>Locked/Reserved Units</b> association must
                  exist (1-to-1 → Units). You already have this — visible in the Units →
                  Associations screen.
                </p>
              </Step>

              <Step n={2} title="Create workflow: 'Sync Locked Unit → Kleegr'">
                <p>Go to GHL → Automation → Workflows → + Create Workflow → Start from scratch.</p>
              </Step>

              <Step n={3} title="Trigger">
                <p>
                  Add trigger: <b>Pipeline Stage Changed</b> (or <b>Opportunity Status Changed</b>
                  ). Filter by the pipeline used for unit sales. Optionally filter to only fire
                  on stages: <code>Reserved</code>, <code>Sold</code>, <code>Lost</code>.
                </p>
              </Step>

              <Step n={4} title="Action → Webhook">
                <p>Add action: <b>Webhook</b>. Configure it as follows:</p>
                <CopyBlock label="Method" value="POST" />
                <CopyBlock label="URL" value={WEBHOOK_URL} />
                <CopyBlock
                  label="Headers"
                  value={`Content-Type: application/json`}
                />
                <CopyBlock label="Body (JSON) — use GHL's Custom Value picker for merge tags" value={UNIT_BODY} />
                <p className="text-xs">
                  When entering the body, use the <b>{"{}"}</b> Custom Value picker. Under the
                  Opportunity → Associations → <b>Locked/Reserved Units</b> section pick{" "}
                  <b>Record ID</b> for <code>unit_crm_id</code>.
                </p>
              </Step>

              <Step n={5} title="Stage → status mapping">
                <p>The webhook maps your GHL stage name into a unit status:</p>
                <div className="rounded-md border">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/50">
                      <tr>
                        <th className="p-2 text-left">GHL stage name (contains)</th>
                        <th className="p-2 text-left">Applied unit status</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr className="border-t"><td className="p-2">Reserved / Locked / Hold</td><td className="p-2"><Badge variant="secondary">reserved</Badge></td></tr>
                      <tr className="border-t"><td className="p-2">Sold / Won / Closed Won</td><td className="p-2"><Badge>sold</Badge></td></tr>
                      <tr className="border-t"><td className="p-2">Lost / Released / Cancelled</td><td className="p-2"><Badge variant="outline">available</Badge></td></tr>
                    </tbody>
                  </table>
                </div>
              </Step>

              <Step n={6} title="Test">
                <p>
                  Save & publish the workflow. Move a test opportunity into a Reserved stage
                  with a linked unit. Open <b>Dashboard</b> — the event should appear as
                  applied (green), not pending.
                </p>
              </Step>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ================= BUILDING ================= */}
        <TabsContent value="building" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Building Sales Pipeline
                <Badge variant="outline">Whole-building deals</Badge>
              </CardTitle>
              <CardDescription>
                Use this when the opportunity sells an <b>entire building</b> as one deal (no
                unit breakdown). The webhook updates the Building's status directly instead of
                rolling up units.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <Step n={1} title="Prerequisite in GHL">
                <p>
                  GHL does not offer a native 1-to-1 association from Opportunity to Building.
                  Instead, add a <b>custom field</b> on the Opportunity object:
                </p>
                <ul className="ml-4 list-disc space-y-1">
                  <li>Field name: <code>Building CRM ID</code></li>
                  <li>Type: Single line text</li>
                  <li>Internal key: <code>building_crm_id</code></li>
                </ul>
                <p>
                  Optionally add a second field <code>Building Name</code> for readability. Use{" "}
                  <b>CRM ID Lookup</b> in this app to find the correct Building ID and paste it
                  into the opportunity.
                </p>
              </Step>

              <Step n={2} title="Create a separate pipeline in GHL">
                <p>
                  Recommended: create a dedicated pipeline called <b>Building Sales</b> with
                  stages: <code>Interested → Negotiation → Reserved → Sold → Lost</code>. This
                  keeps unit and building workflows cleanly separated.
                </p>
              </Step>

              <Step n={3} title="Create workflow: 'Sync Building Sale → Kleegr'">
                <p>GHL → Automation → Workflows → + Create Workflow.</p>
              </Step>

              <Step n={4} title="Trigger">
                <p>
                  <b>Pipeline Stage Changed</b>, filtered to the <b>Building Sales</b> pipeline
                  only. Optionally filter to stages: <code>Reserved</code>, <code>Sold</code>,{" "}
                  <code>Lost</code>.
                </p>
              </Step>

              <Step n={5} title="Action → Webhook">
                <CopyBlock label="Method" value="POST" />
                <CopyBlock label="URL" value={WEBHOOK_URL} />
                <CopyBlock label="Headers" value={`Content-Type: application/json`} />
                <CopyBlock label="Body (JSON)" value={BUILDING_BODY} />
                <p className="text-xs">
                  Key difference: send <code>building_crm_id</code> instead of{" "}
                  <code>unit_crm_id</code>. The webhook auto-detects the scope. Never send both.
                </p>
              </Step>

              <Step n={6} title="Effect on inventory">
                <p>
                  When a Building is marked <b>sold</b>, the app marks the building as Sold Out
                  and does <b>not</b> touch individual units under it (they may not even exist
                  in your inventory). When marked <b>reserved</b>, the building shows Reserved.
                </p>
              </Step>

              <Step n={7} title="Test">
                <p>
                  Move a test opportunity in the Building Sales pipeline to Reserved. Check{" "}
                  <b>Inventory → Buildings</b> — the building status should reflect the change
                  within seconds.
                </p>
              </Step>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle className="text-base">Troubleshooting</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <div>
            <b className="text-foreground">Event lands in Pending Events instead of applying:</b>{" "}
            The <code>unit_crm_id</code> / <code>building_crm_id</code> merge tag resolved
            empty, or the ID isn't synced yet. Run <b>Settings → Sync from CRM</b>, then use the{" "}
            <b>CRM ID Lookup</b> to verify the record exists.
          </div>
          <div>
            <b className="text-foreground">Wrong status applied:</b> Rename the GHL stage to
            include the keyword from the mapping table above (e.g. rename "On Hold" to
            "Reserved — On Hold").
          </div>
          <div>
            <b className="text-foreground">Webhook not firing at all:</b> In the GHL workflow,
            open the execution log for a test opportunity. Confirm the trigger matched and the
            webhook action returned 200. A 401/403 means the URL is wrong (must be the exact
            URL above — <code>/api/public/*</code> bypasses auth).
          </div>
          <div>
            <a
              href="https://help.gohighlevel.com/support/solutions/articles/48001215009-webhooks"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-primary hover:underline"
            >
              GHL webhook docs <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}
