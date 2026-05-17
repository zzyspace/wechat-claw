# wechat-claw

一个面向微信群业务汇总的机器人骨架工程。当前阶段先跑通：

- Wechaty 启动
- 指定群消息监听
- 将群消息回发给指定联系人

## 当前能力

- 从环境变量读取 bot 配置
- 启动 Wechaty 实例
- 监听群消息
- 按群名过滤目标群
- 将收到的消息转发给指定联系人，作为联调验证

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
WECHATY_BOT_NAME=wechat-loss-bot
WECHATY_TARGET_ROOM_TOPIC=门店食材报损群
WECHATY_DELIVERY_CONTACT_NAME=你的主微信昵称
```

字段说明：

- `WECHATY_PUPPET`: 具体接入方案名称
- `WECHATY_PUPPET_SERVICE_TOKEN`: 仅 `wechaty-puppet-service` 等 service 模式需要
- `WECHATY_BOT_NAME`: 本地 bot 名称
- `WECHATY_TARGET_ROOM_TOPIC`: 需要监听的群名
- `WECHATY_DELIVERY_CONTACT_NAME`: 收测试回传消息的联系人昵称

推荐先试两种模式中的一种：

`Web` 模式：

```env
WECHATY_PUPPET=wechaty-puppet-wechat
WECHATY_PUPPET_SERVICE_TOKEN=
WECHATY_PUPPET_WECHAT_PUPPETEER_UOS=1
WECHATY_BOT_NAME=wechat-loss-bot
WECHATY_TARGET_ROOM_TOPIC=AI测试群
WECHATY_DELIVERY_CONTACT_NAME=你的主微信昵称
```

说明：

- `WECHATY_PUPPET_WECHAT_PUPPETEER_UOS=1` 建议在 `web` 模式下默认开启
- 这可以让 `wechaty-puppet-wechat` 走 UOS 兼容分支，当前在你的机器上比直接访问 `https://wx.qq.com` 更稳定

`Service` 模式：

```env
WECHATY_PUPPET=wechaty-puppet-service
WECHATY_PUPPET_SERVICE_TOKEN=puppet_paimon_xxx
WECHATY_BOT_NAME=wechat-loss-bot
WECHATY_TARGET_ROOM_TOPIC=AI测试群
WECHATY_DELIVERY_CONTACT_NAME=你的主微信昵称
```

建议：

- `WECHATY_DELIVERY_CONTACT_NAME` 先填你自己的主微信昵称
- `WECHATY_TARGET_ROOM_TOPIC` 必须和微信群当前显示名称完全一致
- 当前 bot 登录的微信号建议使用专门测试号

## 运行

先做环境自检：

```bash
npm run doctor
```

预期：

- 输出当前配置摘要
- 缺少必要配置时直接报错退出
- `Wechaty module check passed`
- `Doctor check passed`

开发模式：

```bash
npm run dev
```

构建：

```bash
npm run build
```

生产运行：

```bash
npm start
```

## 本地联调步骤

1. 准备一个机器人微信号，并把它拉进目标报损群。
2. 确保你的主微信号和机器人号互为联系人。
3. 填好 `.env` 中的四个关键字段：
   - `WECHATY_PUPPET`
   - `WECHATY_PUPPET_SERVICE_TOKEN`
   - `WECHATY_TARGET_ROOM_TOPIC`
   - `WECHATY_DELIVERY_CONTACT_NAME`
   如果你试的是 `wechaty-puppet-wechat`，`WECHATY_PUPPET_SERVICE_TOKEN` 留空即可。
   同时建议增加：
   - `WECHATY_PUPPET_WECHAT_PUPPETEER_UOS=1`
4. 执行 `npm run doctor`，确认配置检查通过。
5. 执行 `npm run dev`。
6. 观察终端：
   - 若支持终端二维码，会直接显示二维码
   - 否则日志里会打印二维码链接
7. 用机器人微信号扫码登录。
8. 登录成功后，程序会向 `WECHATY_DELIVERY_CONTACT_NAME` 发送一条 bot 上线通知。
9. 在目标群里发一条测试消息。
10. 程序应将该消息摘要再次发给 `WECHATY_DELIVERY_CONTACT_NAME`。

## 联调通过标准

满足以下 3 条就说明接入链路通了：

1. 机器人账号成功登录
2. 你的主微信收到 bot 上线通知
3. 目标群发消息后，你的主微信收到消息摘要

## 下一步

当前只是接入验证骨架。后续开发会继续补：

- 原始消息落库
- 图片下载与存储
- 场景路由
- 报损结构化提取
- 日报汇总与发送

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

- `WECHATY_TARGET_ROOM_TOPIC` 是否和群名完全一致
- `WECHATY_DELIVERY_CONTACT_NAME` 是否和联系人昵称完全一致
- 机器人号是否真的在目标群里
