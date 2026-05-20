# wechat-claw

一个面向微信群业务汇总的机器人骨架工程。当前阶段先跑通：

- Wechaty 启动
- 多群消息监听
- 将群消息回发给指定联系人或群
- 原始消息落 SQLite
- 图片附件落本地文件
- 进程内定时发送报损日报
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
- 支持按群生成报损日报文本骨架
- 支持按 channel 独立 cron 在 bot 进程内直接发送日报
- 将二维码、登录态、健康状态统一写入 `WECHATY_STATE_DIR`

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
WECHATY_TIMEZONE=Asia/Shanghai
WECHATY_LOSS_MERGE_WINDOW_SECONDS=60
WECHATY_LOSS_EXTRACTION_PROVIDER=
WECHATY_LOSS_EXTRACTION_MODEL=
WECHATY_LOSS_EXTRACTION_API_KEY=
WECHATY_LOSS_EXTRACTION_BASE_URL=https://dashscope.aliyuncs.com/compatible-mode/v1
WECHATY_BOT_NAME=wechat-loss-bot
WECHATY_CHANNELS_JSON=[{"code":"loss_a","enabled":true,"scenario":"loss-report","match":{"type":"room_topic","value":"门店食材报损群A"},"deliveryTargets":[{"type":"contact_name","value":"你的主微信昵称"},{"type":"room_topic","value":"门店A日报群"}],"summarySchedule":"0 22 * * *"},{"code":"loss_b","enabled":true,"scenario":"loss-report","match":{"type":"room_topic","value":"门店食材报损群B"},"deliveryTargets":[{"type":"contact_name","value":"你的主微信昵称"}],"summarySchedule":"0 22 * * *"}]
```

字段说明：

- `WECHATY_PUPPET`: 具体接入方案名称
- `WECHATY_PUPPET_SERVICE_TOKEN`: 仅 `wechaty-puppet-service` 等 service 模式需要
- `WECHATY_STATE_DIR`: 统一状态目录，包含 SQLite、附件、二维码、health、memory-card
- `WECHATY_TIMEZONE`: 日期边界和 cron 解释时区，默认 `Asia/Shanghai`
- `WECHATY_CHANNELS_JSON`: 推荐的多群配置入口，支持多个监听群、多个发送目标、每个 channel 独立日报周期
- `WECHATY_SUMMARY_PROMPT_TEMPLATE`: 总结提示词模板，可自定义
- `WECHATY_LOSS_MERGE_WINDOW_SECONDS`: 同一人图文消息合并窗口，默认 `60` 秒
  当前规则：
  - 图 + 文字：窗口内可合并为一条报损
  - 图 + 图：不合并
  - 一条报损最多保留一张图片
- `WECHATY_LOSS_EXTRACTION_PROVIDER`: 报损提取模型提供商
- `WECHATY_LOSS_EXTRACTION_MODEL`: 报损提取模型名
- `WECHATY_LOSS_EXTRACTION_API_KEY`: 报损提取模型 API Key
- `WECHATY_LOSS_EXTRACTION_BASE_URL`: 报损提取模型接口地址
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
    "summarySchedule": "0 22 * * *"
  }
]
```

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

生成报损日报：

```bash
npm run summary:loss
```

生成最近 N 分钟报损汇总：

```bash
npm run summary:loss:recent
```

例如看最近 10 分钟：

```bash
npm run summary:loss:recent 10
```

生产运行：

```bash
npm start
```

## 本地联调步骤

1. 准备一个机器人微信号，并把它拉进目标报损群。
2. 确保你的主微信号和机器人号互为联系人。
3. 填好 `.env` 中的关键字段：
   - `WECHATY_PUPPET`
   - `WECHATY_PUPPET_SERVICE_TOKEN`
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
8. 登录成功后，程序会向所有已配置的 `deliveryTargets` 发送一条 bot 上线通知。
9. 在目标群里发一条测试消息。
10. 程序应将该消息摘要再次发给当前 channel 的 `deliveryTargets`。

## 联调通过标准

满足以下 3 条就说明接入链路通了：

1. 机器人账号成功登录
2. 你的主微信收到 bot 上线通知
3. 目标群发消息后，你的主微信收到消息摘要

如果要额外验证存储链路，再检查：

- `WECHATY_STATE_DIR/wechat-claw.sqlite`
- `WECHATY_STATE_DIR/raw`
- `npm run inspect:messages`
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
sudo deploy-wechat-claw
```

这个命令会执行：

- `git pull --ff-only origin main`
- 安装最新的 `systemd` service 文件
- 安装 `needrestart` 豁免，避免系统自动升级时重启 bot
- `systemctl daemon-reload`
- `npm ci`
- `npm run build`
- `npm run doctor`
- `systemctl restart wechat-claw`

如果你想降低“忘记同步服务器配置”的风险，推荐以后统一只用这一条本地发布命令：

```bash
deploy/release-wechat-claw.sh root@139.196.140.215
```

这条命令会固定执行：

- 同步本地 `.env` 到服务器 `/etc/wechat-claw.env`
- 自动补齐服务器专用字段
- 触发远程 `git pull + npm ci + build + doctor + restart`

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

`/etc/wechat-claw.env` 最少包含：

```env
WECHATY_PUPPET=wechaty-puppet-wechat
WECHATY_PUPPET_WECHAT_PUPPETEER_UOS=1
WECHATY_BOT_NAME=wechat-loss-bot
WECHATY_STATE_DIR=/var/lib/wechat-claw
WECHATY_TIMEZONE=Asia/Shanghai
WECHATY_CHANNELS_JSON=[{"code":"loss_prod","enabled":true,"scenario":"loss-report","match":{"type":"room_topic","value":"AI测试群"},"deliveryTargets":[{"type":"contact_name","value":"你的主微信昵称"}],"summarySchedule":"0 22 * * *"}]
```

常用排障入口：

- `journalctl -u wechat-claw -f`
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
