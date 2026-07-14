/**
 * Associations: link Project ↔ Building and Building ↔ Unit.
 *
 * GHL requires an `associationId` (the id of the association DEFINITION between
 * two object schemas) — not just a string label. This module lists the
 * associations defined in the CRM location, matches the pair of object keys/ids,
 * and posts to `/associations/relations` with the right first/second record order.
 */
import type { CrmClient } from "./client.server";
import { objectKeyCandidates, type CrmObjectScope } from "./object-config.server";

export interface AssociationResult {
  ok: boolean;
  message?: string;
}

interface AssocDef {
  id?: string;
  key?: string;
  firstObjectKey?: string;
  secondObjectKey?: string;
  firstObjectId?: string;
  secondObjectId?: string;
  firstObjectLabel?: string;
  secondObjectLabel?: string;
}

const assocListCache = new WeakMap<CrmClient, Promise<AssocDef[]>>();

async function listAssociations(client: CrmClient): Promise<AssocDef[]> {
  const locationId = client.config.location_id;
  if (!locationId) return [];
  let cached = assocListCache.get(client);
  if (!cached) {
    cached = client
      .request<{ associations?: AssocDef[] }>("GET", "/associations/", {
        query: { locationId, skip: 0, limit: 100 },
      })
      .then((res) => (Array.isArray(res.data?.associations) ? res.data!.associations! : []))
      .catch((err) => {
        console.warn("Failed to list associations:", err instanceof Error ? err.message : err);
        return [] as AssocDef[];
      });
    assocListCache.set(client, cached);
  }
  return cached;
}

function norm(v: string | undefined | null): string {
  return String(v ?? "").trim().toLowerCase();
}

async function resolveAssociationDef(
  client: CrmClient,
  scopeA: CrmObjectScope,
  scopeB: CrmObjectScope,
): Promise<AssocDef | null> {
  const keysA = new Set(objectKeyCandidates(client, scopeA).map(norm));
  const keysB = new Set(objectKeyCandidates(client, scopeB).map(norm));
  const defs = await listAssociations(client);
  for (const d of defs) {
    const first = norm(d.firstObjectKey ?? d.firstObjectId);
    const second = norm(d.secondObjectKey ?? d.secondObjectId);
    if ((keysA.has(first) && keysB.has(second)) || (keysA.has(second) && keysB.has(first))) {
      return d;
    }
  }
  return null;
}

/**
 * Associate two records identified by scope + CRM id. Auto-detects the association
 * definition and the required first/second record order.
 */
export async function associateByScopes(
  client: CrmClient,
  scopeA: CrmObjectScope,
  aId: string,
  scopeB: CrmObjectScope,
  bId: string,
): Promise<AssociationResult> {
  const def = await resolveAssociationDef(client, scopeA, scopeB);
  if (!def?.id) {
    return {
      ok: false,
      message: `No association is defined in the CRM between ${scopeA} and ${scopeB}. Create the association in CRM → Custom Objects → Associations, then re-run.`,
    };
  }
  const keysA = new Set(objectKeyCandidates(client, scopeA).map(norm));
  const first = norm(def.firstObjectKey ?? def.firstObjectId);
  const firstIsA = keysA.has(first);
  try {
    await client.request("POST", `/associations/relations`, {
      body: {
        locationId: client.config.location_id,
        associationId: def.id,
        firstRecordId: firstIsA ? aId : bId,
        secondRecordId: firstIsA ? bId : aId,
      },
    });
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // GHL returns 400/409 when a relation already exists — treat as success.
    if (/already|exist|duplicate/i.test(message)) return { ok: true, message: "already-associated" };
    return { ok: false, message };
  }
}

/** Legacy wrapper — callers used to pass a static label as associationId. */
export async function associateRecords(
  client: CrmClient,
  firstId: string,
  secondId: string,
  associationLabel?: string,
): Promise<AssociationResult> {
  const scopes: [CrmObjectScope, CrmObjectScope] | null =
    associationLabel === "project_to_building"
      ? ["project", "building"]
      : associationLabel === "building_to_unit"
        ? ["building", "unit"]
        : null;
  if (!scopes) return { ok: false, message: `Unknown association label: ${associationLabel}` };
  return associateByScopes(client, scopes[0], firstId, scopes[1], secondId);
}
