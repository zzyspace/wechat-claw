import { getDatabase } from "../storage/database.js";

export interface ScenarioExtractionInput {
  rawMessageId: number;
  scenarioCode: string;
  extractorCode: string;
  status: string;
  confidence: number;
  needsReview: boolean;
  resultJson: unknown;
}

export interface ScenarioExtractionRecord {
  id: number;
  rawMessageId: number;
  scenarioCode: string;
  extractorCode: string;
  status: string;
  confidence: number;
  needsReview: boolean;
  resultJson: unknown;
  createdAt: string;
}

export function saveScenarioExtraction(input: ScenarioExtractionInput): ScenarioExtractionRecord {
  const db = getDatabase();

  const upsert = db.prepare(`
    INSERT INTO scenario_extractions (
      raw_message_id,
      scenario_code,
      extractor_code,
      status,
      confidence,
      needs_review,
      result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(raw_message_id, scenario_code)
    DO UPDATE SET
      extractor_code = excluded.extractor_code,
      status = excluded.status,
      confidence = excluded.confidence,
      needs_review = excluded.needs_review,
      result_json = excluded.result_json
  `);

  upsert.run(
    input.rawMessageId,
    input.scenarioCode,
    input.extractorCode,
    input.status,
    input.confidence,
    input.needsReview ? 1 : 0,
    JSON.stringify(input.resultJson),
  );

  const saved = db
    .prepare(`
      SELECT
        id,
        raw_message_id as rawMessageId,
        scenario_code as scenarioCode,
        extractor_code as extractorCode,
        status,
        confidence,
        needs_review as needsReview,
        result_json as resultJson,
        created_at as createdAt
      FROM scenario_extractions
      WHERE raw_message_id = ? AND scenario_code = ?
    `)
    .get(input.rawMessageId, input.scenarioCode) as
    | {
        id: number;
        rawMessageId: number;
        scenarioCode: string;
        extractorCode: string;
        status: string;
        confidence: number;
        needsReview: number;
        resultJson: string;
        createdAt: string;
      }
    | undefined;

  if (!saved) {
    throw new Error("Scenario extraction was not persisted");
  }

  return {
    ...saved,
    needsReview: Boolean(saved.needsReview),
    resultJson: JSON.parse(saved.resultJson),
  };
}

export function listScenarioExtractionsByRawMessageId(rawMessageId: number): ScenarioExtractionRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(`
      SELECT
        id,
        raw_message_id as rawMessageId,
        scenario_code as scenarioCode,
        extractor_code as extractorCode,
        status,
        confidence,
        needs_review as needsReview,
        result_json as resultJson,
        created_at as createdAt
      FROM scenario_extractions
      WHERE raw_message_id = ?
      ORDER BY id ASC
    `)
    .all(rawMessageId) as Array<{
    id: number;
    rawMessageId: number;
    scenarioCode: string;
    extractorCode: string;
    status: string;
    confidence: number;
    needsReview: number;
    resultJson: string;
    createdAt: string;
  }>;

  return rows.map((row) => ({
    ...row,
    needsReview: Boolean(row.needsReview),
    resultJson: JSON.parse(row.resultJson),
  }));
}
