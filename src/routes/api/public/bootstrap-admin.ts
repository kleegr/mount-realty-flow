/**
 * TEMPORARY bootstrap/diagnostic endpoint. DELETE THIS FILE after use.
 *
 *   ?token=<TOKEN>&ping=1   -> proves the route is deployed (touches nothing)
 *   ?token=<TOKEN>&env=1    -> reports which Supabase env vars exist (no values)
 *   ?token=<TOKEN>          -> grants admin to aftab@kleegr.com
 */
import { createFileRoute } from "@tanstack/react-router";

const BOOTSTRAP_TOKEN = "kb7Xt2mQ9pR4wLzN8vD3sFhJ6yA1cE5u";
const TARGET_EMAIL = "aftab@kleegr.com";

export const Route = createFileRoute("/api/public/bootstrap-admin")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const url = new URL(request.url);

          if (url.searchParams.get("token") !== BOOTSTRAP_TOKEN) {
            return json({ error: "Invalid token" }, 401);
          }

          // 1) Liveness check — no imports, no env, no DB.
          if (url.searchParams.get("ping") === "1") {
            return json({ ok: true, ping: "route is deployed and running" });
          }

          // 2) Env check — presence only, never values.
          if (url.searchParams.get("env") === "1") {
            return json({
              ok: true,
              env_present: {
                SUPABASE_URL: Boolean(process.env.SUPABASE_URL),
                SUPABASE_SERVICE_ROLE_KEY: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
                SUPABASE_PUBLISHABLE_KEY: Boolean(process.env.SUPABASE_PUBLISHABLE_KEY),
                KLEEGR_CRM_TOKEN: Boolean(process.env.KLEEGR_CRM_TOKEN),
                KLEEGR_WEBHOOK_SECRET: Boolean(process.env.KLEEGR_WEBHOOK_SECRET),
              },
            });
          }

          // 3) The actual grant.
          const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

          const { data: list, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
          if (error) return json({ step: "listUsers", error: error.message }, 500);

          const emailById = new Map(list.users.map((u) => [u.id, u.email ?? "(no email)"]));
          const { data: roleRows, error: roleErr } = await supabaseAdmin
            .from("user_roles")
            .select("user_id, role");
          if (roleErr) return json({ step: "selectRoles", error: roleErr.message }, 500);

          const allRoles = (roleRows ?? []).map((r) => ({
            email: emailById.get(r.user_id) ?? r.user_id,
            role: r.role,
          }));

          const target = list.users.find(
            (u) => (u.email ?? "").toLowerCase() === TARGET_EMAIL.toLowerCase(),
          );
          if (!target) {
            return json(
              {
                ok: false,
                message: `${TARGET_EMAIL} has not signed up yet. Create the account at /auth, then reload this URL.`,
                known_users: list.users.map((u) => u.email ?? "(no email)"),
                all_roles: allRoles,
              },
              404,
            );
          }

          const wasAlreadyAdmin = (roleRows ?? []).some(
            (r) => r.user_id === target.id && r.role === "admin",
          );

          if (!wasAlreadyAdmin) {
            const { error: insErr } = await supabaseAdmin
              .from("user_roles")
              .insert({ user_id: target.id, role: "admin" });
            if (insErr && !/duplicate/i.test(insErr.message)) {
              return json({ step: "insertRole", error: insErr.message }, 500);
            }
          }

          const { data: after } = await supabaseAdmin
            .from("user_roles")
            .select("role")
            .eq("user_id", target.id);

          return json({
            ok: true,
            email: TARGET_EMAIL,
            was_already_admin: wasAlreadyAdmin,
            roles_now: (after ?? []).map((r) => r.role),
            all_roles_in_system: allRoles,
            next_step: "Sign out and back in at /auth. Then delete this endpoint.",
          });
        } catch (err) {
          // Surface the real reason instead of the generic 500 page.
          return json(
            {
              ok: false,
              caught: err instanceof Error ? err.message : String(err),
              stack: err instanceof Error ? (err.stack ?? "").split("\n").slice(0, 5) : undefined,
            },
            500,
          );
        }
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
