/**
 * Fetch an Opportunity's associated Unit / Building from GHL.
 *
 * When the stage-change webhook fires, GHL's picker doesn't expose Association
 * merge tags on many plans — so we look them up server-side using the CRM API.
 *
 * CRITICAL — association types are NOT interchangeable:
 *
 *   Suggested Units       (key: suggested_units)       browsing / shortlist.
 *                                                       MUST NOT affect inventory.
 *   Locked/Reserved Units (key: lockedreserved_units)   the committed unit.
 *                                                       This one drives inventory.
 *
 * A single opportunity routinely has several Suggested Units and at most one
 * Locked/Reserved Unit. Every relation row carries an `associationId`, so we
 * resolve the association definitions for the location, then keep only the
 * relations belonging to the Locked/Reserved association. Taking "the first
 * unit we find" locks whichever unit GHL happens to return first — usually a
 * suggested one — and silently removes the wrong unit from the market.
 *
 * Relation shape returned by GET /associations/relations/{recordId}:
 *   {
 *     id, associationId,
 *     firstObjectKey:  "custom_objects.units",
 *     firstRecordId:   "<unit id>",
 *     secondObjectKey: "opportunity",
 *     secondRecordId:  "<opportunity id>",
 *   }
 * Either side may hold the unit, so we take whichever side is not the opportunity.
 */
import type { CrmClient } from "./client.server";

export interface OpportunityAssociations {
  /** The Locked/Reserved unit — the only unit permitted to drive inventory. */
  unitCrmId: string | null;
  buildingCrmId: string | null;
  /** Informational: units merely suggested to this lead. Never locked. */
  suggestedUnitCrmIds: string[];
  raw?: unknown;
}

interface Relation {
  id?: string;
  associationId?: string;
  firstObjectKey?: string;
  firstRecordId?: string;
  secondObjectKey?: string;
  secondRecordId?: string;
}

interface AssociationDef {
  id?: string;
  key?: string;
  firstObjectKey?: string;
  secondObjectKey?: string;
  firstObjectLabel?: string;
  secondObjectLabel?: string;
}

interface ResolvedAssociations {
  locked: Set<string>;
  suggested: Set<string>;
}

const assocDefCache = new WeakMap<CrmClient, Promise<AssociationDef[]>>();

async function listAssociationDefs(client: CrmClient): Promise<AssociationDef[]> {
  const locationId = client.config.location_id;
  if (!locationId) return [];
  let cached = assocDefCache.get(client);
  if (!cached) {
    cached = client
      .request<{ associations?: AssociationDef[] }>("GET", "/associations/", {
        query: { locationId, skip: 0, limit: 100 },
      })
      .then((res) => (Array.isArray(res.data?.associations) ? res.data.associations : []))
      .catch((err) => {
        console.warn(
          "[opportunities] association definitions lookup failed:",
          err instanceof Error ? err.message : err,
        );
        return [] as AssociationDef[];
      });
    assocDefCache.set(client, cached);
  }
  return cached;
}

/**
 * Split the unit<->opportunity associations into "locked/reserved" and
 * "suggested" by their key/labels. Matched on meaning rather than hardcoded
 * ids so the app survives the association being recreated in GHL.
 */
async function resolveAssociations(client: CrmClient): Promise<ResolvedAssociations> {
  const defs = await listAssociationDefs(client);
  const locked = new Set<string>();
  const suggested = new Set<string>();

  for (const def of defs) {
    if (!def.id) continue;
    const keys = [def.firstObjectKey, def.secondObjectKey].map((k) => String(k ?? "").toLowerCase());
    const touchesUnits = keys.some((k) => /(^|\.)units?$/.test(k));
    const touchesOpportunity = keys.some((k) => k === "opportunity");
    if (!touchesUnits || !touchesOpportunity) continue;

    const haystack = [def.key, def.firstObjectLabel, def.secondObjectLabel]
      .map((v) => String(v ?? "").toLowerCase())
      .join(" ");

    // Check "suggested" first: a label like "Suggested Units" must never be
    // mistaken for a lock.
    if (/suggest/.test(haystack)) suggested.add(def.id);
    else if (/lock|reserv/.test(haystack)) locked.add(def.id);
  }

  return { locked, suggested };
}

/** The side of a relation that isn't the opportunity. */
function relatedSide(rel: Relation, opportunityId: string): { objectKey: string; recordId: string } | null {
  const sides = [
    { objectKey: String(rel.firstObjectKey ?? "").toLowerCase(), recordId: String(rel.firstRecordId ?? "") },
    { objectKey: String(rel.secondObjectKey ?? "").toLowerCase(), recordId: String(rel.secondRecordId ?? "") },
  ];
  for (const side of sides) {
    if (!side.recordId) continue;
    if (side.objectKey === "opportunity") continue;
    if (side.recordId === opportunityId) continue;
    return side;
  }
  return null;
}

async function fetchRelations(
  client: CrmClient,
  opportunityId: string,
  locationId: string,
): Promise<Relation[]> {
  try {
    const res = await client.request<{ relations?: Relation[] }>(
      "GET",
      `/associations/relations/${opportunityId}`,
      { query: { locationId, skip: 0, limit: 100 } },
    );
    return Array.isArray(res.data?.relations) ? res.data.relations : [];
  } catch (err) {
    console.warn(
      "[opportunities] associations lookup failed:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }
}

export async function fetchOpportunityAssociations(
  client: CrmClient,
  opportunityId: string,
): Promise<OpportunityAssociations> {
  const empty: OpportunityAssociations = { unitCrmId: null, buildingCrmId: null, suggestedUnitCrmIds: [] };
  const locationId = client.config.location_id;
  if (!locationId) return empty;

  const [assoc, relations] = await Promise.all([
    resolveAssociations(client),
    fetchRelations(client, opportunityId, locationId),
  ]);

  if (relations.length === 0) return empty;

  const lockedUnits: string[] = [];
  const suggestedUnits: string[] = [];
  const unclassifiedUnits: string[] = [];
  let buildingCrmId: string | null = null;

  for (const rel of relations) {
    const side = relatedSide(rel, opportunityId);
    if (!side) continue;
    const assocId = String(rel.associationId ?? "");

    if (/(^|\.)units?$/.test(side.objectKey)) {
      if (assoc.suggested.has(assocId)) suggestedUnits.push(side.recordId);
      else if (assoc.locked.has(assocId)) lockedUnits.push(side.recordId);
      else unclassifiedUnits.push(side.recordId);
      continue;
    }
    if (/(^|\.)buildings?$/.test(side.objectKey) && !buildingCrmId) {
      buildingCrmId = side.recordId;
    }
  }

  // Only a Locked/Reserved unit may move inventory.
  let unitCrmId: string | null = lockedUnits[0] ?? null;

  if (lockedUnits.length > 1) {
    console.warn(
      `[opportunities] opportunity ${opportunityId} has ${lockedUnits.length} Locked/Reserved units; using the first (${unitCrmId}).`,
    );
  }

  // Fallback: this location defines no Locked/Reserved association at all, so
  // there is nothing to filter on. Use a non-suggested unit rather than doing
  // nothing — but never promote a Suggested unit into a lock.
  if (!unitCrmId && assoc.locked.size === 0 && unclassifiedUnits.length > 0) {
    unitCrmId = unclassifiedUnits[0];
    console.warn(
      `[opportunities] no Locked/Reserved association defined for this location; falling back to unclassified unit ${unitCrmId}.`,
    );
  }

  return { unitCrmId, buildingCrmId, suggestedUnitCrmIds: suggestedUnits };
}
