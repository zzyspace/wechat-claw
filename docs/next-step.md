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
- 登录态显式落 memory-card
- 进程内日报调度
- health.json 健康状态写入

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
WECHATY_STATE_DIR=/private/tmp/wechat-claw-state
WECHATY_TIMEZONE=Asia/Shanghai
WECHATY_DEBUG_CONTACT_NAME=Ryan。
WECHATY_CHANNELS_JSON=[{"code":"loss_test","enabled":true,"scenario":"loss-report","match":{"type":"room_topic","value":"AI测试群"},"deliveryTargets":[{"type":"contact_name","value":"Ryan。"}],"summarySchedule":"0 22 * * *"}]
```

## 5. 如果要继续测试 bot

先检查配置：

```bash
WECHATY_STATE_DIR=/private/tmp/wechat-claw-state npm run doctor
```

再启动：

```bash
npm run dev
```

如果需要二维码，查看：

- `/private/tmp/wechat-claw-state/latest-qrcode.txt`

如果要看健康状态：

- `/private/tmp/wechat-claw-state/health.json`

## 6. 如果要检查存储结果

消息数据库：

- `/private/tmp/wechat-claw-state/wechat-claw.sqlite`

图片附件目录：

- `/private/tmp/wechat-claw-state/raw`

## 7. 会保留的内容

- git 提交
- 代码改动
- `.env`
- `WECHATY_STATE_DIR` 下的 memory-card
- SQLite 数据
- 已下载图片
- health.json

## 8. 不会保留的内容

- 正在运行的 `npm run dev` 进程
- 当前在线登录会话
- 终端里的二维码输出

## 9. 下一个开发目标

服务器部署时，重点关注：

1. `WECHATY_STATE_DIR` 是否可写
2. systemd 服务是否加载了 `/etc/wechat-claw.env`
3. 登录二维码是否生成到 `latest-qrcode.txt`
4. `health.json` 的 `status` 是否进入 `logged_in`

如果服务器已经初始化完成，而你这次没有改本地 `.env`，可以直接执行：

```bash
cd /opt/wechat-claw/current
sudo bash deploy/deploy-wechat-claw.sh
```

如果你想避免忘记同步服务器配置，推荐以后统一使用这一条本地发布命令：

```bash
deploy/release-wechat-claw.sh root@139.196.140.215
```

如果本地 `.env` 改了，但这次只想同步配置、不发布代码，再单独执行：

```bash
deploy/sync-wechat-claw-env.sh root@139.196.140.215
```

如果想同步配置后顺手发布：

```bash
deploy/sync-wechat-claw-env.sh --deploy root@139.196.140.215
```
