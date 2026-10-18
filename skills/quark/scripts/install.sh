#!/usr/bin/env bash

# Safe local preflight only.
# This script deliberately does not install Node.js, download archives,
# call remote configuration endpoints, or update any files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
REQUIRED_NODE_MAJOR=16

error() { printf '[error] %s\n' "$*" >&2; }
info() { printf '[info]  %s\n' "$*"; }

case "$(uname -s)" in
  Darwin*) OS_TYPE='macOS' ;;
  Linux*) OS_TYPE='Linux' ;;
  CYGWIN*|MINGW*|MSYS*) OS_TYPE='Windows' ;;
  *) error "不支持的操作系统: $(uname -s)"; exit 1 ;;
esac

if ! command -v node >/dev/null 2>&1; then
  error "未检测到 Node.js，请手动安装 Node.js ${REQUIRED_NODE_MAJOR}+ 后重试"
  exit 1
fi

NODE_VERSION="$(node --version 2>/dev/null || true)"
NODE_MAJOR="${NODE_VERSION#v}"
NODE_MAJOR="${NODE_MAJOR%%.*}"
if ! [[ "$NODE_MAJOR" =~ ^[0-9]+$ ]] || [ "$NODE_MAJOR" -lt "$REQUIRED_NODE_MAJOR" ]; then
  error "Node.js 版本过低: ${NODE_VERSION:-未知}，需要 ${REQUIRED_NODE_MAJOR}+"
  exit 1
fi

for required in \
  "$SCRIPT_DIR/quark-drive.cjs" \
  "$SCRIPT_DIR/hash-worker.cjs" \
  "$SKILL_DIR/SKILL.md"; do
  if [ ! -f "$required" ]; then
    error "缺少必要文件: $required"
    exit 1
  fi
done

info "环境检查通过: ${OS_TYPE}, Node.js ${NODE_VERSION}"
info "安全模式已启用：不会自动安装、联网更新或覆盖文件"
exit 0
