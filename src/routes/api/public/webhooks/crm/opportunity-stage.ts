/**
 * Canonical opportunity-stage webhook URL (whitelabel-clean, no vendor name).
 * All logic lives in opportunity-stage-webhook.server.ts.
 */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/webhooks/crm/opportunity-stage")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { handleOpportunityStagePost } = await import("@/lib/kleegr/opportunity-stage-webhook.server");
        return handleOpportunityStagePost(request);
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});
