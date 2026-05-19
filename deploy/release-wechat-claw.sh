#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  deploy/release-wechat-claw.sh [options] <ssh-target> [source-env-file]

Description:
  Recommended release entrypoint for this project.
  It always syncs the local env file first, then runs the remote deploy.

Options:
  --state-dir <path>        Server-side WECHATY_STATE_DIR. Default: /var/lib/wechat-claw
  --timezone <tz>           Server-side WECHATY_TIMEZONE. Default: Asia/Shanghai
  --remote-env-path <path>  Remote target env file. Default: /etc/wechat-claw.env
  -h, --help                Show help

Examples:
  deploy/release-wechat-claw.sh root@139.196.140.215
  deploy/release-wechat-claw.sh root@139.196.140.215 .env
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

exec "${script_dir}/sync-wechat-claw-env.sh" --deploy "$@"
