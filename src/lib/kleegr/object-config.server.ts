import { CrmError, type CrmClient } from "./client.server";

export type CrmObjectScope = "project" | "building" | "unit";

const OPTION_FIELDS = new Set(["availablenot_available", "unit_status", "stages", "style", "property_type", "project_status", "building_status", "movein_ready", "inventory_deducted", "recalc_requested"]);

const FALLBACK_OPTION_KEYS: Record<string, Record<string, string>> = {
  availablenot_available: {
    available: "available",
    notavailable: "not_available",
  },
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
  type?: string;
  options?: Array<{ key?: string; label?: string }>;
};

type CrmObjectDefinition = {
  id?: string;
  key?: string;
  labels?: { singular?: string; plural?: string };
};

const OBJECT_LABELS: Record<CrmObjectScope, { singular: string; plural: string }> = {
  project: { singular: "project", plural: "projects" },
  building: { singular: "building", plural: "buildings" },
  unit: { singular: "unit", plural: "units" },
};

const objectListCache = new WeakMap<CrmClient, Promise<CrmObjectDefinition[]>>();

export function objectKey(client: CrmClient, scope: CrmObjectScope): string {
  return objectKeyCandidates(client, scope)[0];
}

export function objectKeyCandidates(client: CrmClient, scope: CrmObjectScope): string[] {
  const c = client.config as unknown as Record<string, string | null>;
  const configured = scope === "project"
    ? [c.project_object_id, c.project_object_key]
    : scope === "building"
      ? [c.building_object_id, c.building_object_key]
      : [c.unit_object_id, c.unit_object_key];
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
  const candidates = await objectKeyCandidatesWithLiveMatch(client, scope);
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

async function objectKeyCandidatesWithLiveMatch(client: CrmClient, scope: CrmObjectScope): Promise<string[]> {
  const candidates = objectKeyCandidates(client, scope);
  const liveKey = await resolveLiveObjectKey(client, scope, candidates).catch(() => null);
  return liveKey ? [liveKey, ...candidates.filter((candidate) => candidate !== liveKey)] : candidates;
}

async function resolveLiveObjectKey(
  client: CrmClient,
  scope: CrmObjectScope,
  candidates: string[],
): Promise<string | null> {
  const objects = await listCrmObjects(client);
  const candidateSet = new Set(candidates.map(normalizeCandidate));
  const exact = objects.find((object) =>
    (object.id && candidateSet.has(normalizeCandidate(object.id)))
    || (object.key && candidateSet.has(normalizeCandidate(object.key))),
  );
  if (exact?.key || exact?.id) return exact.key ?? exact.id ?? null;

  const labels = OBJECT_LABELS[scope];
  const byLabel = objects.find((object) => {
    const singular = normalizeLabel(object.labels?.singular);
    const plural = normalizeLabel(object.labels?.plural);
    return singular === labels.singular || plural === labels.plural;
  });
  if (byLabel?.key || byLabel?.id) return byLabel.key ?? byLabel.id ?? null;

  const suffix = `.${labels.plural}`;
  const byKeySuffix = objects.find((object) => object.key?.toLowerCase().endsWith(suffix));
  return byKeySuffix?.key ?? byKeySuffix?.id ?? null;
}

async function listCrmObjects(client: CrmClient): Promise<CrmObjectDefinition[]> {
  const locationId = client.config.location_id;
  if (!locationId) return [];

  let cached = objectListCache.get(client);
  if (!cached) {
    cached = client
      .request<{ objects?: CrmObjectDefinition[] }>("GET", "/objects/", { query: { locationId } })
      .then((res) => Array.isArray(res.data?.objects) ? res.data.objects : []);
    objectListCache.set(client, cached);
  }
  return cached;
}

function normalizeCandidate(value: string): string {
  return value.trim().toLowerCase();
}

function normalizeLabel(value: string | undefined): string {
  return String(value ?? "").trim().toLowerCase();
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
  const schemaTypeMap = new Map<string, string>();
  for (const field of schemaFields) {
    const keys = propertyKeysFor(field);
    const schemaType = String(field.dataType ?? field.type ?? "").toLowerCase();
    for (const k of keys) schemaTypeMap.set(k, schemaType);

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
    if (!schemaTypeMap.has(prop)) continue;

    const map = optionMap.get(prop);
    if (!map) {
      out[prop] = normalizeBySchemaType(prop, value, schemaTypeMap.get(prop) ?? "");
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
  return err instanceof CrmError
    && err.status === 404
    && /Custom Object \([^)]+\) not found/i.test(err.message);
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

function normalizeBySchemaType(prop: string, value: unknown, schemaType: string): unknown {
  if (OPTION_FIELDS.has(prop)) return normalizeWithFallback(prop, value);
  if (isTextType(schemaType)) return String(value).trim();
  if (isCurrencyType(schemaType)) {
    if (value && typeof value === "object" && "value" in (value as Record<string, unknown>)) {
      const currencyValue = value as Record<string, unknown>;
      return {
        ...currencyValue,
        currency: typeof currencyValue.currency === "string" && currencyValue.currency.trim()
          ? currencyValue.currency
          : "default",
      };
    }
    const n = Number(String(value).replace(/[$,\s]/g, ""));
    if (!Number.isFinite(n)) return value;
    return { currency: "default", value: n };
  }
  if (isNumberType(schemaType)) {
    const n = Number(String(value).replace(/[$,\s]/g, ""));
    return Number.isFinite(n) ? n : value;
  }
  return value;
}

function isTextType(schemaType: string): boolean {
  return /text|string|phone|email|url|textarea|single[_\s-]?line|multi[_\s-]?line/.test(schemaType);
}

function isCurrencyType(schemaType: string): boolean {
  return /currency|monetary|monetory|money/.test(schemaType);
}

function isNumberType(schemaType: string): boolean {
  return /number|numeric|decimal|float|integer/.test(schemaType);
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