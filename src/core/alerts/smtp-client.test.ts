import assert from "node:assert/strict";
import { test } from "node:test";

import { __test__ } from "./smtp-client.js";

test("buildMessage renders a multipart email when attachments are provided", () => {
  const message = __test__.buildMessage({
    attachments: [
      {
        content: "hello attachment",
        contentType: "text/plain; charset=UTF-8",
        filename: "latest-qrcode.txt",
      },
    ],
    from: "bot@example.com",
    subject: "[wechat-claw][test]",
    text: "body text",
    to: ["ops@example.com"],
  });

  assert.match(message, /Content-Type: multipart\/mixed; boundary=/);
  assert.match(message, /Content-Disposition: attachment; filename="latest-qrcode.txt"/);
  assert.match(message, /Content-Transfer-Encoding: base64/);
  assert.match(message, /aGVsbG8gYXR0YWNobWVudA==/);
  assert.match(message, /body text/);
});
