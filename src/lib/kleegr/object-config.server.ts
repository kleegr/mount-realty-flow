import { CrmError, type CrmClient } from "./client.server";

export type CrmObjectScope = "project" | "building" | "unit";

const OPTION_FIELDS = new Set(["unit_status", "stages", "style", "property_type", "project_status", "building_status", "movein_ready", "inventory_deducted", "recalc_requested"]);

const FALLBACK_OPTION_KEYS: Record<string, Record<string, string>> = {
  unit_status: {
    available: "available",
    notavailable: "not_available",
  },
  stages: {
    reservedlocked: "reserved_locked",
    undercontract: "under_contract",
    closedsold: "closed_sold",
  },
};

type SchemaField = {
  name?: string;
  fieldKey?: string;
  dataType?: string;
  options?: Array<{ key?: string; label?: string }>;
};

export function objectKey(client: CrmClient, scope: CrmObjectScope): string {
  return objectKeyCandidates(client, scope)[0];
}

export function objectKeyCandidates(client: CrmClient, scope: CrmObjectScope): string[] {
  const c = client.config as unknown as Record<string, string | null>;
  const configured = scope === "project"
    ? [c.project_object_key, c.project_object_id]
    : scope === "building"
      ? [c.building_object_key, c.building_object_id]
      : [c.unit_object_key, c.unit_object_id];
  const aliases = scope === "project"
    ? ["custom_objects.projects", "custom_objects.project"]
    : scope === "building"
      ? ["custom_objects.buildings", "custom_objects.building"]
      : ["custom_objects.units", "custom_objects.unit"];
  const candidates = [...configured, ...aliases]
    .map((v) => (v ?? "").trim())
    .filter(Boolean);
  const unique = Array.from(new Set(candidates));

  if (unique.length === 0) throw new Error(`CRM ${scope} object key is not configured.`);
  return unique;
}

export async function requestObject<T = unknown>(
  client: CrmClient,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  scope: CrmObjectScope,
  suffix: string,
  opts?: Parameters<CrmClient["request"]>[2],
): Promise<{ status: number; data: T; correlationId: string }> {
  const candidates = objectKeyCandidates(client, scope);
  const tried: string[] = [];
  for (const key of candidates) {
    tried.push(key);
    try {
      return await client.request<T>(method, `/objects/${key}${suffix}`, opts);
    } catch (err) {
      if (isMissingObject(err) && key !== candidates[candidates.length - 1]) continue;
      if (isMissingObject(err)) {
        throw new Error(
          `CRM ${scope} object not found. Update CRM Settings with the Object Schema Key from CRM Custom Objects (tried: ${tried.join(", ")}).`,
        );
      }
      throw err;
    }
  }
  throw new Error(`CRM ${scope} object not found.`);
}

export async function normalizeRecordProperties(
  client: CrmClient,
  scope: CrmObjectScope,
  properties: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const clean = stripEmpty(properties);
  const schemaFields = await fetchSchemaFields(client, scope).catch(() => [] as SchemaField[]);
  if (schemaFields.length === 0) return normalizeWithFallbacks(clean);

  const optionMap = new Map<string, Map<string, string>>();
  for (const field of schemaFields) {
    const keys = propertyKeysFor(field);
    const options = field.options ?? [];
    if (keys.length === 0 || options.length === 0) continue;
    const valueMap = new Map<string, string>();
    for (const opt of options) {
      if (!opt.key) continue;
      valueMap.set(normalizeOption(opt.key), opt.key);
      if (opt.label) valueMap.set(normalizeOption(opt.label), opt.key);
    }
    for (const k of keys) optionMap.set(k, valueMap);
  }

  const out: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(clean)) {
    const map = optionMap.get(prop);
    if (!map) {
      out[prop] = normalizeWithFallback(prop, value);
      continue;
    }

    if (Array.isArray(value)) {
      const mapped = value
        .map((v) => map.get(normalizeOption(v)) ?? fallbackOption(prop, v))
        .filter(Boolean);
      if (mapped.length > 0) out[prop] = mapped;
      continue;
    }

    const mapped = map.get(normalizeOption(value)) ?? fallbackOption(prop, value);
    if (mapped) out[prop] = mapped;
  }
  return out;
}

async function fetchSchemaFields(client: CrmClient, scope: CrmObjectScope): Promise<SchemaField[]> {
  const locationId = client.config.location_id;
  if (!locationId) return [];
  const res = await requestObject<{ fields?: SchemaField[] }>(client, "GET", scope, "", {
    query: { locationId, fetchProperties: "true" },
  });
  return Array.isArray(res.data?.fields) ? res.data.fields : [];
}

function isMissingObject(err: unknown): boolean {
  return err instanceof CrmError && err.status === 404 && /Custom Object .* not found|object .* not found/i.test(err.message);
}

function propertyKeysFor(field: SchemaField): string[] {
  const keys = new Set<string>();
  if (field.name) keys.add(field.name);
  if (field.fieldKey) {
    keys.add(field.fieldKey);
    const parts = field.fieldKey.split(".");
    const tail = parts[parts.length - 1];
    if (tail) keys.add(tail);
  }
  return Array.from(keys);
}

function normalizeWithFallbacks(properties: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(properties)) out[prop] = normalizeWithFallback(prop, value);
  return stripEmpty(out);
}

function normalizeWithFallback(prop: string, value: unknown): unknown {
  if (!OPTION_FIELDS.has(prop)) return value;
  if (Array.isArray(value)) return value.map((v) => fallbackOption(prop, v) ?? v).filter(Boolean);
  return fallbackOption(prop, value) ?? value;
}

function fallbackOption(prop: string, value: unknown): string | null {
  const key = normalizeOption(value);
  if (!key) return null;
  return FALLBACK_OPTION_KEYS[prop]?.[key] ?? toOptionKey(value);
}

function stripEmpty(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === "" || v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

function normalizeOption(value: unknown): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "").trim();
}

function toOptionKey(value: unknown): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_+/g, "_");
}