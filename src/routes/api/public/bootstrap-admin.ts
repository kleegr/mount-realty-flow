/**
 * TEMPORARY bootstrap endpoint — grants the admin role to aftab@kleegr.com.
 * Protected by a one-time token. DELETE THIS FILE after use.
 */
import { createFileRoute } from "@tanstack/react-router";

const BOOTSTRAP_TOKEN = "kb7Xt2mQ9pR4wLzN8vD3sFhJ6yA1cE5u";
const TARGET_EMAIL = "aftab@kleegr.com";

export const Route = createFileRoute("/api/public/bootstrap-admin")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        if (url.searchParams.get("token") !== BOOTSTRAP_TOKEN) {
          return json({ error: "Invalid token" }, 401);
        }

        const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

        const { data: list, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
        if (error) return json({ error: error.message }, 500);

        const emailById = new Map(list.users.map((u) => [u.id, u.email ?? "(no email)"]));
        const { data: roleRows, error: roleErr } = await supabaseAdmin
          .from("user_roles")
          .select("user_id, role");
        if (roleErr) return json({ error: roleErr.message }, 500);

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
              message: `${TARGET_EMAIL} has not signed up in the app yet. Create the account at /auth first, then call this endpoint again.`,
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
            return json({ error: insErr.message }, 500);
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
          next_step: "Sign out and back in at /auth. Then DELETE this endpoint.",
        });
      },
      OPTIONS: async () => new Response(null, { status: 204 }),
    },
  },
});

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
