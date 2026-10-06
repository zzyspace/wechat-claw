# Release hooks for comeover/scripts/deploy-release.sh (sourced as root on the server).
# Only the reimbursement admin runs. The WeChat bot and its timers stay installed but
# disabled; restoring them requires /etc/wechat-claw/bot-start-approved (explicit approval).
# Business data, attachments and images live in /var/lib/wechat-claw and are only read here.
SERVICES=(wechat-claw-reimbursement-admin.service)
UNIT_FILES=(
  deploy/wechat-claw-reimbursement-admin.service
  deploy/wechat-claw.service
  deploy/wechat-claw-watchdog.service
  deploy/wechat-claw-watchdog.timer
  deploy/wechat-claw-daily-restart.service
  deploy/wechat-claw-daily-restart.timer
)
HEALTH_URL=http://127.0.0.1:8788/health/expense
REQUIRED_PATHS=(/etc/wechat-claw.env)
WECHAT_CLAW_BOT_UNITS=(wechat-claw.service wechat-claw-watchdog.service wechat-claw-watchdog.timer wechat-claw-daily-restart.service wechat-claw-daily-restart.timer)
# Chromium for the bot is cached once outside releases instead of inside each release.
WECHAT_CLAW_PUPPETEER_CACHE=/opt/wechat-claw/shared/puppeteer

release_prepare() {
  id wechatclaw >/dev/null
  install -d -m 755 -o wechatclaw -g wechatclaw /opt/wechat-claw/shared "$WECHAT_CLAW_PUPPETEER_CACHE"
  if [[ -z "$(ls -A "$WECHAT_CLAW_PUPPETEER_CACHE")" && -d "$previous/.cache/puppeteer" ]]; then
    echo "[deploy] Seeding shared Puppeteer cache from $previous"
    cp -a "$previous/.cache/puppeteer/." "$WECHAT_CLAW_PUPPETEER_CACHE/"
  fi
  # TypeScript is compiled on the server, so dev dependencies are installed too.
  PUPPETEER_DOWNLOAD_PATH=$WECHAT_CLAW_PUPPETEER_CACHE install_node_modules --include=dev
  [[ -x node_modules/.bin/tsc && -f node_modules/wechaty-puppet-wechat/package.json ]]
  if [[ -f scripts/patch-wechaty-puppet-wechat.mjs ]]; then node scripts/patch-wechaty-puppet-wechat.mjs; fi
  if [[ -d node_modules/puppeteer ]]; then
    rm -rf node_modules/puppeteer/.local-chromium
    ln -sfn "$WECHAT_CLAW_PUPPETEER_CACHE" node_modules/puppeteer/.local-chromium
  fi
  if ! command -v heif-thumbnailer >/dev/null 2>&1 ||
    ! dpkg-query -W -f='${Status}' libheif-plugin-libde265 2>/dev/null | grep -qx 'install ok installed'; then
    echo "[deploy] Installing HEIC thumbnail decoder"
    DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l \
      apt-get install -y --no-install-recommends heif-thumbnailer libheif-plugin-libde265
  fi
  npm run build
}

release_test() {
  local state
  state=$(mktemp -d)
  chown nobody "$state"
  run_isolated env WECHATY_STATE_DIR="$state" npm run test:dist
  rm -rf -- "$state"
  # Doctor checks the production configuration as the runtime user, before the switch.
  # The env file is root-only (0600), so root loads it and hands the environment over.
  (
    set -a
    . /etc/wechat-claw.env
    set +a
    HOME=$(getent passwd wechatclaw | cut -d: -f6)
    export HOME
    runuser -u wechatclaw -- node --loader ts-node/esm src/app/doctor.ts
  )
}

release_backup() {
  backup_sqlite /var/lib/wechat-claw/wechat-claw.sqlite
  # Before the switch: keep the bot guard in place and the bot and its timers stopped.
  for unit in "${WECHAT_CLAW_BOT_UNITS[@]}"; do
    install -d -m 755 "/etc/systemd/system/$unit.d"
    install -m 644 deploy/bot-disabled.conf "/etc/systemd/system/$unit.d/50-bot-disabled.conf"
  done
  install -d -m 755 /etc/needrestart/conf.d
  install -m 644 deploy/needrestart-wechat-claw.conf /etc/needrestart/conf.d/wechat-claw.conf
  systemctl daemon-reload
  systemctl disable --now "${WECHAT_CLAW_BOT_UNITS[@]}" >/dev/null 2>&1 || true
}

release_verify() {
  expect_status https://comeover.cn/health/expense 200
  expect_status https://comeover.cn/expense 303
  for unit in "${WECHAT_CLAW_BOT_UNITS[@]}"; do
    [[ "$(systemctl show "$unit" -p ActiveState --value)" = inactive ]] || { echo "Expected $unit to stay inactive" >&2; return 1; }
  done
}
