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
WECHATY_TIMEZONE=Asia/Shanghai
WECHATY_DEBUG_CONTACT_NAME=你的主微信昵称
WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED=false
WECHATY_ATTACHMENT_RETENTION_DAYS=60
WECHATY_COLD_START_IGNORE_WINDOW_SECONDS=60
WECHATY_LOSS_MERGE_WINDOW_SECONDS=60
WECHATY_REIMBURSEMENT_BACKWARD_TEXT_MERGE_WINDOW_SECONDS=3
WECHATY_LOSS_EXTRACTION_PROVIDER=
WECHATY_LOSS_EXTRACTION_MODEL=
WECHATY_LOSS_EXTRACTION_API_KEY=
WECHATY_LOSS_EXTRACTION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
WECHATY_REIMBURSEMENT_EXTRACTION_PROVIDER=qwen
WECHATY_REIMBURSEMENT_EXTRACTION_MODEL=qwen3.5-flash
WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY=
WECHATY_REIMBURSEMENT_EXTRACTION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
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
- `WECHATY_TIMEZONE`: 日期边界和 cron 解释时区，默认 `Asia/Shanghai`
- `WECHATY_DEBUG_CONTACT_NAME`: `"[wechat-claw]"` 调试信息的接收联系人，不参与业务日报发送；上线通知始终走这里
- `WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED`: 是否发送 `"[wechat-claw] 已收到群消息"` 这类调试摘要，默认 `false`
- `WECHATY_CHANNELS_JSON`: 推荐的多群配置入口，支持 `loss-report` 和 `reimbursement` 场景
- `WECHATY_ATTACHMENT_RETENTION_DAYS`: 图片附件保留天数，默认 `60` 天；会清理 `raw/` 和 `reimbursement/raw/` 下更早的历史目录，设为 `0` 可关闭
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
- `WECHATY_REIMBURSEMENT_EXTRACTION_PROVIDER`: 报账提取模型提供商，默认 `qwen`
- `WECHATY_REIMBURSEMENT_EXTRACTION_MODEL`: 报账图片识别模型名，默认 `qwen3.5-flash`
- `WECHATY_REIMBURSEMENT_EXTRACTION_API_KEY`: 报账提取模型 API Key
- `WECHATY_REIMBURSEMENT_EXTRACTION_BASE_URL`: 报账提取模型接口地址
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
  - 当前 `x` 支持 `food / salary / rent / utilities / manager_reimbursement / planned_expense / other / 食材 / 工资 / 薪资 / 房租 / 租金 / 水电 / 水电费 / 电费 / 水费 / 店长报账 / 店长 / 预报账 / 其他 / 其它`；回执展示会统一使用中文 label
  - 后续新增类目时，只需要扩展 `src/scenarios/reimbursement/categories.ts`
  - 回复 `note: xxx` 或 `note：xxx`：将 `xxx` 追加到对应报账备注
  - 回复精确的 `x月账`：把这条回复作为备注挂到对应报账，并按现有“月账回填创建时间”逻辑把 `created_at` 回填到对应月份月底 `00:00:00`
  - 指令执行成功后，bot 会回复 `已处理`
  - 指令格式正确但没找到对应报账时，bot 会回复 `未找到对应报账`
  - 指令不支持时，bot 会回复 `不支持的指令`
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

常用筛选：

```bash
npm run inspect:reimbursements -- --limit 20
npm run inspect:reimbursements -- --channel reimbursement_a
```

说明：

- 每份报账会按一个区块打印，包含金额、类别、票据日期、备注、OCR 文本、是否需要复核
- 同时会展开来源 raw message 明细，方便排查“图片 + 文字”是否合并正确
- 没有报账数据时会打印 `status=empty`

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

默认会处理的情况：

- 主服务不在 `active` 状态
- `health.status=degraded` 持续超过阈值
- bot 已登出
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
tail -f /var/lib/wechat-claw/logs/app-$(date +%F).log
tail -f /var/lib/wechat-claw/logs/error-$(date +%F).log
```

人工恢复策略：

- 如果服务已退出：优先看 `systemctl status wechat-claw`
- 如果服务在线但登录失效：查看 `latest-qrcode.txt`，重新扫码
- 如果进入 `degraded` 且长期不恢复：执行 `sudo systemctl restart wechat-claw`
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
- 如果启用了 `WECHATY_ATTACHMENT_RETENTION_DAYS`，bot 运行后会按保留天数自动清理更早的 raw 图片目录
- 如果你连附件文件也想一起清理，建议先确认是否还需要保留原始取证材料，再单独删除
- 如果服务名或数据库路径不是默认值，可以执行 `sudo bash deploy/clear-wechat-claw-db.sh --help`

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
WECHATY_TIMEZONE=Asia/Shanghai
WECHATY_DEBUG_CONTACT_NAME=你的主微信昵称
WECHATY_DEBUG_RECEIVED_ROOM_MESSAGE_ENABLED=false
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
