import { getDatabase } from "./database.js";
import { listScenarioExtractionsByRawMessageId } from "../scenarios/scenario-extraction-repository.js";
import type { StoredRawMessageInput } from "./types.js";

export interface SaveRawMessageResult {
  inserted: boolean;
  rawMessageId: number;
}

export interface RecentImageMessageLookupInput {
  beforeIso: string;
  channelCode?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  sinceIso: string;
}

export interface RecentRawMessageRecord {
  id: number;
  messageExternalId: string;
  channelCode?: string;
  channelExternalId?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  messageType: string;
  textContent: string;
  eventReceivedAt: string;
  dedupeKey: string;
  ingestedAt: string;
  attachments: Array<{
    id: number;
    type: string;
    localPath: string;
    sha256: string;
    mimeType?: string;
    createdAt: string;
  }>;
  scenarioExtractions: ReturnType<typeof listScenarioExtractionsByRawMessageId>;
}

export function saveRawMessage(input: StoredRawMessageInput): SaveRawMessageResult {
  const db = getDatabase();

  const existingByMessageId = db
    .prepare("SELECT id FROM raw_messages WHERE message_external_id = ?")
    .get(input.messageExternalId) as { id: number } | undefined;

  if (existingByMessageId) {
    return {
      inserted: false,
      rawMessageId: existingByMessageId.id,
    };
  }

  const existingByDedupeKey = db
    .prepare("SELECT id FROM raw_messages WHERE dedupe_key = ?")
    .get(input.dedupeKey) as { id: number } | undefined;

  if (existingByDedupeKey) {
    return {
      inserted: false,
      rawMessageId: existingByDedupeKey.id,
    };
  }

  const insertRawMessage = db.prepare(`
    INSERT INTO raw_messages (
      message_external_id,
      channel_code,
      channel_external_id,
      channel_name,
      sender_external_id,
      sender_name,
      message_type,
      text_content,
      sent_at,
      event_received_at,
      dedupe_key
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAttachment = db.prepare(`
    INSERT INTO message_attachments (
      raw_message_id,
      attachment_type,
      local_path,
      sha256,
      mime_type
    ) VALUES (?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction(() => {
    const result = insertRawMessage.run(
      input.messageExternalId,
      input.channelCode ?? null,
      input.channelExternalId ?? null,
      input.channelName,
      input.senderExternalId ?? null,
      input.senderName,
      input.messageType,
      input.textContent,
      input.eventReceivedAt,
      input.eventReceivedAt,
      input.dedupeKey,
    );

    const rawMessageId = Number(result.lastInsertRowid);

    for (const attachment of input.attachments) {
      insertAttachment.run(
        rawMessageId,
        attachment.type,
        attachment.localPath,
        attachment.sha256,
        attachment.mimeType ?? null,
      );
    }

    return rawMessageId;
  });

  const rawMessageId = transaction();

  return {
    inserted: true,
    rawMessageId,
  };
}

export function hasRecentImageMessage(input: RecentImageMessageLookupInput): boolean {
  const db = getDatabase();

  if (input.channelCode) {
    if (input.senderExternalId) {
      const row = db
        .prepare(`
          SELECT 1
          FROM raw_messages rm
          INNER JOIN message_attachments ma ON ma.raw_message_id = rm.id
          WHERE rm.channel_code = ?
            AND rm.sender_external_id = ?
            AND rm.event_received_at >= ?
            AND rm.event_received_at < ?
          LIMIT 1
        `)
        .get(input.channelCode, input.senderExternalId, input.sinceIso, input.beforeIso);

      return Boolean(row);
    }

    const row = db
      .prepare(`
        SELECT 1
        FROM raw_messages rm
        INNER JOIN message_attachments ma ON ma.raw_message_id = rm.id
        WHERE rm.channel_code = ?
          AND rm.sender_name = ?
          AND rm.event_received_at >= ?
          AND rm.event_received_at < ?
        LIMIT 1
      `)
      .get(input.channelCode, input.senderName, input.sinceIso, input.beforeIso);

    return Boolean(row);
  }

  if (input.senderExternalId) {
    const row = db
      .prepare(`
        SELECT 1
        FROM raw_messages rm
        INNER JOIN message_attachments ma ON ma.raw_message_id = rm.id
        WHERE rm.channel_name = ?
          AND rm.sender_external_id = ?
          AND rm.event_received_at >= ?
          AND rm.event_received_at < ?
        LIMIT 1
      `)
      .get(input.channelName, input.senderExternalId, input.sinceIso, input.beforeIso);

    return Boolean(row);
  }

  const row = db
    .prepare(`
      SELECT 1
      FROM raw_messages rm
      INNER JOIN message_attachments ma ON ma.raw_message_id = rm.id
      WHERE rm.channel_name = ?
        AND rm.sender_name = ?
        AND rm.event_received_at >= ?
        AND rm.event_received_at < ?
      LIMIT 1
    `)
    .get(input.channelName, input.senderName, input.sinceIso, input.beforeIso);

  return Boolean(row);
}

export function listRecentRawMessages(limit = 10): RecentRawMessageRecord[] {
  const db = getDatabase();
  const rows = db
    .prepare(`
      SELECT
        id,
        message_external_id as messageExternalId,
        channel_code as channelCode,
        channel_external_id as channelExternalId,
        channel_name as channelName,
        sender_external_id as senderExternalId,
        sender_name as senderName,
        message_type as messageType,
        text_content as textContent,
        event_received_at as eventReceivedAt,
        dedupe_key as dedupeKey,
        ingested_at as ingestedAt
      FROM raw_messages
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
    id: number;
    messageExternalId: string;
    channelCode?: string;
    channelExternalId?: string;
    channelName: string;
    senderExternalId?: string;
    senderName: string;
    messageType: string;
    textContent: string;
    eventReceivedAt: string;
    dedupeKey: string;
    ingestedAt: string;
  }>;

  const attachmentQuery = db.prepare(`
    SELECT
      id,
      attachment_type as type,
      local_path as localPath,
      sha256,
      mime_type as mimeType,
      created_at as createdAt
    FROM message_attachments
    WHERE raw_message_id = ?
    ORDER BY id ASC
  `);

  return rows.map((row) => ({
    ...row,
    attachments: attachmentQuery.all(row.id) as RecentRawMessageRecord["attachments"],
    scenarioExtractions: listScenarioExtractionsByRawMessageId(row.id),
  }));
}
