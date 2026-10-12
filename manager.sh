#!/usr/bin/env bash
# =============================================================================
# manager.sh — 统一管理脚本（Node / npm 版）
#
# 用法：sh manager.sh <command>
#       sh manager.sh help        # 列出全部命令
#
# 说明：本脚本只做「命令转发 + 少量编排」，构建与测试的**单一源**仍是
# package.json 的 scripts 与 scripts/*.mjs。改流程改那边，别在这里另写一套。
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

info() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*" >&2; exit 1; }

ensure_deps() {
  [ -d node_modules ] || { info "node_modules 不存在，先跑 npm install"; npm install || fail "npm install 失败"; }
}

cmd_help() {
  cat <<'EOF'
统一管理脚本 · 命令一览

  开发
    dev            编译后启动 Extension Development Host（= npm run dev:host）
    watch          增量构建（= npm run watch）

  构建
    build          开发构建（= npm run compile）
    package        生产构建（= npm run package）

  校验
    lint           ESLint，零警告闸门（= npm run lint）
    typecheck      tsc --noEmit（= npm run typecheck）
    test-unit      vitest 纯逻辑测试，秒级（= npm run test:unit）
    test           编译 + lint + 真实 Extension Host 测试（= npm test）
    verify         一次跑齐 lint + typecheck + test-unit + test
    docs          文档体系机械体检（= sh check-docs.sh）

  其它
    vsix           打包成 .vsix（npx vsce package）
    clean          删除构建产物 dist/ 与 out/（不动 node_modules）
    help           显示本帮助
EOF
}

cmd_dev() { ensure_deps; info "启动开发宿主"; npm run dev:host; }
cmd_watch() { ensure_deps; npm run watch; }
cmd_build() { ensure_deps; npm run compile; }
cmd_package() { ensure_deps; npm run package; }
cmd_lint() { ensure_deps; npm run lint; }
cmd_typecheck() { ensure_deps; npm run typecheck; }
cmd_test_unit() { ensure_deps; npm run test:unit; }
cmd_test() { ensure_deps; npm test; }

cmd_verify() {
  ensure_deps
  info "1/4 lint";      npm run lint       || fail "lint 未通过"
  info "2/4 typecheck"; npm run typecheck  || fail "类型检查未通过"
  info "3/4 test:unit"; npm run test:unit  || fail "纯逻辑测试未通过"
  info "4/4 test";      npm test           || fail "宿主测试未通过"
  info "全部通过 ✅"
}

cmd_docs() { sh check-docs.sh; }

cmd_vsix() {
  ensure_deps
  info "打包 .vsix"
  npx vsce package || fail "vsce package 失败"
}

cmd_clean() {
  info "清理 dist/ 与 out/"
  rm -rf dist out
}

case "${1:-help}" in
  dev)        cmd_dev ;;
  watch)      cmd_watch ;;
  build)      cmd_build ;;
  package)    cmd_package ;;
  lint)       cmd_lint ;;
  typecheck)  cmd_typecheck ;;
  test-unit)  cmd_test_unit ;;
  test)       cmd_test ;;
  verify)     cmd_verify ;;
  docs)       cmd_docs ;;
  vsix)       cmd_vsix ;;
  clean)      cmd_clean ;;
  help|-h|--help) cmd_help ;;
  *) printf '\033[1;31m[FAIL]\033[0m 未知命令：%s\n\n' "$1" >&2; cmd_help; exit 1 ;;
esac
