import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

/**
 * PIN gate — replaces the login screen for the GHL-embedded portal.
 *
 * How it works: the PIN is checked ON THE SERVER ONLY (it never ships in the
 * browser bundle). A correct PIN mints a real Supabase session for a shared
 * internal account (portal@kleegr.com, role: importer), so every existing
 * auth middleware, role check, and approval rule keeps working untouched.
 *
 * Brute-force protection: after 15 wrong attempts within 10 minutes (global),
 * the gate locks for a cool-down. Attempts are logged to audit_events.
 *
 * The PIN can be rotated without a deploy by setting the KLEEGR_PORTAL_PIN
 * environment variable in Vercel; the value below is only the fallback.
 */

const PORTAL_EMAIL = "portal@kleegr.com";
const MAX_FAILS = 15;
const WINDOW_MS = 10 * 60 * 1000;

export const pinLogin = createServerFn({ method: "POST" })
  .inputValidator((d: unknown) => z.object({ pin: z.string().min(4).max(12) }).parse(d))
  .handler(async ({ data }) => {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const expected = process.env.KLEEGR_PORTAL_PIN ?? "9909";

    // Global brute-force throttle.
    const since = new Date(Date.now() - WINDOW_MS).toISOString();
    const { count } = await supabaseAdmin
      .from("audit_events")
      .select("*", { count: "exact", head: true })
      .eq("kind", "pin_attempt_failed")
      .gte("created_at", since);
    if ((count ?? 0) >= MAX_FAILS) {
      return { ok: false as const, error: "Too many attempts. Please wait a few minutes and try again." };
    }

    if (data.pin !== expected) {
      await supabaseAdmin
        .from("audit_events")
        .insert({ kind: "pin_attempt_failed", reason: "wrong pin" })
        .then(() => undefined, () => undefined);
      return { ok: false as const, error: "Wrong PIN" };
    }

    // Ensure the shared portal user exists.
    let link = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email: PORTAL_EMAIL });
    if (link.error) {
      const created = await supabaseAdmin.auth.admin.createUser({
        email: PORTAL_EMAIL,
        email_confirm: true,
        user_metadata: { full_name: "Kleegr Portal" },
      });
      if (created.error && !/already|exists|registered/i.test(created.error.message)) {
        return { ok: false as const, error: created.error.message };
      }
      link = await supabaseAdmin.auth.admin.generateLink({ type: "magiclink", email: PORTAL_EMAIL });
      if (link.error) return { ok: false as const, error: link.error.message };
    }

    const userId = link.data.user?.id;
    const tokenHash = link.data.properties?.hashed_token;
    if (!userId || !tokenHash) return { ok: false as const, error: "Could not create a session. Try again." };

    // Ensure the portal user is approved with importer access.
    const { data: roleRows } = await supabaseAdmin.from("user_roles").select("role").eq("user_id", userId);
    const roles = (roleRows ?? []).map((r) => r.role);
    if (!roles.includes("admin") && !roles.includes("importer") && !roles.includes("viewer")) {
      await supabaseAdmin
        .from("user_roles")
        .delete()
        .eq("user_id", userId)
        .eq("role", "pending")
        .then(() => undefined, () => undefined);
      await supabaseAdmin
        .from("user_roles")
        .insert({ user_id: userId, role: "importer" })
        .then(() => undefined, () => undefined);
    }

    return { ok: true as const, tokenHash };
  });
