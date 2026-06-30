import { getAppConfig } from "../core/config/env.js";
import { createApp } from "./app.js";

const config = getAppConfig();
const app = createApp({ config });
const host = config.adminHost ?? "127.0.0.1";
const port = config.adminPort ?? 8788;

app.listen(port, host, () => {
  console.log(`wechat-claw reimbursement admin listening on http://${host}:${port}/reimbursement`);
});
