import crypto from "node:crypto";

import type { StoredAttachment, StoredRawMessageInput } from "../storage/types.js";

export interface NormalizeMessageInput {
  messageExternalId: string;
  channelCode?: string;
  channelExternalId?: string;
  channelName: string;
  senderExternalId?: string;
  senderName: string;
  messageType: string;
  textContent: string;
  messageSentAt?: string;
  eventReceivedAt: string;
  attachments: StoredAttachment[];
}

function computeDedupeKey(input: NormalizeMessageInput): string {
  const hash = crypto.createHash("sha256");
  hash.update(input.messageExternalId);
  hash.update("|");
  hash.update(input.channelCode ?? "");
  hash.update("|");
  hash.update(input.channelExternalId ?? "");
  hash.update("|");
  hash.update(input.senderExternalId ?? "");
  hash.update("|");
  hash.update(input.eventReceivedAt);
  hash.update("|");
  hash.update(input.textContent);

  for (const attachment of input.attachments) {
    hash.update("|");
    hash.update(attachment.sha256);
  }

  return hash.digest("hex");
}

export function normalizeMessage(input: NormalizeMessageInput): StoredRawMessageInput {
  return {
    messageExternalId: input.messageExternalId,
    channelCode: input.channelCode,
    channelExternalId: input.channelExternalId,
    channelName: input.channelName,
    senderExternalId: input.senderExternalId,
    senderName: input.senderName,
    messageType: input.messageType,
    textContent: input.textContent,
    messageSentAt: input.messageSentAt,
    eventReceivedAt: input.eventReceivedAt,
    dedupeKey: computeDedupeKey(input),
    attachments: input.attachments,
  };
}
