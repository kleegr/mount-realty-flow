/**
 * Kleegr / GHL CRM HTTP client. Server-only.
 * Handles: bearer auth, timeouts, retry-with-Retry-After, redacted logs, correlation IDs.
 */
import type { Database } from "@/integrations/supabase/types";

export type CrmConfig = Database["public"]["Tables"]["crm_config"]["Row"];

export interface CrmClient {
  config: CrmConfig;
  request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
    path: string,
    opts?: { query?: Record<string, string | number | undefined>; body?: unknown; correlationId?: string },
  ): Promise<{ status: number; data: T; correlationId: string }>;
}

const API_VERSION = "2021-07-28";
const DEFAULT_TIMEOUT_MS = 20_000;
const MAX_RETRIES = 3;

export async function loadCrmConfig(): Promise<CrmConfig> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin.from("crm_config").select("*").eq("id", 1).maybeSingle();
  if (error) throw new Error("Failed to load CRM config: " + error.message);
  if (!data) throw new Error("CRM config missing. Contact admin.");
  return data;
}

export async function createCrmClient(): Promise<CrmClient> {
  const config = await loadCrmConfig();
  const token = process.env.KLEEGR_CRM_TOKEN;
  if (!token) throw new Error("KLEEGR_CRM_TOKEN is not configured.");

  const request: CrmClient["request"] = async (method, path, opts = {}) => {
    const correlationId = opts.correlationId ?? crypto.randomUUID();
    const url = new URL(path, config.api_base_url);
    if (opts.query) {
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
      }
    }
    let attempt = 0;
    while (true) {
      attempt++;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);
      try {
        const res = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
            Version: API_VERSION,
          },
          body: opts.body ? JSON.stringify(opts.body) : undefined,
          signal: controller.signal,
        });
        clearTimeout(timer);
        if (res.status === 429 && attempt <= MAX_RETRIES) {
          const retryAfter = Number(res.headers.get("retry-after") ?? "2");
          await sleep(retryAfter * 1000);
          continue;
        }
        if (res.status >= 500 && attempt <= MAX_RETRIES) {
          await sleep(500 * attempt);
          continue;
        }
        const text = await res.text();
        const data = text ? tryJson(text) : (null as unknown);
        if (!res.ok) {
          console.error(`[kleegr ${correlationId}] ${method} ${path} → ${res.status}: ${text.slice(0, 500)}`);
          throw new CrmError(res.status, `${method} ${path} failed (${res.status}): ${truncate(text, 300)}`, data);
        }
        return { status: res.status, data: data as never, correlationId };
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof CrmError) throw err;
        if (attempt <= MAX_RETRIES) {
          await sleep(500 * attempt);
          continue;
        }
        throw err;
      }
    }
  };

  return { config, request };
}

export class CrmError extends Error {
  constructor(public status: number, message: string, public body?: unknown) {
    super(message);
    this.name = "CrmError";
  }
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
function tryJson(t: string) { try { return JSON.parse(t); } catch { return t; } }
function truncate(s: string, n: number) { return s.length > n ? s.slice(0, n) + "…" : s; }
