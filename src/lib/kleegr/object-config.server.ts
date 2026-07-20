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

type SchemaOptionObject = {
  key?: string;
  label?: string;
  value?: string;
  name?: string;
  id?: string;
};

type SchemaField = {
  name?: string;
  fieldKey?: string;
  dataType?: string;
  type?: string;
  options?: Array<SchemaOptionObject | string>;
  picklistOptions?: Array<SchemaOptionObject | string>;
  picklistOptionValues?: Array<SchemaOptionObject | string>;
  picklist?: Array<SchemaOptionObject | string>;
};

/**
 * GHL is inconsistent about WHERE a picklist's options live (options,
 * picklistOptions, picklistOptionValues, picklist) and about their SHAPE
 * (bare strings or objects with value/key/name/label/id). Collect every
 * option from every container. `canonical` is the string GHL's option
 * matcher accepts on write (the stored value); `aliases` is every string
 * a caller might plausibly send for it.
 */
function schemaOptionEntries(field: SchemaField): Array<{ canonical: string; aliases: string[] }> {
  const containers = [field.picklistOptions, field.picklistOptionValues, field.options, field.picklist];
  const entries: Array<{ canonical: string; aliases: string[] }> = [];
  for (const container of containers) {
    if (!Array.isArray(container)) continue;
    for (const raw of container) {
      if (typeof raw === "string") {
        if (raw.trim()) entries.push({ canonical: raw, aliases: [raw] });
        continue;
      }
      if (!raw || typeof raw !== "object") continue;
      const o = raw as SchemaOptionObject;
      const strings = [o.value, o.key, o.name, o.label, o.id]
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
      if (strings.length === 0) continue;
      // The stored VALUE is what the option matcher compares against on
      // write; fall through key/name/label when value is absent.
      const canonical = o.value ?? o.key ?? o.name ?? o.label ?? strings[0];
      entries.push({ canonical, aliases: strings });
    }
  }
  return entries;
}

/**
 * Resolve the string GHL's option matcher will accept, in strict safety order:
 *   1. the battle-tested hardcoded pairs (FALLBACK_OPTION_KEYS) — values
 *      proven to stick for the original options; these must never regress;
 *   2. the LIVE schema's stored option value — fixes options added later
 *      through the GHL UI, whose stored value GHL invents and no local guess
 *      can predict (e.g. the "Available" stage);
 *   3. a snake_case guess from the label (legacy last resort).
 */
function resolveOptionValue(prop: string, value: unknown, liveMap?: Map<string, string>): string | null {
  const n = normalizeOption(value);
  if (!n) return null;
  return FALLBACK_OPTION_KEYS[prop]?.[n] ?? liveMap?.get(n) ?? toOptionKey(value);
}

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
  const requestOpts = withRecordLocationQuery(client, method, suffix, opts);
  for (const key of candidates) {
    tried.push(key);
    try {
      return await client.request<T>(method, `/objects/${key}${suffix}`, requestOpts);
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

function withRecordLocationQuery(
  client: CrmClient,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  suffix: string,
  opts?: Parameters<CrmClient["request"]>[2],
): Parameters<CrmClient["request"]>[2] | undefined {
  if (
    !client.config.location_id
    || method === "POST"
    || !/^\/records\/[^/]+/.test(suffix)
    || opts?.query?.locationId
  ) {
    return opts;
  }

  return {
    ...opts,
    query: {
      ...opts?.query,
      locationId: client.config.location_id,
    },
  };
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

export interface NormalizeOptions {
  /**
   * True when the payload is destined for PUT /records/{id} rather than
   * POST /records. See needsArrayWrap() — GHL's two endpoints disagree about
   * the shape of MULTIPLE_OPTIONS values.
   */
  forUpdate?: boolean;
}

export async function normalizeRecordProperties(
  client: CrmClient,
  scope: CrmObjectScope,
  properties: Record<string, unknown>,
  opts?: NormalizeOptions,
): Promise<Record<string, unknown>> {
  const forUpdate = opts?.forUpdate === true;
  const clean = stripEmpty(properties);
  const schemaFields = await fetchSchemaFields(client, scope).catch(() => [] as SchemaField[]);
  if (schemaFields.length === 0) return normalizeWithFallbacks(clean);

  const optionMap = new Map<string, Map<string, string>>();
  const schemaTypeMap = new Map<string, string>();
  for (const field of schemaFields) {
    const keys = propertyKeysFor(field);
    const schemaType = String(field.dataType ?? field.type ?? "").toLowerCase();
    for (const k of keys) schemaTypeMap.set(k, schemaType);

    const entries = schemaOptionEntries(field);
    if (keys.length === 0 || entries.length === 0) continue;
    const valueMap = new Map<string, string>();
    for (const entry of entries) {
      for (const alias of entry.aliases) {
        const n = normalizeOption(alias);
        if (n && !valueMap.has(n)) valueMap.set(n, entry.canonical);
      }
    }
    for (const k of keys) optionMap.set(k, valueMap);
  }

  const out: Record<string, unknown> = {};
  for (const [prop, value] of Object.entries(clean)) {
    if (!schemaTypeMap.has(prop)) continue;
    const schemaType = schemaTypeMap.get(prop) ?? "";
    const isMulti = prop !== "stages" && needsArrayWrap(schemaType, forUpdate);

    const map = optionMap.get(prop);
    if (!map) {
      const normalized = normalizeBySchemaType(prop, value, schemaType);
      out[prop] = isMulti && !Array.isArray(normalized) ? [normalized].filter(Boolean) : normalized;
      continue;
    }

    if (Array.isArray(value)) {
      const mapped = value
        .map((v) => resolveOptionValue(prop, v, map))
        .filter(Boolean);
      if (mapped.length === 0) continue;
      // On update a MULTIPLE_OPTIONS field cannot take an array at all, so an
      // incoming array collapses to its first value.
      out[prop] = isMulti ? mapped : mapped[0];
      continue;
    }

    const mapped = resolveOptionValue(prop, value, map);
    if (mapped) out[prop] = isMulti ? [mapped] : mapped;
  }
  return out;
}

function isMultiSelectType(schemaType: string): boolean {
  return /checkbox|multi|list/.test(schemaType);
}

/**
 * Should this value be wrapped in an array?
 *
 * GHL quirk, measured against the live API (2026-07-15) on a MULTIPLE_OPTIONS
 * field (`property_type`, optionKeys condo|rental|mixed_use):
 *
 *   POST /objects/{key}/records        property_type: ["condo"]  -> OK
 *   PUT  /objects/{key}/records/{id}   property_type: ["condo"]  -> 422
 *        "We couldn't apply updates to Property Type due to an unexpected format."
 *   PUT  /objects/{key}/records/{id}   property_type: "condo"    -> OK
 *
 * i.e. create accepts the array, update refuses it and wants a bare option key.
 * CHECKBOX fields accept an array on both verbs, so this exception is scoped to
 * MULTIPLE_OPTIONS on update only.
 *
 * Known limitation: because update takes a bare string, a MULTIPLE_OPTIONS
 * field can only be updated to a SINGLE value through this path.
 */
function needsArrayWrap(schemaType: string, forUpdate: boolean): boolean {
  if (!isMultiSelectType(schemaType)) return false;
  if (forUpdate && /multiple[_\s-]?options/.test(schemaType)) return false;
  return true;
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
