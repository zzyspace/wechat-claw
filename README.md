# wechat-claw

一个面向微信群业务汇总的机器人骨架工程。当前阶段先跑通：

- Wechaty 启动
- 多群消息监听
- 将群消息回发给指定联系人或群
- 原始消息落 SQLite
- 图片附件落本地文件
- 将易读文本日志写入 `WECHATY_STATE_DIR/logs/`
- 进程内定时发送报损日报、周报
- 异常心跳写入 `WECHATY_STATE_DIR/watchdog.json`
- 异常时支持 SMTP 邮件告警
- 显式登录态与运行状态目录

## 当前能力

- 从环境变量读取 bot 配置
- 启动 Wechaty 实例
- 监听群消息
- 按 `room_topic` 路由多个目标群
- 将收到的消息转发给联系人或群，作为联调验证
- 将原始群消息写入 `WECHATY_STATE_DIR/wechat-claw.sqlite`
- 将图片消息落到 `WECHATY_STATE_DIR/raw/YYYY/MM/DD/`
- 对报损消息做第一版启发式结构化提取
- 监听报账群，将报账图片落到 `WECHATY_STATE_DIR/reimbursement/raw/YYYY/MM/DD/`
- 对报账图片和文字提取金额、报账人、票据日期和支出类别
- 支持按群生成报损日报文本骨架
- 支持按 channel 独立 cron 在 bot 进程内直接发送日报、周报
- 将二维码、登录态、健康状态、watchdog、文本日志统一写入 `WECHATY_STATE_DIR`
- 支持 watchdog 定时巡检、异常自愈重启和邮件告警

## 环境要求

- `Node.js 20+`
- 可用的 `Wechaty` puppet 方案

说明：

- 普通微信接入不是官方开放接口
- 你需要自己准备可用的 `puppet`
- `service` 模式需要 token，`web` 模式通常不需要
- 当前代码已预留 `WECHATY_PUPPET` 和 `WECHATY_PUPPET_SERVICE_TOKEN`

## 安装

```bash
npm install
```

## 常用命令

```bash
# 启动 bot 主进程
npm run dev

# 本地启动报账查看后台
npm run admin:dev

# 查看最近报账记录
npm run inspect:reimbursements -- --limit 20
```

## 配置

复制 `.env.example` 为 `.env`，并填写：

```env
WECHATY_PUPPET=wechaty-puppet-wechat
WECHATY_PUPPET_SERVICE_TOKEN=
WECHATY_STATE_DIR=/var/lib/wechat-claw
WECHATY_LOG_DIR=/var/lib/wechat-claw/logs
WECHATY_LOG_RETENTION_DAYS=7
WECHATY_LOG_LEVEL=info
WECHATY_ALERT_EMAIL_ENABLED=false
WECHATY_ALERT_SMTP_HOST=smtp.example.com
WECHATY_ALERT_SMTP_PORT=587
WECHATY_ALERT_SMTP_SECURE=false
WECHATY_ALERT_SMTP_USERNAME=bot@example.com
WECHATY_ALERT_SMTP_PASSWORD=
WECHATY_ALERT_EMAIL_FROM=bot@example.com
WECHATY_ALERT_EMAIL_TO=ops@example.com
WECHATY_WATCHDOG_CPU_STEP_THRESHOLD_PERCENTAGE_POINTS=10
WECHATY_WATCHDOG_CPU_STEP_MINIMUM_PERCENT=10
WECHATY_WATCHDOG_CPU_STEP_PERSISTENCE_SECONDS=60
WECHATY_TIMEZONE=Asia/Shanghai
WECHATY_DEBUG_CONTACT_NAME=你的主微信昵称
WECHATY_ADMIN_HOST=127.0.0.1
WECHATY_ADMIN_PORT=8788
WECHATY_ADMIN_USERNAME=
WECHATY_ADMIN_PASSWORD=
WECHATY_REIMBURSEMENT_ACCOUNTS_JSON='[{"accountId":"partner-001","username":"partner","password":"replace-with-a-strong-password","role":"partner"},{"accountId":"manager-001","username":"manager","password":"replace-with-another-strong-password","role":"manager","managerStores":["fuzzy","fuzzyqz"]}]'
WECHATY_ADMIN_PUBLIC_HEALTHZ_URL=https://comeover.cn/health/expense
WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED=false
WECHATY_SELF_CANARY_ENABLED=false
WECHATY_SELF_CANARY_TARGET_CONTACT_NAME=文件传输助手
WECHATY_SELF_CANARY_INTERVAL_SECONDS=1800-2700
WECHATY_SELF_CANARY_ACK_TIMEOUT_SECONDS=120
WECHATY_SELF_CANARY_FAILURE_THRESHOLD=2
WECHATY_SELF_CANARY_AUTO_RESET_ENABLED=false
WECHATY_ATTACHMENT_RETENTION_DAYS=60
WECHATY_COLD_START_IGNORE_WINDOW_SECONDS=60
WECHATY_LOSS_MERGE_WINDOW_SECONDS=60
WECHATY_REIMBURSEMENT_BACKWARD_TEXT_MERGE_WINDOW_SECONDS=3
WECHATY_LOSS_EXTRACTION_PROVIDER=
WECHATY_LOSS_EXTRACTION_MODEL=
WECHATY_LOSS_EXTRACTION_API_KEY=
WECHATY_LOSS_EXTRACTION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
WECHATY_REIMBURSEMENT_EXTRACTION_PROVIDER=openai
WECHATY_REIMBURSEMENT_EXTRACTION_MODEL=gpt-5.6-luna
WECHATY_REIMBURSEMENT_EXTRACTION_RETRY_MODEL=gpt-5.6-luna
WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY=
WECHATY_REIMBURSEMENT_EXTRACTION_BASE_URL=https://api.openai.com/v1
WECHATY_REIMBURSEMENT_OPENAI_PROXY_URL=
WECHATY_BOT_NAME=wechat-loss-bot
WECHATY_CHANNELS_JSON=[{"code":"loss_a","enabled":true,"scenario":"loss-report","match":{"type":"room_topic","value":"门店食材报损群A"},"deliveryTargets":[{"type":"contact_name","value":"你的主微信昵称"},{"type":"room_topic","value":"门店A日报群"}],"summarySchedule":"0 22 * * *","weeklySummarySchedule":"10 22 * * 0"},{"code":"reimbursement_a","enabled":true,"scenario":"reimbursement","match":{"type":"room_topic","value":"门店报账群A"},"deliveryTargets":[],"summarySchedule":""}]
```

字段说明：

- `WECHATY_PUPPET`: 具体接入方案名称
- `WECHATY_PUPPET_SERVICE_TOKEN`: 仅 `wechaty-puppet-service` 等 service 模式需要
- `WECHATY_STATE_DIR`: 统一状态目录，包含 SQLite、附件、二维码、health、watchdog、memory-card、logs
- `WECHATY_LOG_DIR`: 文本日志目录，默认 `${WECHATY_STATE_DIR}/logs`
- `WECHATY_LOG_RETENTION_DAYS`: 文本日志保留天数，默认 `7` 天；会清理更早的 `app-YYYY-MM-DD.log` 和 `error-YYYY-MM-DD.log`
- `WECHATY_LOG_LEVEL`: 日志级别，支持 `debug / info / warn / error`，默认 `info`
- `WECHATY_DEBUG_MESSAGE_SNAPSHOT_ENABLED`: 是否记录完整的 wechaty 原始消息快照，默认 `false`；生产环境建议关闭
- `WECHATY_ALERT_EMAIL_ENABLED`: 是否启用异常邮件告警，默认 `false`
- `WECHATY_ALERT_SMTP_HOST/PORT/SECURE`: SMTP 服务器配置
- `WECHATY_ALERT_SMTP_USERNAME/PASSWORD`: SMTP 登录凭据
- `WECHATY_ALERT_EMAIL_FROM`: 告警发件人邮箱
- `WECHATY_ALERT_EMAIL_TO`: 告警收件人邮箱，支持多个，用逗号分隔
- `WECHATY_WATCHDOG_MEMORY_LIMIT_MB`: watchdog 内存阈值，单位 MiB，默认 `0`（关闭）
- `WECHATY_WATCHDOG_MEMORY_PERSISTENCE_SECONDS`: 内存阈值持续多久才触发重启，单位秒，默认 `300`
- `WECHATY_WATCHDOG_CPU_STEP_THRESHOLD_PERCENTAGE_POINTS`: 整台 Linux 主机 CPU 相对近期基线上升多少个百分点算阶跃，默认 `10`；设为 `0` 可关闭
- `WECHATY_WATCHDOG_CPU_STEP_MINIMUM_PERCENT`: 阶跃后的 CPU 使用率下限，默认 `10%`，用于过滤低负载噪声
- `WECHATY_WATCHDOG_CPU_STEP_PERSISTENCE_SECONDS`: 阶跃持续多久才发邮件，默认 `60` 秒；CPU 告警只发邮件，不自动重启服务
- `WECHATY_SELF_CANARY_ENABLED`: 是否启用“文件传输助手”自检 canary，默认 `false`
- `WECHATY_SELF_CANARY_TARGET_CONTACT_NAME`: 自检发送目标联系人，建议先用 `文件传输助手`
- `WECHATY_SELF_CANARY_INTERVAL_SECONDS`: 自检发送间隔，单位秒；支持单值 `1800`，也支持范围 `1800-2700`，默认 `1800`
- `WECHATY_SELF_CANARY_ACK_TIMEOUT_SECONDS`: 发送后等待 self message 回流的超时时间，单位秒，默认 `120`
- `WECHATY_SELF_CANARY_FAILURE_THRESHOLD`: 连续失败多少次才算 canary 故障，默认 `2`
- `WECHATY_SELF_CANARY_AUTO_RESET_ENABLED`: 连续失败达到阈值后，是否自动备份并停用 `memory-card` 后触发 fresh login，默认 `false`
- `WECHATY_ROOM_CANARY_ENABLED`: 是否启用群消息链路自检 canary，默认 `false`
- `WECHATY_ROOM_CANARY_TARGET_ROOM_TOPIC`: 群自检发送目标群名，建议使用低打扰测试群
- `WECHATY_ROOM_CANARY_INTERVAL_SECONDS`: 群自检发送间隔，单位秒；支持单值 `600` 或范围 `600-1200`，默认 `1800`
- `WECHATY_ROOM_CANARY_ACK_TIMEOUT_SECONDS`: 发送后等待自身群消息回流的超时时间，单位秒，默认 `120`
- `WECHATY_ROOM_CANARY_FAILURE_THRESHOLD`: 连续失败多少次才判断群消息监听卡住，默认 `2`
- `WECHATY_ROOM_CANARY_AUTO_RESTART_ENABLED`: 连续失败达到阈值后是否自动重启 `wechat-claw`，默认 `false`
- `WECHATY_TIMEZONE`: 日期边界和 cron 解释时区，默认 `Asia/Shanghai`
- `WECHATY_DEBUG_CONTACT_NAME`: `"[wechat-claw]"` 调试信息的接收联系人，不参与业务日报发送；上线通知始终走这里
- `WECHATY_MANUAL_REIMBURSEMENT_CONTACT_NAME`: 允许通过私聊或报账群发送“补录报账”结构化命令的联系人昵称；未配置时该能力关闭
- `WECHATY_ADMIN_HOST`: 报账后台监听地址，默认 `127.0.0.1`
- `WECHATY_ADMIN_PORT`: 报账后台监听端口，默认 `8788`
- `WECHATY_ADMIN_USERNAME/WECHATY_ADMIN_PASSWORD`: 报账后台 Basic Auth 账号密码；未配置时 `/expense` 会返回 `503`
- `WECHATY_REIMBURSEMENT_ACCOUNTS_JSON`: 合伙人和店长账号数组；每个账号需要稳定的 `accountId`。`partner` 可提交基础门店并只读查看全部报账；`manager` 可配置一个或多个 `managerStores`，只能提交并查看该账号自己的店长报账
- `WECHATY_REIMBURSEMENT_SHORTCUT_API_TOKEN`: 快捷指令单图报账接口的独立 Bearer Token；未配置时该接口返回 `503`
- `WECHATY_ADMIN_PUBLIC_HEALTHZ_URL`: 仅 deploy 脚本使用；应用发布后校验由 `server-infra` 管理的公网入口，默认 `https://comeover.cn/health/expense`
- `WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED`: 是否发送 `"[wechat-claw] 已收到群消息"` 这类调试摘要，默认 `false`
- `WECHATY_SUPPRESS_ROOM_TEXT_DELIVERY`: 临时禁止 bot 向任何群聊发送文字，默认 `false`；开启后私聊和后台处理不受影响，群消息链路自检会暂时停用
- `WECHATY_CHANNELS_JSON`: 推荐的多群配置入口，支持 `loss-report` 和 `reimbursement` 场景
- `WECHATY_ATTACHMENT_RETENTION_DAYS`: 普通原始图片附件保留天数，默认 `60` 天；只清理 `raw/` 下更早的历史目录，设为 `0` 可关闭。报账附件目录 `reimbursement/raw/` 永久保留，不参与自动清理
- `WECHATY_COLD_START_IGNORE_WINDOW_SECONDS`: 冷启动忽略窗口，默认 `60` 秒；会忽略发送时间早于“bot 启动时间 - 窗口”的历史消息，设为 `0` 可关闭
- `WECHATY_SUMMARY_PROMPT_TEMPLATE`: 总结提示词模板，可自定义
- `WECHATY_LOSS_MERGE_WINDOW_SECONDS`: 同一人图文消息合并窗口，默认 `60` 秒；报损和报账第一版共用这个窗口
- `WECHATY_REIMBURSEMENT_BACKWARD_TEXT_MERGE_WINDOW_SECONDS`: 报账图片向前回看文字的窗口，默认 `3` 秒；同时影响“文字后图片”的回看合并和“图1 + 文字 + 图2”时文字改挂到图2的判断，设为 `0` 可关闭
  当前规则：
  - 报损图 + 文字：窗口内可合并为一条报损
  - 报账图片后文字：窗口内可作为备注合并到同一份报账
  - 报账文字后图片：仅回看前 `WECHATY_REIMBURSEMENT_BACKWARD_TEXT_MERGE_WINDOW_SECONDS` 秒内的同人文字并合并到同一份报账
  - 报账图1 + 文字 + 图2：如果图2与中间这条文字间隔在 `WECHATY_REIMBURSEMENT_BACKWARD_TEXT_MERGE_WINDOW_SECONDS` 秒内，这条文字会从图1对应报账改挂到图2对应报账
  - 图 + 图：不合并
  - 一条业务记录最多保留一张图片
- `WECHATY_LOSS_EXTRACTION_PROVIDER`: 报损提取模型提供商
- `WECHATY_LOSS_EXTRACTION_MODEL`: 报损提取模型名
- `WECHATY_LOSS_EXTRACTION_API_KEY`: 报损提取模型 API Key
- `WECHATY_LOSS_EXTRACTION_BASE_URL`: 报损提取模型接口地址
- `WECHATY_REIMBURSEMENT_EXTRACTION_PROVIDER`: 报账提取模型提供商，支持 `openai / qwen`，默认 `openai`
- `WECHATY_REIMBURSEMENT_EXTRACTION_MODEL`: 报账图片识别模型名；OpenAI 默认 `gpt-5.6-luna`，Qwen 默认 `qwen3.5-flash`
- `WECHATY_REIMBURSEMENT_EXTRACTION_RETRY_MODEL`: 报账模型首轮返回空结构化结果时的重试模型；OpenAI 默认继续使用 `gpt-5.6-luna`，Qwen 默认切换到 `qwen3.5-plus`
- `WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY`: 当前 provider 对应的 API Key
- `WECHATY_REIMBURSEMENT_EXTRACTION_BASE_URL`: 报账提取接口地址；OpenAI 使用 `https://api.openai.com/v1`，Qwen 使用 `https://dashscope.aliyuncs.com/compatible-mode/v1`
- `WECHATY_REIMBURSEMENT_OPENAI_PROXY_URL`: 仅 OpenAI 报账识别请求使用的 HTTP/HTTPS 代理；例如 `http://127.0.0.1:7890`，Qwen 和其他请求保持直连

报账识别可以只通过环境变量在 OpenAI 与 Qwen 之间切换；修改后重启服务即可，不需要再次改代码。切回 Qwen 时使用：

```env
WECHATY_REIMBURSEMENT_EXTRACTION_PROVIDER=qwen
WECHATY_REIMBURSEMENT_EXTRACTION_MODEL=qwen3.5-flash
WECHATY_REIMBURSEMENT_EXTRACTION_RETRY_MODEL=qwen3.5-plus
WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY=<百炼 / DashScope API Key>
WECHATY_REIMBURSEMENT_EXTRACTION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

切回 Qwen 时可以保留 `WECHATY_REIMBURSEMENT_OPENAI_PROXY_URL`；代码只会在 provider 为 `openai` 时使用它。

- `WECHATY_BOT_NAME`: 本地 bot 名称
- `WECHATY_SUMMARY_CRON`: 仅旧版单群兼容配置使用的默认日报周期

`WECHATY_CHANNELS_JSON` 的结构：

```json
[
  {
    "code": "loss_a",
    "enabled": true,
    "scenario": "loss-report",
    "match": { "type": "room_topic", "value": "门店食材报损群A" },
    "deliveryTargets": [
      { "type": "contact_name", "value": "你的主微信昵称" },
      { "type": "room_topic", "value": "门店A日报群" }
    ],
    "summarySchedule": "0 22 * * *",
    "weeklySummarySchedule": "10 22 * * 0"
  },
  {
    "code": "reimbursement_a",
    "enabled": true,
    "scenario": "reimbursement",
    "match": { "type": "room_topic", "value": "门店报账群A" },
    "deliveryTargets": [],
    "summarySchedule": ""
  }
]
```

说明：

- `summarySchedule`: 日报 cron，例如每天 `22:00` 用 `0 22 * * *`
- `weeklySummarySchedule`: 周报 cron，例如每周日 `22:10` 用 `10 22 * * 0`
- `summarySchedule` 或 `weeklySummarySchedule` 留空 `""`，表示关闭对应的自动发送
- 报账群可以不配置发送目标；但若要发送“报账xx元已录入(分类: 中文类目) / 此次报账待核验”回执，需要在 `deliveryTargets` 中配置目标，可直接填写当前报账群的 `room_topic`
- 当 bot 在报账群发送“报账xx元已录入(分类: 中文类目)”或“此次报账待核验”后，可以直接回复这条回执做人工修正：
  - 回复 `delete`：删除对应报账记录
  - 回复纯数字（支持负数）：将对应报账金额改为该数字，并把 `needs_review` 更新为 `false`
  - 回复 `分类: x` 或 `category: x`：将对应报账的 `expense_category` 改为 `x`
  - 当前 `x` 支持 `food / flower / salary / rent / utilities / manager_reimbursement / planned_expense / other / 食材 / 花 / 花卉 / 工资 / 薪资 / 房租 / 租金 / 水电 / 水电费 / 电费 / 水费 / 店长报账 / 店长 / 预报账 / 其他 / 其它`；回执展示会统一使用中文 label
  - 后续新增类目时，只需要扩展 `src/scenarios/reimbursement/categories.ts`
  - 回复 `note: xxx` 或 `note：xxx`：将 `xxx` 追加到对应报账备注
  - 回复精确的 `x月账`：把这条回复作为备注挂到对应报账，并按现有“月账回填创建时间”逻辑把 `created_at` 回填到对应月份月底 `00:00:00`
  - 指令执行成功后，bot 会回复 `已处理`
  - 指令格式正确但没找到对应报账时，bot 会回复 `未找到对应报账`
  - 指令不支持时，bot 会回复 `不支持的指令`
- 如果配置了 `WECHATY_MANUAL_REIMBURSEMENT_CONTACT_NAME`，该联系人可以通过私聊或报账群发送固定结构化命令手工补录报账；成功后 bot 会在命令所在私聊或群聊回复 `已处理`
  - 固定格式如下：
    ```text
    补录报账
    channel_code: reimbursement_fuzzy
    reporter: 张三
    amount: 36.5
    category: 食材
    note: 午餐报账
    sent_at: 2026-07-02T14:32:00+08:00
    ```
  - 必填字段：`channel_code`、`reporter`、`amount`、`category`
  - 可选字段：`note`、`sent_at`
  - 在报账群中发送时，`channel_code` 可省略并自动使用当前群的 channel code；如果显式填写，则必须与当前群一致
  - 支持中英文键名和中英文冒号，例如 `群聊代码：reimbursement_fuzzy`、`报账人：张三`、`金额：36.5`、`分类：食材`
- 也就是说：
  - `summarySchedule` 留空时，不会自动发送日报
  - `weeklySummarySchedule` 留空时，不会自动发送周报

兼容说明：

- 未配置 `WECHATY_CHANNELS_JSON` 时，会回退到旧版 `WECHATY_TARGET_ROOM_TOPIC` + `WECHATY_DELIVERY_CONTACT_NAME`
- 旧版回退只会生成一个默认 channel
- 新增多群时，优先改 `WECHATY_CHANNELS_JSON`

推荐先试两种模式中的一种：

`Web` 模式：

```env
WECHATY_PUPPET=wechaty-puppet-wechat
WECHATY_PUPPET_SERVICE_TOKEN=
WECHATY_PUPPET_WECHAT_PUPPETEER_UOS=1
WECHATY_BOT_NAME=wechat-loss-bot
WECHATY_STATE_DIR=/private/tmp/wechat-claw-state
WECHATY_TIMEZONE=Asia/Shanghai
WECHATY_DEBUG_CONTACT_NAME=你的主微信昵称
WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED=false
WECHATY_CHANNELS_JSON=[{"code":"loss_test","enabled":true,"scenario":"loss-report","match":{"type":"room_topic","value":"AI测试群"},"deliveryTargets":[{"type":"contact_name","value":"你的主微信昵称"},{"type":"room_topic","value":"AI测试日报群"}],"summarySchedule":"0 22 * * *"}]
```

说明：

- `WECHATY_PUPPET_WECHAT_PUPPETEER_UOS=1` 建议在 `web` 模式下默认开启
- 这可以让 `wechaty-puppet-wechat` 走 UOS 兼容分支，当前在你的机器上比直接访问 `https://wx.qq.com` 更稳定

`Service` 模式：

```env
WECHATY_PUPPET=wechaty-puppet-service
WECHATY_PUPPET_SERVICE_TOKEN=puppet_paimon_xxx
WECHATY_BOT_NAME=wechat-loss-bot
WECHATY_STATE_DIR=/private/tmp/wechat-claw-state
WECHATY_TIMEZONE=Asia/Shanghai
WECHATY_DEBUG_CONTACT_NAME=你的主微信昵称
WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED=false
WECHATY_CHANNELS_JSON=[{"code":"loss_test","enabled":true,"scenario":"loss-report","match":{"type":"room_topic","value":"AI测试群"},"deliveryTargets":[{"type":"contact_name","value":"你的主微信昵称"}],"summarySchedule":"0 22 * * *"}]
```

建议：

- `WECHATY_CHANNELS_JSON` 先只配 1 个测试 channel 跑通，再扩到 2 个或更多
- `match.value` 和 `room_topic` 类型的发送目标都必须和微信群当前显示名称完全一致
- 当前 bot 登录的微信号建议使用专门测试号

## 运行

先做环境自检：

```bash
npm run doctor
```

如果你是在本机开发，而不是 Linux 服务器，建议先显式指定一个可写目录：

```bash
WECHATY_STATE_DIR=/private/tmp/wechat-claw-state npm run doctor
```

预期：

- 输出当前配置摘要
- `State directory check passed`
- `Summary cron check passed`
- 缺少必要配置时直接报错退出
- `Wechaty module check passed`
- `Puppet runtime check passed`
- `Doctor check passed`

开发模式：

```bash
npm run dev
```

构建：

```bash
npm run build
```

查看最近消息：

```bash
npm run inspect:messages
```

查看已入库的报账信息：

```bash
npm run inspect:reimbursements
```

手工补录一条报账：

```bash
npm run reimbursement:manual-import -- --channel-code reimbursement_fuzzy --reporter 张三 --amount 36.5 --category 食材 --note 午餐报账 --sent-at 2026-07-02T14:32:00+08:00
```

通过私聊补录一条报账：

```text
补录报账
channel_code: reimbursement_fuzzy
reporter: 张三
amount: 36.5
category: 食材
note: 午餐报账
sent_at: 2026-07-02T14:32:00+08:00
```

在报账群内补录时可以省略 `channel_code`：

```text
补录报账
reporter: 张三
amount: 36.5
category: 食材
note: 午餐报账
sent_at: 2026-07-02T14:32:00+08:00
```

微信补录说明：

- 需要先配置 `WECHATY_MANUAL_REIMBURSEMENT_CONTACT_NAME=你的微信昵称`
- 只有这个联系人发来的私聊或报账群消息会触发补录；其他联系人发送的同类命令会被忽略
- 第一行必须精确写 `补录报账`
- 私聊必填字段：`channel_code`、`reporter`、`amount`、`category`
- 报账群必填字段：`reporter`、`amount`、`category`；`channel_code` 可省略，显式填写时必须与当前群一致
- 可选字段：`note`、`sent_at`
- `channel_code` 必须是当前 `WECHATY_CHANNELS_JSON` 里已存在且 `scenario=reimbursement` 的 channel code
- `category` 必须是现有报账类别或别名，例如 `food / flower / salary / rent / utilities / manager_reimbursement / planned_expense / other / 食材 / 花 / 花卉 / 工资 / 房租 / 水电 / 店长报账 / 预报账 / 其他`
- `sent_at` 建议使用带时区的 ISO 时间，例如 `2026-07-02T14:32:00+08:00`；不传时默认使用收到这条微信命令的时间
- 补录成功后，bot 会在命令所在私聊或群聊回复 `已处理`
- 如果字段格式不对，例如金额不是数字、类别不存在、缺少必填字段，bot 会回复格式示例
- 如果 `channel_code` 不存在，或该 channel 不是报账 channel，bot 会回复 `不支持的指令`

常用筛选：

```bash
npm run inspect:reimbursements -- --limit 20
npm run inspect:reimbursements -- --channel reimbursement_a
```

说明：

- 每份报账会按一个区块打印，包含金额、类别、票据日期、备注、OCR 文本、是否需要复核
- 同时会展开来源 raw message 明细，方便排查“图片 + 文字”是否合并正确
- 没有报账数据时会打印 `status=empty`

启动报账查看后台：

```bash
npm run admin:dev
```

访问路径：

- 页面：`/expense`
- 统一批量报账入口：`/expense/submit`
- 健康检查：`/health/expense`
- 列表接口：`/expense/api/reports`
- 快捷指令单图报账接口：`POST /expense/api/shortcut/reports`

说明：

- 后台默认监听 `127.0.0.1:8788`
- 建议只开放给本机，由 Nginx 反代到外网
- `/expense` 使用 Basic Auth；未配置 `WECHATY_ADMIN_USERNAME/WECHATY_ADMIN_PASSWORD` 时会返回 `503`
- `/expense/submit` 是唯一统一报账入口；服务端按 `admin`、`partner`、`manager` 角色返回并校验可提交门店
- `WECHATY_ADMIN_GUEST_USERNAME/WECHATY_ADMIN_GUEST_PASSWORD` 已废弃且不会授予登录权限
- 店长报账以不可编辑的 `submitted_by_account_id` 记录账号所有权；同门店的不同店长互不可见，历史微信群报账因没有该字段暂不向店长展示
- 修改管理员或角色账号配置后，执行 `sudo systemctl restart wechat-claw-reimbursement-admin.service admin-auth-gateway.service` 使新配置生效
- 快捷指令接口使用独立 Bearer Token，不接受后台 Basic Auth；请求体为 `multipart/form-data`，包含 `image`、`note`、`channelCode`、`reporter`，并要求 8 至 256 个可打印 ASCII 字符的 `Idempotency-Key` 请求头
- 快捷指令接口会同步调用现有报账模型并写入正式报账链路；成功响应中的 `receipt` 可直接交给“显示结果”动作
- `deploy/deploy-wechat-claw.sh` 现在会自动：
  - 安装 [deploy/wechat-claw-reimbursement-admin.service](/Users/ryan/DataDisk/Work/AI/wechat-claw/deploy/wechat-claw-reimbursement-admin.service)
  - 重启并校验 `127.0.0.1:8788/health/expense`
  - 校验 `WECHATY_ADMIN_PUBLIC_HEALTHZ_URL`
- [deploy/nginx/reimbursement-admin.locations.conf](/Users/ryan/DataDisk/Work/AI/wechat-claw/deploy/nginx/reimbursement-admin.locations.conf) 是迁移前兼容快照；生产 Nginx 路由由独立的 `server-infra` 项目统一发布。业务部署不会写入或 reload Nginx。

手工执行一次 watchdog 巡检：

```bash
npm run watchdog:check
```

生成报损日报：

```bash
npm run summary:loss
```

只打印汇总，不做发送：

```bash
npm run summary:print -- --type daily --date 2026-05-20
npm run summary:print -- --type weekly --date 2026-05-24
```

也可以用快捷命令：

```bash
npm run summary:print:daily -- --channel loss_a --date 2026-05-20
npm run summary:print:weekly -- --channel loss_a --date 2026-05-24
```

说明：

- `summary:print` 只在终端打印日报或周报文本，不会发送到微信
- `--type` 可选 `daily` 或 `weekly`，默认 `daily`
- 不传 `--channel` 时，会打印所有启用中的 `loss-report` channel

命令行立即触发日报发送：

```bash
npm run summary:send -- --channel loss_a
```

如果只有一个启用中的 `loss-report` channel，也可以省略 `--channel`。

生成最近 N 分钟报损汇总：

```bash
npm run summary:loss:recent
```

例如看最近 10 分钟：

```bash
npm run summary:loss:recent 10
```

发送指定日期日报：

```bash
npm run summary:send -- --channel loss_a --date 2026-05-20
```

命令行立即触发周报发送：

```bash
npm run summary:send -- --channel loss_a --type weekly --date 2026-05-24
```

说明：

- `--type` 可选 `daily` 或 `weekly`，默认 `daily`
- 当 `--type weekly` 时，`--date` 表示“该日期所在周”，最终会汇总该周的周一到周日

一次触发所有启用中的报损 channel：

```bash
npm run summary:send -- --all
```

只入队、不等待发送完成：

```bash
npm run summary:send -- --channel loss_a --wait-seconds 0
```

生产运行：

```bash
npm start
```

说明：

- `summary:send` 不会自己再启动一个新的 Wechaty 发送进程
- 它会把“手动发送日报/周报”的请求写入 SQLite，由当前正在运行的 `npm run dev` 或 `npm start` 进程消费并发送
- 所以这条命令最好在 bot 常驻进程已经在线、且登录状态正常时使用
- 如果命令超时但请求已经入队，常驻 bot 后续恢复后仍会继续处理
- 在服务器上手工执行时，会优先读当前目录 `.env`，如果没有，再自动读取 `/etc/wechat-claw.env`

## 本地联调步骤

1. 准备一个机器人微信号，并把它拉进目标报损群。
2. 确保你的主微信号和机器人号互为联系人。
3. 填好 `.env` 中的关键字段：
   - `WECHATY_PUPPET`
   - `WECHATY_PUPPET_SERVICE_TOKEN`
   - `WECHATY_DEBUG_CONTACT_NAME`
   - `WECHATY_CHANNELS_JSON`
   如果你试的是 `wechaty-puppet-wechat`，`WECHATY_PUPPET_SERVICE_TOKEN` 留空即可。
   同时建议增加：
   - `WECHATY_PUPPET_WECHAT_PUPPETEER_UOS=1`
4. 执行 `npm run doctor`，确认配置检查通过。
5. 执行 `npm run dev`。
6. 观察终端：
   - 若支持终端二维码，会直接显示二维码
   - 否则日志里会打印二维码链接
   - 同时程序会写入 `WECHATY_STATE_DIR/latest-qrcode.txt`
7. 用机器人微信号扫码登录。
8. 登录成功后，程序会向 `WECHATY_DEBUG_CONTACT_NAME` 发送一条 bot 上线通知。
9. 在目标群里发一条测试消息。
10. 程序应将该消息摘要再次发给 `WECHATY_DEBUG_CONTACT_NAME`。

## 联调通过标准

满足以下 3 条就说明接入链路通了：

1. 机器人账号成功登录
2. 你的主微信收到 bot 上线通知
3. 目标群发消息后，你的主微信收到消息摘要

如果要额外验证存储链路，再检查：

- `WECHATY_STATE_DIR/wechat-claw.sqlite`
- `WECHATY_STATE_DIR/logs`
- `WECHATY_STATE_DIR/raw`
- `npm run inspect:messages`
- `npm run inspect:reimbursements`
- `npm run logs:recent`
- `npm run summary:loss`
- `npm run summary:loss:recent 10`

## 二维码文件

每次出现登录二维码时，程序都会刷新这个文件：

- `WECHATY_STATE_DIR/latest-qrcode.txt`

文件里包含：

- 二维码链接
- ASCII 终端二维码

如果你看不到终端实时输出，直接打开这个文件即可。

## 健康状态文件

每次启动后，程序都会维护：

- `WECHATY_STATE_DIR/health.json`

当前字段包括：

- `status`
- `pid`
- `botName`
- `puppet`
- `startedAt`
- `lastScanAt`
- `lastLoginAt`
- `lastMessageAt`
- `lastSummaryAt`
- `lastError`

## Watchdog 状态文件

程序还会维护：

- `WECHATY_STATE_DIR/watchdog.json`
- `WECHATY_STATE_DIR/watchdog-state.json`

用途：

- `watchdog.json` 记录进程心跳、最近健康状态和关键时间戳
- `watchdog-state.json` 记录最近巡检时间、邮件去重窗口和自动重启节流窗口

## Self Canary 状态文件

如果启用了“文件传输助手”自检 canary，程序还会维护：

- `WECHATY_STATE_DIR/self-canary.json`

用途：

- 记录最近一次 canary 发送时间、token、回流确认时间

## Room Canary 状态文件

如果启用了群消息链路自检 canary，程序还会维护：

- `WECHATY_STATE_DIR/room-canary.json`

用途：

- 记录最近一次群 canary 发送时间、token、回流确认时间和连续失败次数
- 记录连续失败次数、最近失败原因
- 如果启用了自动恢复，还会记录最近一次请求 fresh login reset 的时间

## 文本日志

程序会同时输出到：

- 终端 / `journalctl`
- `WECHATY_STATE_DIR/logs/app-YYYY-MM-DD.log`
- `WECHATY_STATE_DIR/logs/error-YYYY-MM-DD.log`

日志特点：

- 默认是易读文本格式，不再是 JSON 行
- 每天自动切一个文件
- 启动时和每天后台任务都会清理 7 天前日志
- `error` 会额外写入当天 `error-YYYY-MM-DD.log`

常用查看方式：

```bash
tail -f /var/lib/wechat-claw/logs/app-$(date +%F).log
tail -f /var/lib/wechat-claw/logs/error-$(date +%F).log
journalctl -u wechat-claw -f -o short-iso
npm run logs:recent
npm run logs:recent -- --errors
npm run logs:recent -- --date 2026-05-21 --grep login
```

## 异常处理

当前异常处理链路：

- `systemd` 负责“进程退出后”自动拉起 `wechat-claw.service`
- `watchdog timer` 每分钟执行一次 `npm run watchdog:check`
- `daily restart timer` 每天 `05:00`（固定按 `Asia/Shanghai`）执行一次 `systemctl restart wechat-claw`
- watchdog 会读取 `health.json` 和 `watchdog.json`
- 对持续异常或心跳停滞执行自动重启
- 对需要人工处理的情况发送邮件但不重启
- 如果启用 room canary，watchdog 还会读取 `room-canary.json`

默认会处理的情况：

- 主服务不在 `active` 状态
- `health.status=degraded` 持续超过阈值
- bot 已登出
- room canary 连续失败或 ack 超时，说明群消息监听可能卡住
- `watchdog.json` 心跳长时间不更新
- `waiting_for_scan` 持续过久

常用排障命令：

```bash
systemctl status wechat-claw
systemctl status wechat-claw-watchdog.timer
systemctl status wechat-claw-daily-restart.timer
journalctl -u wechat-claw -f -o short-iso
journalctl -u wechat-claw-watchdog.service -f -o short-iso
journalctl -u wechat-claw-daily-restart.service -f -o short-iso
cat /var/lib/wechat-claw/health.json
cat /var/lib/wechat-claw/watchdog.json
cat /var/lib/wechat-claw/watchdog-state.json
cat /var/lib/wechat-claw/room-canary.json
tail -f /var/lib/wechat-claw/logs/app-$(date +%F).log
tail -f /var/lib/wechat-claw/logs/error-$(date +%F).log
```

人工恢复策略：

- 如果服务已退出：优先看 `systemctl status wechat-claw`
- 如果服务在线但登录失效：查看 `latest-qrcode.txt`，重新扫码
- 如果进入 `degraded` 且长期不恢复：执行 `sudo systemctl restart wechat-claw`
- 如果服务显示 `logged_in` 但长期收不到新消息、`lastMessageAt` 不再更新：执行 `sudo bash deploy/reset-wechat-session.sh`
- 如果怀疑 SQLite 业务数据异常：执行 `sudo bash deploy/clear-wechat-claw-db.sh`

## Linux 单机部署

推荐目标：

- `Ubuntu 22.04/24.04 x86_64`
- `Node.js 20`
- `systemd`
- 不使用 Docker

建议目录约定：

- 代码目录：`/opt/wechat-claw/current`
- 状态目录：`/var/lib/wechat-claw`
- 环境变量文件：`/etc/wechat-claw.env`
- systemd 服务：`deploy/wechat-claw.service`

部署步骤：

```bash
git clone <your-repo> /opt/wechat-claw/current
cd /opt/wechat-claw/current
npm ci
npm run build
sudo systemctl restart wechat-claw
```

如果服务器已经完成这次初始化，而你这次没有改本地 `.env`，可以直接用：

```bash
cd /opt/wechat-claw/current
sudo bash deploy/deploy-wechat-claw.sh
```

这个命令会执行：

- `git pull --ff-only origin main`
- 安装最新的 `systemd` service 文件
- 安装最新的 watchdog `service/timer` 文件
- 安装最新的每日重启 `service/timer` 文件
- 安装 `needrestart` 豁免，避免系统自动升级时重启 bot
- `systemctl daemon-reload`
- 仅当当前 `package-lock.json` 和已安装依赖树不一致时执行 `npm ci --include=dev`
- `npm run build`
- `npm run doctor`
- `systemctl restart wechat-claw`
- `systemctl enable --now wechat-claw-watchdog.timer`
- `systemctl enable --now wechat-claw-daily-restart.timer`

如果你想降低“忘记同步服务器配置”的风险，推荐以后统一只用这一条本地发布命令：

```bash
deploy/release-wechat-claw.sh root@139.196.140.215
```

这条命令会固定执行：

- 同步本地 `.env` 到服务器 `/etc/wechat-claw.env`
- 自动补齐服务器专用字段
- 触发远程 `git pull + 条件式 npm ci + build + doctor + restart`

说明：

- `deploy-wechat-claw` 会直接比对当前锁文件和已安装依赖树，不依赖 `node_modules/.package-lock.json` 这类额外文件
- 如果 `node_modules` 已经和当前 `package-lock.json` 一致，就会跳过 `npm ci`，避免每次发布都重新下载 `puppeteer` 一类的大包
- 即使需要重新执行 `npm ci`，脚本也会复用 `/opt/wechat-claw/current/.cache/puppeteer` 里的浏览器缓存，避免反复下载 Chromium
- `deploy/sync-wechat-claw-env.sh --deploy` 会直接执行仓库里的 `deploy/deploy-wechat-claw.sh`，避免服务器 PATH 里的旧版 `deploy-wechat-claw` 副本绕过最新逻辑

如果你本地改了 `.env`，但这次只想同步配置、不发布代码，才单独使用：

```bash
deploy/sync-wechat-claw-env.sh root@139.196.140.215
```

这个脚本会：

- 读取本地 `.env`
- 自动补齐服务器专用字段：
  - `WECHATY_STATE_DIR=/var/lib/wechat-claw`
  - `WECHATY_TIMEZONE=Asia/Shanghai`
- 自动把 `WECHATY_SUMMARY_CRON` 转成服务器更稳的带引号形式
- 安装到服务器 `/etc/wechat-claw.env`

如果你更喜欢保留原来的细分命令，也可以显式写成：

```bash
deploy/sync-wechat-claw-env.sh --deploy root@139.196.140.215
```

如果你后续只改了服务器上的 `/etc/wechat-claw.env`，不需要重新部署代码，但需要重启服务才能生效：

```bash
sudo systemctl restart wechat-claw
```

如果你只是想在服务器上方便地改 `WECHATY_CHANNELS_JSON`，可以直接执行：

```bash
cd /opt/wechat-claw/current
EDITOR=vim sudo bash deploy/edit-wechat-claw-channels-json.sh
```

这个脚本会：

- 从 `/etc/wechat-claw.env` 提取 `WECHATY_CHANNELS_JSON`
- 自动格式化成更容易编辑的多行 JSON
- 保存前校验它仍然是合法的 JSON 数组
- 回写成 env 里的单行字符串，并自动备份原文件

改完后仍然需要重启服务：

```bash
sudo systemctl restart wechat-claw
```

原因：

- `wechat-claw` 只在进程启动时读取 `/etc/wechat-claw.env`
- 直接修改 env 文件不会让正在运行的进程自动重新加载配置

可以按下面规则判断：

- 只改 `/etc/wechat-claw.env`：执行 `sudo systemctl restart wechat-claw`
- 改了代码：执行 `cd /opt/wechat-claw/current && sudo bash deploy/deploy-wechat-claw.sh`
- 改了代码和 `/etc/wechat-claw.env`：直接执行 `cd /opt/wechat-claw/current && sudo bash deploy/deploy-wechat-claw.sh`

如果你要在服务器上“清空报损数据库里的所有数据，但保留数据库文件和表结构”，可以直接执行：

```bash
cd /opt/wechat-claw/current
sudo bash deploy/clear-wechat-claw-db.sh
```

这个脚本会按顺序执行：

- 停掉 `wechat-claw` 服务
- 从 `/etc/wechat-claw.env` 读取 `WECHATY_STATE_DIR`
- 定位 `${WECHATY_STATE_DIR}/wechat-claw.sqlite`
- 先备份一份 SQLite 到 `${WECHATY_STATE_DIR}/backups/`
- 清空 `raw_messages`、`message_attachments`、`scenario_extractions`、`summary_send_requests`
- 重置自增 ID，并执行 `wal_checkpoint + VACUUM`
- 重新启动 `wechat-claw`

补充说明：

- 脚本会优先使用系统里的 `sqlite3`
- 如果服务器没装 `sqlite3`，会自动回退到项目里的 `Node.js + better-sqlite3`
- 如果你更想直接安装系统命令，在 Ubuntu 上执行 `sudo apt-get update && sudo apt-get install -y sqlite3`

如果你不想手工输入确认，可以加 `--yes`：

```bash
cd /opt/wechat-claw/current
sudo bash deploy/clear-wechat-claw-db.sh --yes
```

补充说明：

- 这个脚本只清空 SQLite 里的业务数据，不会删除数据库文件本身
- 它也不会直接删除 `WECHATY_STATE_DIR/raw/` 里的历史图片附件文件
- 如果启用了 `WECHATY_ATTACHMENT_RETENTION_DAYS`，bot 运行后只会按保留天数自动清理更早的普通 `raw/` 图片目录；报账附件目录 `reimbursement/raw/` 永久保留
- 如果你连附件文件也想一起清理，建议先确认是否还需要保留原始取证材料，再单独删除
- 如果服务名或数据库路径不是默认值，可以执行 `sudo bash deploy/clear-wechat-claw-db.sh --help`

如果 bot 出现“服务还是 `logged_in`，但实际收不到新消息，重启服务也没恢复”的坏会话现象，可以直接执行：

```bash
cd /opt/wechat-claw/current
sudo bash deploy/reset-wechat-session.sh
```

这个脚本会按顺序执行：

- 从 `/etc/wechat-claw.env` 读取 `WECHATY_STATE_DIR` 和 `WECHATY_BOT_NAME`
- 备份当前 `${WECHATY_STATE_DIR}/${WECHATY_BOT_NAME}.memory-card.json` 到 `${WECHATY_STATE_DIR}/backups/`
- 将当前 `memory-card` 重命名为 `.disabled.<timestamp>`
- 重启 `wechat-claw`
- 轮询 `health.json`，等待服务进入 `waiting_for_scan`
- 打印 `latest-qrcode.txt` 的路径、二维码 URL 和 ASCII 预览

如果你不想手工输入确认，也可以加 `--yes`：

```bash
cd /opt/wechat-claw/current
sudo bash deploy/reset-wechat-session.sh --yes
```

常用可选参数：

- `--service-name <name>`：覆盖 systemd 服务名，默认 `wechat-claw`
- `--env-file <path>`：覆盖 env 文件路径，默认 `/etc/wechat-claw.env`
- `--state-dir <path>`：直接覆盖 `WECHATY_STATE_DIR`
- `--bot-name <name>`：直接覆盖 `WECHATY_BOT_NAME`
- `--wait-seconds <n>`：控制重启后等待恢复就绪的秒数，默认 `60`

如果想在重启前先验证配置，可以执行：

```bash
cd /opt/wechat-claw/current
set -a
. /etc/wechat-claw.env
set +a
sudo -u wechatclaw -E -H bash -lc 'cd /opt/wechat-claw/current && npm run doctor'
```

`/etc/wechat-claw.env` 最少包含：

```env
WECHATY_PUPPET=wechaty-puppet-wechat
WECHATY_PUPPET_WECHAT_PUPPETEER_UOS=1
WECHATY_BOT_NAME=wechat-loss-bot
WECHATY_STATE_DIR=/var/lib/wechat-claw
WECHATY_LOG_DIR=/var/lib/wechat-claw/logs
WECHATY_LOG_RETENTION_DAYS=7
WECHATY_LOG_LEVEL=info
WECHATY_ALERT_EMAIL_ENABLED=false
WECHATY_ALERT_SMTP_HOST=smtp.example.com
WECHATY_ALERT_SMTP_PORT=587
WECHATY_ALERT_SMTP_SECURE=false
WECHATY_ALERT_SMTP_USERNAME=bot@example.com
WECHATY_ALERT_SMTP_PASSWORD=
WECHATY_ALERT_EMAIL_FROM=bot@example.com
WECHATY_ALERT_EMAIL_TO=ops@example.com
WECHATY_WATCHDOG_CPU_STEP_THRESHOLD_PERCENTAGE_POINTS=10
WECHATY_WATCHDOG_CPU_STEP_MINIMUM_PERCENT=10
WECHATY_WATCHDOG_CPU_STEP_PERSISTENCE_SECONDS=60
WECHATY_TIMEZONE=Asia/Shanghai
WECHATY_DEBUG_CONTACT_NAME=你的主微信昵称
WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED=false
WECHATY_SELF_CANARY_ENABLED=false
WECHATY_SELF_CANARY_TARGET_CONTACT_NAME=文件传输助手
WECHATY_SELF_CANARY_INTERVAL_SECONDS=1800-2700
WECHATY_SELF_CANARY_ACK_TIMEOUT_SECONDS=120
WECHATY_SELF_CANARY_FAILURE_THRESHOLD=2
WECHATY_SELF_CANARY_AUTO_RESET_ENABLED=false
WECHATY_CHANNELS_JSON=[{"code":"loss_prod","enabled":true,"scenario":"loss-report","match":{"type":"room_topic","value":"AI测试群"},"deliveryTargets":[{"type":"contact_name","value":"你的主微信昵称"}],"summarySchedule":"0 22 * * *"}]
```

常用排障入口：

- `journalctl -u wechat-claw -f -o short-iso`
- `journalctl -u wechat-claw-watchdog.service -f -o short-iso`
- `systemctl status wechat-claw-watchdog.timer`
- `journalctl -u wechat-claw-daily-restart.service -f -o short-iso`
- `systemctl status wechat-claw-daily-restart.timer`
- `/var/lib/wechat-claw/logs`
- `/var/lib/wechat-claw/watchdog.json`
- `/var/lib/wechat-claw/watchdog-state.json`
- `/var/lib/wechat-claw/self-canary.json`
- `/var/lib/wechat-claw/room-canary.json`
- `tail -f /var/lib/wechat-claw/logs/app-$(date +%F).log`
- `tail -f /var/lib/wechat-claw/logs/error-$(date +%F).log`
- `cd /opt/wechat-claw/current && npm run watchdog:check`
- `cd /opt/wechat-claw/current && npm run logs:recent -- --errors`
- `/var/lib/wechat-claw/health.json`
- `/var/lib/wechat-claw/latest-qrcode.txt`

首次登录或掉线重登时，直接查看二维码文件并扫码即可。

自动升级说明：

- Ubuntu 的 `unattended-upgrades` 会配合 `needrestart` 重启使用旧系统库的服务
- 仓库里的 `deploy/needrestart-wechat-claw.conf` 会把 `wechat-claw.service` 排除掉，避免早晨自动补丁时 bot 被反复拉起
- 如果你手工维护服务器，也可以确认服务器存在 `/etc/needrestart/conf.d/wechat-claw.conf`

## 下一步

当前已经具备多 channel 路由骨架。后续开发会继续补：

- 新场景处理器
- 更强的多模态报损结构化提取
- 更丰富的日报模板与补跑能力

说明：

- 当前已经预留“模型优先、启发式回退”的报损提取链路
- 如果没有填写 `WECHATY_LOSS_EXTRACTION_PROVIDER/MODEL/API_KEY`，系统会自动回退到本地启发式提取
- 接入 Qwen3-VL-Flash 时，建议这样填写：

```env
WECHATY_LOSS_EXTRACTION_PROVIDER=qwen
WECHATY_LOSS_EXTRACTION_MODEL=qwen3-vl-flash
WECHATY_LOSS_EXTRACTION_API_KEY=你的百炼APIKey
WECHATY_LOSS_EXTRACTION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
```

## 常见问题

### `Missing WECHATY_PUPPET`

说明 `.env` 还没填完整，先补配置再启动。

### 扫码后没有登录成功

优先排查：

- 当前 puppet 是否可用
- token 是否正确
- 当前微信号是否被风控
- 若使用 `wechaty-puppet-wechat`，还要确认该微信号是否仍具备 Web WeChat 登录资格

### `init() without a ready angular env`

这个项目已经内置了对 `wechaty-puppet-wechat` 的本地补丁。

补丁位置：

- `scripts/patch-wechaty-puppet-wechat.mjs`

它会在 `npm install` 后自动执行，修复 `wechaty-puppet-wechat` 注入过早导致的 Angular 环境竞态问题。

### 上线了但没有转发群消息

优先排查：

- `WECHATY_CHANNELS_JSON` 是否是合法 JSON
- `match.value` 是否和群名完全一致
- `deliveryTargets` 里的联系人昵称或群名是否完全一致
- 机器人号是否真的在目标群里
- 如果只是想改这个字段，优先使用 `deploy/edit-wechat-claw-channels-json.sh`

## Unified admin authorization (opt-in)

The admin service defaults to `ADMIN_AUTH_MODE=legacy`. In `unified` mode it
resolves the Cookie against the loopback Gateway on every request, enforces
application permissions and data scopes, and never falls back to Basic Auth.
Set the backend-only `ADMIN_AUTH_GATEWAY_URL` and `ADMIN_AUTH_INTERNAL_TOKEN`
in `/etc/admin-auth-internal.env`; select the mode in
`/etc/admin-auth-expense-mode.env`. Only the admin service consumes these overrides.
Deploy the updated Gateway in legacy mode before changing the shared staff
Nginx route. Enable unified mode across Gateway and all three backends in one
coordinated maintenance window after account mapping and UI validation.
Account-management navigation and permission-aware controls are implemented locally.
Production cutover remains pending.
