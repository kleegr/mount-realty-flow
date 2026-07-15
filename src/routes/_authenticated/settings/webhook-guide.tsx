import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { AppShell } from "@/components/kleegr/AppShell";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Copy, Check, Zap } from "lucide-react";
import { toast } from "sonner";

export const Route = createFileRoute("/_authenticated/settings/webhook-guide")({
  component: WebhookGuidePage,
  head: () => ({ meta: [{ title: "Webhook Setup Guide — Kleegr" }] }),
  errorComponent: ({ error }) => (
    <AppShell><div className="text-destructive">Failed to load: {error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div>Page not found</div></AppShell>,
});

const WEBHOOK_URL =
  "https://mr.kleegr.com/api/public/webhooks/ghl/opportunity-stage";

const PAYLOAD = `{
  "event_id": "{{opportunity.id}}-{{opportunity.stage_name}}",
  "opportunity_id": "{{opportunity.id}}",
  "opportunity_name": "{{opportunity.name}}",
  "pipeline_name": "{{opportunity.pipeline_name}}",
  "stage_name": "{{opportunity.stage_name}}"
}`;

function CopyBlock({ label, value, mono = true }: { label?: string; value: string; mono?: boolean }) {
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
      <div className="group relative rounded-md border bg-muted/40 p-3 text-xs">
        <pre className={`overflow-x-auto whitespace-pre-wrap break-all pr-10 ${mono ? "font-mono" : ""}`}>{value}</pre>
        <Button size="icon" variant="ghost" className="absolute right-1 top-1 h-7 w-7" onClick={copy}>
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Button>
      </div>
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-4">
      <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{n}</div>
      <div className="flex-1 space-y-2">
        <h4 className="font-semibold leading-tight">{title}</h4>
        <div className="space-y-2 text-sm text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function WebhookGuidePage() {
  return (
    <AppShell>
      <div className="mb-6 space-y-1">
        <h1 className="text-2xl font-bold">Webhook Setup Guide</h1>
        <p className="text-sm text-muted-foreground">
          Fully automated stage sync. Your team just moves opportunities in GHL — Kleegr
          figures out the linked unit itself.
        </p>
      </div>

      <Card className="mb-6 border-primary/30 bg-primary/5">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Zap className="h-4 w-4" /> Zero-touch automation
          </CardTitle>
          <CardDescription>
            One webhook per pipeline. No custom fields, no manual ID pasting. Kleegr calls the
            GHL API to auto-discover the Unit linked to each opportunity via the{" "}
            <b>Locked/Reserved Units</b> association.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <CopyBlock label="Webhook URL (same for both pipelines)" value={WEBHOOK_URL} />
          <CopyBlock label="RAW BODY (same JSON for both workflows)" value={PAYLOAD} />
        </CardContent>
      </Card>

      {/* ============ GHL SETUP ============ */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Build the workflow in GHL</CardTitle>
          <CardDescription>Do this once per pipeline. Takes ~5 minutes each.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <Step n={1} title="Create the workflow">
            <p>GHL → <b>Automation → Workflows → + Create Workflow → Start from scratch</b>.</p>
            <p>Name it (see per-pipeline table below).</p>
          </Step>

          <Step n={2} title="Add trigger: Pipeline Stage Changed">
            <p>Trigger type: <b>Pipeline Stage Changed</b>. Then add filters:</p>
            <ul className="ml-4 list-disc">
              <li>Filter <b>In pipeline</b> = the specific pipeline (see below)</li>
              <li>Filter <b>In stage</b> = only the stages that touch inventory (see below)</li>
            </ul>
          </Step>

          <Step n={3} title="Add action: Custom Webhook">
            <p>
              Click + → choose <b>Custom Webhook</b> (the premium one with method / URL / headers /
              raw body — the plain "Webhook" action won't work because it can't send a custom body).
            </p>
            <div className="rounded-md border p-3 text-xs">
              <div><b>ACTION NAME:</b> Send to Kleegr</div>
              <div><b>EVENT:</b> CUSTOM</div>
              <div><b>METHOD:</b> POST</div>
              <div><b>URL:</b> <span className="font-mono">{WEBHOOK_URL}</span></div>
              <div><b>AUTHORIZATION:</b> None</div>
              <div><b>CONTENT-TYPE:</b> application/json</div>
            </div>
          </Step>

          <Step n={4} title="Add the header">
            <p>Under <b>HEADERS</b> → Add item:</p>
            <div className="rounded-md border p-3 text-xs">
              <div><b>Key:</b> <code>x-kleegr-secret</code></div>
              <div><b>Value:</b> your saved <code>KLEEGR_WEBHOOK_SECRET</code> value</div>
            </div>
          </Step>

          <Step n={5} title="Paste the RAW BODY">
            <p>Copy this JSON exactly (also shown at the top of the page):</p>
            <CopyBlock value={PAYLOAD} />
            <p className="text-xs">
              Use the <code>{"{}"}</code> Custom Value picker for each <code>{"{{...}}"}</code>{" "}
              tag. From your GHL picker (Opportunity section), you'll pick:{" "}
              <b>Opportunity (ID)</b>, <b>Opportunity (Name)</b>, <b>Pipeline Name</b>,{" "}
              <b>Stage Name</b>.
            </p>
          </Step>

          <Step n={6} title="Save & publish">
            <p>Save the action → toggle workflow from <b>Draft</b> → <b>Publish</b> → Save.</p>
          </Step>
        </CardContent>
      </Card>

      {/* ============ PIPELINE A ============ */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-blue-500" />
            Pipeline A — Local Market Pipeline
          </CardTitle>
          <CardDescription>Workflow name: <code>Kleegr — Local Market Stage Sync</code></CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm">
            <b>Filter → In pipeline:</b> Local Market Pipeline
          </div>
          <div className="text-sm">
            <b>Filter → In stage:</b> select ONLY these 4:
          </div>
          <div className="rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-left">Stage name in GHL</th>
                  <th className="p-2 text-left">Applied status</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t"><td className="p-2">Contract Negotiation / Unit Reserved</td><td className="p-2"><Badge variant="secondary">Reserved</Badge></td></tr>
                <tr className="border-t"><td className="p-2">Contract Signed / Unit Locked</td><td className="p-2"><Badge variant="secondary">Under Contract</Badge></td></tr>
                <tr className="border-t"><td className="p-2">Closing</td><td className="p-2"><Badge>Sold</Badge></td></tr>
                <tr className="border-t"><td className="p-2">Lost / Not Interested</td><td className="p-2"><Badge variant="outline">Available (Released)</Badge></td></tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ============ PIPELINE B ============ */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />
            Pipeline B — General Market Pipeline
          </CardTitle>
          <CardDescription>Workflow name: <code>Kleegr — General Market Stage Sync</code></CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="text-sm">
            <b>Filter → In pipeline:</b> General Market Pipeline
          </div>
          <div className="text-sm">
            <b>Filter → In stage:</b> select ONLY these 3:
          </div>
          <div className="rounded-md border">
            <table className="w-full text-xs">
              <thead className="bg-muted/50">
                <tr>
                  <th className="p-2 text-left">Stage name in GHL</th>
                  <th className="p-2 text-left">Applied status</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t"><td className="p-2">Contract Signed / Unit Reserved</td><td className="p-2"><Badge variant="secondary">Under Contract</Badge></td></tr>
                <tr className="border-t"><td className="p-2">Closing</td><td className="p-2"><Badge>Sold</Badge></td></tr>
                <tr className="border-t"><td className="p-2">Lost / Not Interested</td><td className="p-2"><Badge variant="outline">Available (Released)</Badge></td></tr>
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>

      {/* ============ HOW AUTOMATION WORKS ============ */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">How the automation works</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>When a salesperson moves an opportunity's stage in GHL:</p>
          <ol className="ml-4 list-decimal space-y-1">
            <li>GHL fires the webhook with just the opportunity ID + stage name.</li>
            <li>Kleegr looks up the pipeline+stage mapping by name.</li>
            <li>Kleegr calls the GHL API to fetch the opportunity's <b>Locked/Reserved Units</b> association → gets the Unit CRM ID automatically.</li>
            <li>Kleegr updates the Unit's status and rolls up the Building & Project totals.</li>
          </ol>
          <p className="pt-2">
            <b>If no unit is linked yet</b> (salesperson moved the stage before attaching a unit),
            the event is queued in <b>Pending Events</b> on the Dashboard and auto-applies the
            moment they add the unit — no lost updates.
          </p>
        </CardContent>
      </Card>

      {/* ============ TESTING & TROUBLESHOOTING ============ */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle className="text-base">Testing</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <ol className="ml-4 list-decimal space-y-1">
            <li>First, run <b>Settings → Sync from CRM → Sync Everything</b> to populate Kleegr with existing Units.</li>
            <li>In GHL, open a test opportunity, attach a Unit under <b>Associations → Locked/Reserved Units</b>.</li>
            <li>Drag it to a stage in the table above (e.g. <b>Contract Negotiation / Unit Reserved</b>).</li>
            <li>Open <b>Kleegr → Dashboard</b> — the event should appear as ✅ applied within 5 seconds.</li>
            <li>Open <b>Inventory</b> — the Unit's status should reflect the change.</li>
          </ol>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Troubleshooting</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3 text-sm text-muted-foreground">
          <div>
            <b className="text-foreground">Event stays in Pending Events:</b> No Unit is linked
            to that opportunity yet. Attach one in GHL → it auto-replays.
          </div>
          <div>
            <b className="text-foreground">"stage_not_mapped" in Dashboard:</b> Your GHL stage
            name doesn't match what's saved in <b>Settings → CRM</b>. Fix the stage name in one
            of the two places.
          </div>
          <div>
            <b className="text-foreground">401 Invalid signature:</b> The <code>x-kleegr-secret</code>{" "}
            header value doesn't match. Re-copy the secret and paste it into the GHL webhook header.
          </div>
          <div>
            <b className="text-foreground">Webhook not firing:</b> In GHL, open the workflow's
            Execution Log for the test opportunity — the trigger might not be matching the
            pipeline/stage filter.
          </div>
        </CardContent>
      </Card>
    </AppShell>
  );
}
