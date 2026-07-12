/**
 * Associations: link Project ↔ Building and Building ↔ Unit.
 *
 * The GHL association API is location-scoped and stores a single record-to-record
 * relation. We attempt the current published shape; if the endpoint is unavailable
 * we return a soft failure (recorded in the report) rather than crashing.
 */
import type { CrmClient } from "./client.server";

export interface AssociationResult {
  ok: boolean;
  message?: string;
}

export async function associateRecords(
  client: CrmClient,
  firstId: string,
  secondId: string,
  associationLabel?: string,
): Promise<AssociationResult> {
  try {
    await client.request("POST", `/associations/relations`, {
      body: {
        locationId: client.config.location_id,
        firstRecordId: firstId,
        secondRecordId: secondId,
        associationId: associationLabel,
      },
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
