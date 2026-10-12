#!/usr/bin/env bash
# =============================================================================
# check-docs.sh — 文档体系「机械体检」（技术栈无关；初始化后请务必保留本文件）
#
# 用法：sh check-docs.sh          （Windows: git-bash / WSL 均可）
#
# 定位：整套文档体系靠 AI 自觉维护，本脚本补上「脚本能判的」硬兜底——
#   占位符残留、文档体量超标、根文档缺失、CHANGELOG 疑似漏记。
#   ⚠ 只查机械可判的项；语义漂移（图谱↔代码是否对得上）仍需跑 doc-audit 由 AI 核对。
#
# 建议：接入 git pre-commit 或 CI，让「文档不腐化」从靠记性变成靠机制。
# 跨技术栈说明：本脚本纯 bash、无 uv/dotnet 依赖，重写 manager.sh 换栈时不要删它。
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

fail=0
warn=0
bad() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*"; fail=$((fail+1)); }
wrn() { printf '\033[1;33m[WARN]\033[0m %s\n' "$*"; warn=$((warn+1)); }
ok()  { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*"; }

ROOT_DOCS=(AGENTS.md ARCHITECTURE.md ROADMAP.md CHANGELOG.md HANDOFF.md)

# 0. 若仍是「未初始化模板」（存在 _TEMPLATE_README.md）→ 提示先初始化，跳过体检。
if [ -f _TEMPLATE_README.md ]; then
  wrn "检测到 _TEMPLATE_README.md：项目似乎尚未初始化。请先让 AI 执行初始化（或跑 init-docs），再体检。"
  exit 0
fi

# 1. 占位符 / AI-INIT 残留（已初始化项目里一处都不该有）
residue=0
for f in "${ROOT_DOCS[@]}" docs/*.md; do
  [ -f "${f}" ] || continue
  if grep -qE '\{\{|AI-INIT' "${f}"; then
    bad "占位符/AI-INIT 残留：${f}（初始化没做干净）"
    residue=1
  fi
done
[ "${residue}" -eq 0 ] && ok "无占位符 / AI-INIT 残留"

# 2. 根文档齐全
for f in "${ROOT_DOCS[@]}"; do
  [ -f "${f}" ] || bad "缺少根文档：${f}"
done

# 3. HANDOFF 体量 ≤ 150 行（超 = 堆积，开工前先瘦身）
if [ -f HANDOFF.md ]; then
  n=$(wc -l < HANDOFF.md | tr -d ' ')
  if [ "${n}" -gt 150 ]; then
    wrn "HANDOFF.md ${n} 行 > 150：堆积超标，核实 ROADMAP/CHANGELOG 有记录后删历史（AGENTS §5.4）"
  else
    ok "HANDOFF.md ${n} 行 ≤ 150"
  fi
fi

# 4. ARCHITECTURE 体量 ≤ 400 行（超 = 该拆分，否则自身变 token 黑洞）
if [ -f ARCHITECTURE.md ]; then
  n=$(wc -l < ARCHITECTURE.md | tr -d ' ')
  if [ "${n}" -gt 400 ]; then
    wrn "ARCHITECTURE.md ${n} 行 > 400：拆分到 arch/<module>.md，总览留路由（AGENTS §1.1）"
  else
    ok "ARCHITECTURE.md ${n} 行 ≤ 400"
  fi
fi

# 5. CHANGELOG 疑似漏记（软提示）：最近一次提交动了源码却没动 CHANGELOG
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  if git rev-parse HEAD~1 >/dev/null 2>&1; then
    changed="$(git diff --name-only HEAD~1 HEAD 2>/dev/null || true)"
    if printf '%s\n' "${changed}" | grep -qE '\.(py|cs|ts|tsx|js|jsx|go|rs|java|kt|rb|php|swift|c|cc|cpp|h)$' \
       && ! printf '%s\n' "${changed}" | grep -q 'CHANGELOG\.md'; then
      wrn "上一次提交改了源码但未动 CHANGELOG.md：确认是否漏记 [未发布]"
    fi
  fi
fi

printf '\n'
if [ "${fail}" -gt 0 ]; then
  printf '\033[1;31m✗ %d 项硬错误\033[0m，%d 项警告。语义漂移请再跑 doc-audit。\n' "${fail}" "${warn}"
  exit 1
else
  printf '\033[1;32m✓ 机械检查通过\033[0m（%d 项警告）。语义漂移请再跑 doc-audit。\n' "${warn}"
  exit 0
fi
