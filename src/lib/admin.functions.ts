import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import { z } from "zod";

const ROLES = ["admin", "importer", "viewer", "pending"] as const;
type Role = (typeof ROLES)[number];

async function assertAdmin(userId: string) {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", userId)
    .eq("role", "admin")
    .maybeSingle();
  if (!data) throw new Error("Admin role required");
}

export const listUsers = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await assertAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data: authList, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 });
    if (error) throw new Error(error.message);
    const { data: roleRows } = await supabaseAdmin.from("user_roles").select("user_id, role");
    const roleMap = new Map<string, Role[]>();
    for (const r of roleRows ?? []) {
      const list = roleMap.get(r.user_id) ?? [];
      list.push(r.role as Role);
      roleMap.set(r.user_id, list);
    }
    const users = authList.users.map((u) => ({
      id: u.id,
      email: u.email ?? null,
      created_at: u.created_at,
      last_sign_in_at: u.last_sign_in_at ?? null,
      roles: roleMap.get(u.id) ?? [],
    }));
    users.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
    return { users, currentUserId: context.userId };
  });

export const setUserRole = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ userId: z.string().uuid(), role: z.enum(ROLES) }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");

    // Prevent removing the last admin
    if (data.userId === context.userId && data.role !== "admin") {
      const { count } = await supabaseAdmin
        .from("user_roles")
        .select("*", { count: "exact", head: true })
        .eq("role", "admin");
      if ((count ?? 0) <= 1) throw new Error("Cannot demote the last admin");
    }

    // Replace all roles for this user with the single chosen role
    const { error: delErr } = await supabaseAdmin.from("user_roles").delete().eq("user_id", data.userId);
    if (delErr) throw new Error(delErr.message);
    const { error: insErr } = await supabaseAdmin
      .from("user_roles")
      .insert({ user_id: data.userId, role: data.role });
    if (insErr) throw new Error(insErr.message);
    return { ok: true };
  });

export const deleteUser = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) => z.object({ userId: z.string().uuid() }).parse(d))
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    if (data.userId === context.userId) throw new Error("You cannot delete your own account here");
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.deleteUser(data.userId);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const adminUpdateUserEmail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: unknown) =>
    z.object({ userId: z.string().uuid(), email: z.string().email() }).parse(d),
  )
  .handler(async ({ data, context }) => {
    await assertAdmin(context.userId);
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin.auth.admin.updateUserById(data.userId, {
      email: data.email,
      email_confirm: true,
    });
    if (error) throw new Error(error.message);
    await supabaseAdmin.from("profiles").update({ email: data.email }).eq("id", data.userId);
    return { ok: true };
  });

export const getAccessStatus = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { data } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", context.userId);
    const roles = (data ?? []).map((r) => r.role as Role);
    const approved = roles.some((r) => r !== "pending") || roles.length === 0 ? roles.some((r) => r !== "pending") : false;
    return { roles, approved: roles.some((r) => r === "admin" || r === "importer" || r === "viewer") };
  });
