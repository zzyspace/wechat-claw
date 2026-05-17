# 下次如何继续

## 1. 进入项目

```bash
cd /Users/ryan/DataDisk/Work/AI/wechat-claw
```

## 2. 看当前状态

```bash
git log --oneline -5
git status
```

当前开发节点已经完成：

- Wechaty `web` 模式登录验证
- 二维码落文件
- 原始消息落 SQLite
- 图片附件落本地文件

## 3. 安装依赖

换新终端后先执行：

```bash
npm install
```

原因：

- 需要确保依赖完整
- `postinstall` 会自动执行 `wechaty-puppet-wechat` 本地补丁

## 4. 确认配置

`.env` 需要至少包含：

```env
WECHATY_PUPPET=wechaty-puppet-wechat
WECHATY_PUPPET_SERVICE_TOKEN=
WECHATY_PUPPET_WECHAT_PUPPETEER_UOS=1
WECHATY_BOT_NAME=wechat-loss-bot
WECHATY_TARGET_ROOM_TOPIC=AI测试群
WECHATY_DELIVERY_CONTACT_NAME=Ryan。
```

## 5. 如果要继续测试 bot

先检查配置：

```bash
npm run doctor
```

再启动：

```bash
npm run dev
```

如果需要二维码，查看：

- [storage/latest-qrcode.txt](/Users/ryan/DataDisk/Work/AI/wechat-claw/storage/latest-qrcode.txt)

## 6. 如果要检查存储结果

消息数据库：

- [storage/wechat-claw.sqlite](/Users/ryan/DataDisk/Work/AI/wechat-claw/storage/wechat-claw.sqlite)

图片附件目录：

- [storage/raw](/Users/ryan/DataDisk/Work/AI/wechat-claw/storage/raw)

## 7. 会保留的内容

- git 提交
- 代码改动
- `.env`
- `wechat-loss-bot.memory-card.json`
- SQLite 数据
- 已下载图片

## 8. 不会保留的内容

- 正在运行的 `npm run dev` 进程
- 当前在线登录会话
- 终端里的二维码输出

## 9. 下一个开发目标

下一步建议继续做：

1. 增加查看最近消息的本地脚本
2. 实现报损场景结构化提取
