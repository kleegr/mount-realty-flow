/** Retired diagnostic endpoint. Stubbed so stale links fail safely. */
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/probe-proptype")({
  server: {
    handlers: {
      GET: async () =>
        new Response(JSON.stringify({ error: "This diagnostic endpoint has been retired." }), {
          status: 410,
          headers: { "Content-Type": "application/json" },
        }),
      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});
