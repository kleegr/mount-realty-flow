export interface NormalizedStagePayload {
  eventId: string;
  opportunityId: string | null;
  pipelineId: string | null;
  stageId: string | null;
  pipelineName: string | null;
  stageName: string | null;
  unitCrmIdHint: string | null;
  unitExternalId: string | null;
  buildingCrmIdHint: string | null;
  buildingExternalId: string | null;
}

export function normalizeStagePayload(payload: Record<string, unknown>): NormalizedStagePayload {
  const customData = objectOrNull(payload.customData);
  const opportunity = objectOrNull(payload.opportunity);
  const pipeline = objectOrNull(payload.pipeline);
  const stage = objectOrNull(payload.stage);

  const opportunityId = firstString(
    payload.opportunity_id,
    payload.opportunityId,
    customData?.opportunity_id,
    customData?.opportunityId,
    opportunity?.id,
    payload.id,
  );
  const pipelineId = firstString(
    payload.pipeline_id,
    payload.pipelineId,
    customData?.pipeline_id,
    customData?.pipelineId,
    opportunity?.pipeline_id,
    pipeline?.id,
  );
  const stageId = firstString(
    payload.stage_id,
    payload.stageId,
    payload.pipeline_stage_id,
    payload.pipelineStageId,
    customData?.stage_id,
    customData?.stageId,
    stage?.id,
  );
  const pipelineName = firstString(
    payload.pipeline_name,
    payload.pipelineName,
    customData?.pipeline_name,
    customData?.pipelineName,
    pipeline?.name,
  );
  const stageName = firstString(
    payload.stage_name,
    payload.stageName,
    payload.pipeline_stage,
    payload.pipelineStage,
    payload.pipleline_stage,
    customData?.stage_name,
    customData?.stageName,
    customData?.pipeline_stage,
    customData?.pipelineStage,
    customData?.pipleline_stage,
    stage?.name,
  );

  return {
    eventId: firstString(payload.event_id, payload.eventId, customData?.event_id, customData?.eventId)
      ?? `${opportunityId ?? "unknown"}-${stageId ?? stageName ?? "unknown"}-${Date.now()}`,
    opportunityId,
    pipelineId,
    stageId,
    pipelineName,
    stageName,
    unitCrmIdHint: firstString(payload.unit_crm_id, payload.unitCrmId, customData?.unit_crm_id, customData?.unitCrmId),
    unitExternalId: firstString(payload.unit_external_import_id, payload.unitExternalImportId, customData?.unit_external_import_id, customData?.unitExternalImportId),
    buildingCrmIdHint: firstString(payload.building_crm_id, payload.buildingCrmId, customData?.building_crm_id, customData?.buildingCrmId),
    buildingExternalId: firstString(payload.building_external_import_id, payload.buildingExternalImportId, customData?.building_external_import_id, customData?.buildingExternalImportId),
  };
}

function objectOrNull(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}