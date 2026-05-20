export interface StoredAttachment {
  type: string;
  localPath: string;
  sha256: string;
  mimeType?: string;
}

export interface StoredRawMessageInput {
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
  attachments: StoredAttachment[];
}
