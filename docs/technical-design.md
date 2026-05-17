# 微信群业务机器人技术方案

## 1. 背景与目标

本项目的第一阶段目标是：

- 监听普通微信中的指定报损群
- 识别群消息中的图片和文字
- 将内容整理为结构化数据
- 每天固定时间生成损耗日报
- 先将日报发回给你的个人微信号，作为调试和验收入口

同时，本项目从一开始就要为后续扩展保留空间。未来预计会增加：

- 报账群
- 盘点异常群
- 维修/报修群
- 其他需要从微信群消息中提取信息并定时汇总的业务群

因此，本项目不应设计为“只服务于报损群的单用途脚本”，而应设计为：

`一个通用的微信消息处理平台 + 多个可插拔的业务场景`

## 2. 设计原则

### 2.1 平台化优先

将“微信接入、消息落库、附件存储、模型调用、定时任务、消息回发”做成通用底座。

将“报损识别逻辑、报账识别逻辑、日报模板、字段定义”做成场景插件。

### 2.2 原始数据与业务结果分层

原始消息必须完整留存，业务结构化结果单独保存，避免后续模型升级后无法重跑。

### 2.3 模型可替换

视觉模型、OCR 模型、总结模型都不应写死。后续可以根据成本和效果替换为：

- 通义千问
- DeepSeek
- 智谱 GLM
- 其他国产模型

### 2.4 先做模块化单体，再保留服务化演进路径

第一阶段不建议拆微服务。建议使用一个 `Node.js + TypeScript` 工程完成：

- 微信监听
- 异步任务处理
- 数据存储
- 定时汇总

但代码层面必须按模块边界拆开，避免以后新增群场景时互相污染。

### 2.5 不让模型“瞎猜”

对于报损场景：

- 有文字说明时，数量、原因优先使用文字
- 只有图片时，不强迫模型猜数量
- 识别不确定时，允许输出 `unknown` 或 `null`
- 所有结构化结果都带 `confidence`

## 3. 范围定义

### 3.1 第一阶段包含

- 指定微信群监听
- 文本消息处理
- 图片消息下载与处理
- 文本与图片联合理解
- 报损事件结构化提取
- 日汇总生成
- 将结果发送到你的个人微信联系人
- 基础去重、重试、日志和错误记录

### 3.2 第一阶段不包含

- 金额统计
- 多账号集群部署
- 完整后台管理页面
- 高级权限系统
- 自动审批/自动回复复杂对话

## 4. 推荐技术路线

## 4.1 语言与运行时

- `Node.js 20+`
- `TypeScript`

原因：

- Wechaty 生态更贴近 Node.js
- 后续做异步任务、调度、HTTP 服务、数据库接入都比较顺手
- 扩展业务场景时，类型系统能明显降低维护成本

### 4.2 微信接入

- `Wechaty`

说明：

- 你的场景是普通微信，不是企业微信
- 这意味着接入层本质上属于 RPA/非官方能力
- 这是整个项目里最大的不确定性来源

建议：

- 使用专门的机器人微信号，不要直接长期跑主账号
- 机器人号加入目标群，并和你的主微信号互为联系人
- 将回传目标设置为你的主微信联系人，而不是依赖机器人号自己的文件传输助手

### 4.3 数据存储

开发环境：

- `SQLite`

生产环境建议：

- `PostgreSQL`

附件存储：

- 本地文件系统起步
- 后续可切到对象存储

### 4.4 异步与定时

第一阶段：

- 进程内任务队列
- `node-cron` 定时生成日报

后续消息量上来后再升级为：

- `BullMQ + Redis`

### 4.5 模型使用策略

推荐拆为两类任务：

1. 结构化提取
2. 汇总总结

推荐模型组合：

- 结构化提取：`Qwen3-VL-Flash`
- 日报总结：`DeepSeek-V4-Flash`

备选：

- 更省钱：`GLM-4.6V-Flash` + `DeepSeek-V4-Flash`
- 单模型简化：全用 `Qwen3.6-Flash`

选择逻辑：

- 报损群主要是食材/物品图片，不是纯文档 OCR
- 因此主模型应偏视觉理解，而不是只做 OCR
- 汇总日报是文本生成任务，可以交给更便宜的文本模型

## 5. 总体架构

```text
Wechaty Listener
  -> Message Normalizer
  -> Channel Router
  -> Scenario Processor
  -> Extraction Orchestrator
  -> Storage
  -> Daily Aggregator
  -> Summary Generator
  -> Delivery Sender
```

更细一点的分层：

```text
[接入层]
Wechaty

[平台层]
1. 消息标准化
2. 附件下载与哈希
3. 消息去重
4. 群路由
5. 模型调用适配
6. 任务调度
7. 日志、重试、告警

[场景层]
1. 报损场景
2. 报账场景
3. 盘点异常场景

[输出层]
1. 微信回发
2. 数据导出
3. 后续 Web 管理页/API
```

## 6. 关键模块设计

### 6.1 Message Ingestion

职责：

- 接收微信群消息
- 提取发送者、群 ID、群名、时间、消息类型
- 下载图片附件
- 生成标准化消息对象

标准化消息示例：

```json
{
  "messageId": "wx_msg_123",
  "channelExternalId": "room_xxx",
  "channelName": "门店食材报损群",
  "senderExternalId": "contact_xxx",
  "senderName": "张三",
  "sentAt": "2026-05-17T09:15:00+08:00",
  "messageType": "image_text",
  "text": "今天有3盒豆腐变质，已处理",
  "attachments": [
    {
      "type": "image",
      "localPath": "storage/raw/2026/05/17/abc.jpg",
      "sha256": "..."
    }
  ]
}
```

### 6.2 Channel Router

职责：

- 根据群聊配置决定该消息走哪个业务场景
- 后续支持同一群内按规则进一步分流

第一阶段建议：

- 一个群绑定一个场景

后续可扩展为：

- 一个群多个规则
- 先分类，再分发到不同场景处理器

配置示例：

```yaml
channels:
  - code: loss_main
    match:
      type: room_topic
      value: "门店食材报损群"
    scenario: loss-report
    enabled: true
    deliveryTargets:
      - type: contact_name
        value: "你的主微信昵称"
    summarySchedule: "0 22 * * *"
```

### 6.3 Scenario Processor

这是扩展性的核心。

每个业务场景应实现统一接口，例如：

```ts
interface ScenarioDefinition {
  code: string;
  displayName: string;
  accepts(message: NormalizedMessage): boolean;
  buildExtractionTasks(message: NormalizedMessage): ExtractionTask[];
  normalizeResult(result: ModelResult, message: NormalizedMessage): StructuredRecord[];
  aggregateDaily(records: StructuredRecord[], date: string): DailySummary;
  renderSummary(summary: DailySummary): OutboundMessage;
}
```

建议第一阶段至少实现两个场景目录：

- `src/scenarios/loss-report`
- `src/scenarios/reimbursement`

即使报账场景暂时不开发，也先保留目录和接口约束，避免后面再返工主结构。

### 6.4 Extraction Orchestrator

职责：

- 决定是否需要调用视觉模型
- 合并图片与文本上下文
- 指定输出 JSON Schema
- 保存提取原文、模型版本、提示词版本、结构化结果

建议将模型调用按任务类型拆开：

- `vision_extract`
- `document_ocr_extract`
- `text_summarize`

这样后面报账群就可以走：

- 图片票据 -> OCR/票据提取模型
- 文本备注 -> 文本模型

而报损群继续走：

- 食材图片 + 描述文字 -> 视觉理解模型

### 6.5 Aggregator

职责：

- 按日期和场景汇总结构化记录
- 统计数量、频次、原因分布、待复核记录
- 形成可供模型总结或直接模板渲染的汇总数据

### 6.6 Delivery Sender

职责：

- 发送日报到指定联系人或群
- 记录发送结果
- 防止重复发送

后续可以支持：

- 联系人
- 群聊
- 邮件
- Webhook

## 7. 数据模型设计

建议采用“通用平台表 + 场景业务表”的方式。

### 7.1 通用平台表

#### channels

记录监听对象和路由信息。

核心字段：

- `id`
- `code`
- `name`
- `external_id`
- `channel_type`
- `scenario_code`
- `enabled`

#### raw_messages

保存标准化后的原始消息。

核心字段：

- `id`
- `message_external_id`
- `channel_id`
- `sender_external_id`
- `sender_name`
- `message_type`
- `text_content`
- `sent_at`
- `dedupe_key`
- `ingested_at`

#### message_attachments

保存附件信息。

核心字段：

- `id`
- `raw_message_id`
- `attachment_type`
- `local_path`
- `sha256`
- `mime_type`

#### extraction_jobs

保存模型处理任务。

核心字段：

- `id`
- `raw_message_id`
- `scenario_code`
- `task_type`
- `provider`
- `model`
- `status`
- `retry_count`
- `error_message`
- `started_at`
- `finished_at`

#### extraction_results

保存模型结构化结果。

核心字段：

- `id`
- `job_id`
- `schema_version`
- `prompt_version`
- `result_json`
- `confidence`
- `needs_review`

#### deliveries

保存日报发送记录。

核心字段：

- `id`
- `scenario_code`
- `target_type`
- `target_value`
- `summary_date`
- `status`
- `sent_at`

### 7.2 报损场景业务表

#### loss_events

每条结构化报损事件一行。

核心字段：

- `id`
- `raw_message_id`
- `channel_id`
- `reporter_name`
- `occurred_at`
- `reason`
- `notes`
- `confidence`
- `needs_review`

#### loss_event_items

一条报损事件可能包含多个物品。

核心字段：

- `id`
- `loss_event_id`
- `item_name`
- `item_category`
- `quantity`
- `unit`
- `evidence_type`
- `confidence`

### 7.3 后续报账场景业务表

未来新增：

- `expense_claims`
- `expense_claim_attachments`
- `expense_claim_items`

这样做的好处是：

- 平台层字段稳定
- 不同业务场景的字段互不污染
- 新场景上线时只需新增场景表和处理器

## 8. 报损场景的结构化规则

### 8.1 目标输出

报损场景建议输出如下结构：

```json
{
  "eventType": "loss_report",
  "reporter": "张三",
  "reportedAt": "2026-05-17T09:15:00+08:00",
  "reason": "变质",
  "notes": "今日早班巡检发现",
  "items": [
    {
      "name": "豆腐",
      "category": "食材",
      "quantity": 3,
      "unit": "盒",
      "evidenceType": "image+text",
      "confidence": 0.92
    }
  ],
  "overallConfidence": 0.9,
  "needsReview": false
}
```

### 8.2 提取规则

- 若文字明确描述数量，优先使用文字
- 若图片能确认物品但无法确认数量，数量可为空
- 若同时出现多个物品，拆成多个 item
- 原因尽量标准化，例如：
  - `变质`
  - `过期`
  - `包装破损`
  - `掉落污染`
  - `操作失误`
  - `其他`
- 如果模型无法确认是不是报损，标记 `needsReview=true`

### 8.3 不建议模型直接做的事

- 从照片里硬估重量
- 从模糊图片里猜品牌和规格
- 没有文本支撑时强行补全数量

## 9. 日报汇总设计

### 9.1 汇总时机

建议默认：

- 每天 `22:00`

后续可以按场景单独配置：

- 报损群：每天一次
- 报账群：每天一次或工作日一次
- 异常监控群：每 2 小时一次

### 9.2 汇总指标

报损日报建议包含：

- 当日报损消息数
- 当日识别出的报损事件数
- 涉及物品种类数
- 高频报损物品 TOP N
- 高频报损原因 TOP N
- 无法确认或待复核条数
- 图片有但无数量的条数

### 9.3 日报模板

建议先使用固定模板，不需要让模型完全自由生成。

示例：

```text
门店报损日报（2026-05-17）

今日共收到 18 条相关消息，识别出 15 条有效报损事件，涉及 11 种物品。
高频报损物品：豆腐（4次）、生菜（3次）、番茄（3次）
主要报损原因：变质（7次）、包装破损（4次）、操作失误（2次）
待人工复核：3 条
其中 5 条无法确认具体数量，建议补充文字说明。
```

建议生成方式：

1. 聚合器先生成结构化统计结果
2. 再由总结模型将结构化统计渲染为自然语言
3. 若模型调用失败，则回退到程序内置模板

这样可以保证：

- 报表一定发得出去
- 模型只负责润色，不控制关键统计逻辑

## 10. 模型抽象设计

为避免后续供应商切换成本高，建议定义统一接口。

### 10.1 Vision Provider

```ts
interface VisionProvider {
  extractStructuredData(input: VisionExtractionInput): Promise<StructuredExtractionResult>;
}
```

### 10.2 Summary Provider

```ts
interface SummaryProvider {
  summarize(input: SummaryInput): Promise<SummaryOutput>;
}
```

### 10.3 Provider 选择策略

可以在配置里按任务类型选择：

```yaml
modelRouting:
  loss-report:
    extraction:
      provider: qwen
      model: qwen3-vl-flash
    summary:
      provider: deepseek
      model: deepseek-v4-flash
  reimbursement:
    extraction:
      provider: qwen
      model: qwen-vl-ocr
    summary:
      provider: deepseek
      model: deepseek-v4-flash
```

这样新增报账群时，不需要改平台层代码，只需要：

- 新增 `reimbursement` 场景处理器
- 配置该场景使用不同提取模型

## 11. 项目目录建议

```text
src/
  app/
    bootstrap.ts
    config.ts
  bot/
    wechaty-client.ts
    message-handler.ts
  core/
    channels/
    messages/
    attachments/
    jobs/
    llm/
    delivery/
    storage/
    logging/
  scenarios/
    loss-report/
      index.ts
      schema.ts
      prompts.ts
      aggregator.ts
      renderer.ts
    reimbursement/
      index.ts
      schema.ts
      prompts.ts
      aggregator.ts
      renderer.ts
  infra/
    db/
    fs/
    scheduler/
    providers/
      qwen/
      deepseek/
      glm/
  types/
  scripts/

docs/
  technical-design.md
```

这个结构的重点是：

- `core` 放通用平台能力
- `scenarios` 放场景插件
- `providers` 放模型厂商适配

## 12. 可靠性设计

### 12.1 去重

建议去重键：

- 优先 `message_external_id`
- 若接入层偶发拿不到稳定 ID，再补充：
  - `channel_id`
  - `sender`
  - `sent_at`
  - `text hash`
  - `image sha256`

### 12.2 重试

对以下动作做重试：

- 图片下载
- 模型调用
- 微信消息发送

### 12.3 审计与可追溯

必须保存：

- 原始消息
- 附件文件
- 模型版本
- Prompt 版本
- 结构化结果
- 汇总结果

这样后续效果不好时可以重跑，而不是只能看最终日报。

### 12.4 人工复核

建议第一阶段先不做页面，但要保留标记字段：

- `needs_review`
- `review_status`
- `review_notes`

后续如果有必要，可以补一个轻量管理页专门处理低置信度记录。

## 13. 风险与应对

### 13.1 最大风险：普通微信接入稳定性

风险：

- 登录状态失效
- 微信风控
- 监听偶发中断

应对：

- 使用专门机器人号
- 记录最后活跃时间和断线状态
- 支持断线重连
- 支持“补跑日报”

### 13.2 图片识别不稳定

风险：

- 光线差
- 角度偏
- 仅拍物品，无数量信息

应对：

- 明确允许 `quantity = null`
- 提示业务侧逐步形成发报损的规范
- 对低置信度记录单独统计

### 13.3 多场景互相影响

风险：

- 报损逻辑侵入报账逻辑
- 新场景一加就要改平台主干

应对：

- 坚持场景插件接口
- 平台层只做通用能力，不写业务字段判断

## 14. 分阶段实施计划

### Phase 0: 接入验证

目标：

- 验证 Wechaty 对目标微信号和目标群可用
- 能拿到文本和图片
- 能把消息回发给你的主微信号

验收标准：

- 指定群里发一条文字和一张图片
- 系统成功收到并落库
- 系统成功发一条测试消息给你的主微信

### Phase 1: 报损 MVP

目标：

- 完成报损场景结构化提取
- 每天生成日报

范围：

- 单群监听
- SQLite
- 本地文件存储
- Qwen3-VL-Flash 提取
- DeepSeek-V4-Flash 总结

验收标准：

- 连续 3 天自动生成日报
- 日报可读
- 至少 80% 的报损消息能正确识别物品名称和原因

### Phase 2: 平台化加固

目标：

- 抽象通用场景接口
- 增加配置化路由
- 增强重试、日志、补跑能力

验收标准：

- 新增一个空白场景不需要改平台核心模块
- 可按日期重跑某天日报

### Phase 3: 新增报账群场景

目标：

- 支持票据/截图类消息识别
- 支持不同场景使用不同提取模型

验收标准：

- 报损和报账两个群同时运行
- 两边汇总互不影响

## 15. 当前建议的落地选择

如果现在开始做，我建议直接按下面这组方案起步：

- 运行时：`Node.js + TypeScript`
- 微信接入：`Wechaty`
- 数据库：`SQLite` 起步，后续切 `PostgreSQL`
- 附件存储：本地文件系统
- 视觉提取：`Qwen3-VL-Flash`
- 文本总结：`DeepSeek-V4-Flash`
- 调度：`node-cron`
- 架构方式：`模块化单体 + 场景插件`

这是在当前约束下，兼顾成本、开发速度和后续可扩展性的最稳妥方案。

## 16. 下一步开发顺序

建议按下面顺序推进开发：

1. 完成项目脚手架和配置系统
2. 跑通 Wechaty 登录、群监听、联系人回发
3. 设计数据库表并完成原始消息落库
4. 实现报损场景插件
5. 接通视觉提取和日报生成
6. 做去重、重试、日志和补跑
7. 再考虑报账场景扩展

如果开始进入编码阶段，建议始终以“平台主干不感知报损细节，报损逻辑放到场景层”作为第一约束。
