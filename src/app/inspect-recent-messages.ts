import { getDatabasePath } from "../core/storage/database.js";
import { listRecentRawMessages } from "../core/storage/raw-message-repository.js";

function main() {
  const limitArg = Number(process.argv[2] ?? "10");
  const limit = Number.isFinite(limitArg) && limitArg > 0 ? limitArg : 10;
  const messages = listRecentRawMessages(limit);

  console.log(`database=${getDatabasePath()}`);
  console.log(`messages=${messages.length}`);

  for (const message of messages) {
    console.log("----");
    console.log(`id=${message.id}`);
    console.log(`event_received_at=${message.eventReceivedAt}`);
    console.log(`channel_code=${message.channelCode ?? "(empty)"}`);
    console.log(`channel=${message.channelName}`);
    console.log(`sender=${message.senderName}`);
    console.log(`type=${message.messageType}`);
    console.log(`text=${message.textContent}`);
    console.log(`attachments=${message.attachments.length}`);

    for (const attachment of message.attachments) {
      console.log(`attachment: ${attachment.type} ${attachment.localPath}`);
    }

    for (const extraction of message.scenarioExtractions) {
      console.log(
        `scenario: ${extraction.scenarioCode} extractor=${extraction.extractorCode} status=${extraction.status} confidence=${extraction.confidence} needs_review=${extraction.needsReview}`,
      );
      console.log(`result=${JSON.stringify(extraction.resultJson)}`);
    }
  }
}

main();
