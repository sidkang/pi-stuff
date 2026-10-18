#!/usr/bin/env bash

# Revoke local auth and delete the auth file only.
# Does not delete this skill directory.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_ENTRY="$SCRIPT_DIR/quark-drive.cjs"

info() { printf '[info]  %s\n' "$*"; }
warn() { printf '[warn]  %s\n' "$*"; }

if [ -f "$CLI_ENTRY" ]; then
  if node "$CLI_ENTRY" logout >/dev/null 2>&1; then
    info "已撤销本机授权并删除授权文件"
  else
    warn "撤销授权失败（可能未登录或网络异常）"
  fi
else
  info "未找到 CLI，跳过授权撤销"
fi
