#!/usr/bin/env bash
# =============================================================================
# check-docs.sh — 文档体系「机械体检」（技术栈无关；初始化后请务必保留本文件）
#
# 用法：
#   sh check-docs.sh          完整体检（Windows: git-bash / WSL / Linux / macOS 均可）；有 FAIL 时退出码为 1
#   sh check-docs.sh --strict 严格模式：README / .gitignore 内容 / 版本标记 / TODO 占位符等 WARN 项也判 FAIL
#   sh check-docs.sh --hook   给 Claude Code PostToolUse hook 用（见 .claude/settings.json）：
#                             从 stdin 读 hook 输入，刚改的文档超出体量上限时提醒 AI，否则静默
#
# 定位：整套文档体系靠 AI 自觉维护，本脚本补上「脚本能判的」硬兜底——
#   占位符 / 初始化块残留、根文档缺失、README / .gitignore / 版本标记、文档体量超标、脚本换行、
#   manager.sh help 与 README 命令表是否一致、CHANGELOG 疑似漏记。
#   ⚠ 只查机械可判的项；语义漂移（图谱 ↔ 代码是否对得上）仍需跑 doc-audit 由 AI 核对。
#
# 体量按 UTF-8 字符计（上限与理由见 AGENTS.md §1.1）：按行数计会被「把内容挤进超长行」绕过；
#   也不用 `wc -m`，因为 Windows Git Bash 默认 locale 下它数的是字节。
# 跨技术栈说明：本脚本纯 bash、无 uv/dotnet 依赖，重写 manager.sh 换栈时不要删它。
# =============================================================================
# 被 `sh check-docs.sh` 调起且 sh 不是 bash（如 Debian 的 dash）时，自动改用 bash 重跑。
if [ -z "${BASH_VERSION:-}" ]; then exec bash "$0" "$@"; fi
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "${ROOT}"

AGENTS_MAX_LINES=200
ARCH_MAX_CHARS=25000     # ARCHITECTURE.md 与每份 arch/*.md
HANDOFF_MAX_CHARS=8000
ROADMAP_MAX_CHARS=10000

STRICT=0
if [ "${1:-}" = "--strict" ]; then STRICT=1; shift; fi

ROOT_DOCS=(AGENTS.md ARCHITECTURE.md ROADMAP.md CHANGELOG.md HANDOFF.md README.md)

# .NET 项目的 bin/obj 是构建产物；其它类型（如 node-cli）的 bin/ 可能是源码，不能一律排除。
DOC_TYPE="$(sed -n 's/^type=//p' .vibe-template 2>/dev/null | head -n1)"
BASE_TYPE="$(sed -n 's/^base_type=//p' .vibe-template 2>/dev/null | head -n1)"
case "${DOC_TYPE}:${BASE_TYPE}" in
  *desktop-csharp*|*dotnet*) DOTNET_PROJECT=1 ;;
  *)                         DOTNET_PROJECT=0 ;;
esac

# 工作区文本文件匹配（可移植：find -print0 + grep -Il，不依赖 grep -Z / 选项后置）。
# 用法：_workspace_matches <ERE 模式> [--fixed]
_workspace_matches() {
  local pattern="$1" mode="${2:-ere}"
  local -a expr=(-name .git -o -name node_modules -o -name .venv -o -name dist -o -name build
                 -o -name target -o -name .runtime -o -name __pycache__ -o -name .next
                 -o -name out -o -name coverage -o -name htmlcov -o -name .vscode-test
                 -o -name release -o -name .claude)
  if [ "${DOTNET_PROJECT}" = "1" ]; then expr+=(-o -name bin -o -name obj); fi
  if [ "${mode}" = "fixed" ]; then
    find . \( "${expr[@]}" \) -prune -o -type f -print0 2>/dev/null |
      xargs -0 grep -IlF -e "${pattern}" 2>/dev/null || true
  else
    find . \( "${expr[@]}" \) -prune -o -type f -print0 2>/dev/null |
      xargs -0 grep -IlE -e "${pattern}" 2>/dev/null || true
  fi
}

# 按 UTF-8 字符计数：删掉续字节（0x80–0xBF）后数字节，结果与 locale 无关。
count_chars() { LC_ALL=C tr -d '\200-\277' < "$1" | wc -c | tr -d ' '; }

# 文件的体量上限；不受体量约束的文件输出空串。
limit_of() {
  case "$1" in
    ARCHITECTURE.md|arch/*.md) echo "${ARCH_MAX_CHARS}" ;;
    HANDOFF.md)                echo "${HANDOFF_MAX_CHARS}" ;;
    ROADMAP.md)                echo "${ROADMAP_MAX_CHARS}" ;;
    *)                         echo "" ;;
  esac
}

advice_of() {
  case "$1" in
    HANDOFF.md) echo "按 AGENTS.md §5.0 去向表把不属于这里的内容迁走（长期的坑与理由 → ARCHITECTURE §7，已完结的 → 删除）" ;;
    ROADMAP.md) echo "已交付里程碑的大纲条目删掉，在「已交付里程碑」压成一行（AGENTS.md §5.2）" ;;
    arch/*.md)  echo "按子模块继续拆分，并在 ARCHITECTURE §0.5 路由表里指向新分册（AGENTS.md §1.1）" ;;
    *)          echo "按 AGENTS.md §1.1 拆分到 arch/<module>.md，总览只留 §0 / §0.5 / §1" ;;
  esac
}

# ----------------------------------------------------------------------------- #
# --hook：PostToolUse 模式。只看这次改的那个文件（AGENTS / ARCHITECTURE / arch/* / HANDOFF / ROADMAP），
#   超标时用 additionalContext 提醒 AI；其它文件、未超标都静默退出。
# ----------------------------------------------------------------------------- #
if [ "${1:-}" = "--hook" ]; then
  grep -q 'AI-INIT-STAR[T]' AGENTS.md 2>/dev/null && exit 0   # 文档体系尚未初始化，不打扰
  input="$(cat)"
  path="$(printf '%s' "${input}" | grep -o '"file_path"[[:space:]]*:[[:space:]]*"[^"]*"' | head -n1 \
          | sed -e 's/^"file_path"[[:space:]]*:[[:space:]]*"//' -e 's/"$//' -e 's#\\\\#/#g')"
  [ -n "${path}" ] && [ -f "${path}" ] || exit 0
  case "${path}" in
    */arch/*.md) rel="arch/${path##*/arch/}" ;;
    *)           rel="${path##*/}" ;;
  esac
  if [ "${rel}" = "AGENTS.md" ]; then
    n="$(awk 'END { print NR }' "${path}")"
    [ "${n}" -gt "${AGENTS_MAX_LINES}" ] || exit 0
    msg="AGENTS.md 现在 ${n} 行，超过 ${AGENTS_MAX_LINES} 行上限：删过时规则，只对部分代码生效的规则下沉到 ARCHITECTURE 对应小节（AGENTS.md §1.1）。"
  else
    max="$(limit_of "${rel}")"
    [ -n "${max}" ] || exit 0                      # 不是受体量约束的文档
    n="$(count_chars "${path}")"
    [ "${n}" -gt "${max}" ] || exit 0
    msg="${rel} 现在 ${n} 字，超过 ${max} 字上限：$(advice_of "${rel}")。"
  fi
  printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"check-docs: %s"}}\n' "${msg}"
  exit 0
fi

# ----------------------------------------------------------------------------- #
# 完整体检
# ----------------------------------------------------------------------------- #
fail=0
warn=0
bad() { printf '\033[1;31m[FAIL]\033[0m %s\n' "$*"; fail=$((fail+1)); }
wrn() {
  if [ "${STRICT}" = "1" ]; then
    printf '\033[1;31m[FAIL]\033[0m %s\n' "$*"
    fail=$((fail+1))
  else
    printf '\033[1;33m[WARN]\033[0m %s\n' "$*"
    warn=$((warn+1))
  fi
}
ok()  { printf '\033[1;32m[ ok ]\033[0m %s\n' "$*"; }

# 0. 若 AGENTS.md 里还有 AI-INIT 一节 = 未初始化 → 提示先初始化，跳过体检。
if grep -q 'AI-INIT-STAR[T]' AGENTS.md 2>/dev/null; then
  wrn "AGENTS.md 里还有 AI-INIT 一节：项目尚未初始化。请先让 AI 按它执行初始化（或说「初始化文档」触发 init-docs），再体检。"
  [ "${STRICT}" = "1" ] && exit 1
  exit 0
fi

# 1. 占位符 / AI-INIT 残留（已初始化项目里一处都不该有）。
#    扫工作区文本文件；排除依赖 / 构建产物 / 模板自带技能 / VS Code 测试缓存；正则只认大写占位符。
residue=0
while IFS= read -r f; do
  bad "占位符 / AI-INIT 残留：${f#./}（$(grep -cE '\{\{[A-Z0-9_]+\}\}|AI-INIT-STAR[T]' "${f}") 处，初始化没做干净）"
  residue=1
done < <(_workspace_matches '\{\{[A-Z0-9_]+\}\}|AI-INIT-STAR[T]')
[ "${residue}" -eq 0 ] && ok "无占位符 / AI-INIT 残留"
# TODO-author 是旧版 init.sh 的遗留值，不是合法占位符，单独扫（排除本脚本，避免匹配到检查文案）。
todo=0
while IFS= read -r f; do
  case "${f}" in ./check-docs.sh) continue ;; esac
  bad "遗留 TODO-author：${f#./}（用真实作者名或作者占位符替换）"
  todo=1
done < <(_workspace_matches 'TODO-autho[r]')
[ "${todo}" -eq 0 ] && ok "无 TODO-author 遗留"

# 2. 根文档齐全；CLAUDE.md 必须导入 AGENTS.md（上层目录有 CLAUDE.md 时，Claude Code 不会自己读 AGENTS.md）；
#    模板生成的 .gitignore / .gitattributes / .vibe-template 存在（旧项目可能没有，只提醒）。
for f in "${ROOT_DOCS[@]}"; do
  [ -f "${f}" ] || bad "缺少根文档：${f}"
done
if [ ! -f CLAUDE.md ]; then
  bad "缺少 CLAUDE.md（内容一行：@AGENTS.md）"
elif ! grep -q '^@AGENTS\.md' CLAUDE.md; then
  bad "CLAUDE.md 没有 @AGENTS.md 导入：Claude Code 读不到 AGENTS.md"
fi
[ -f .gitignore ]   || wrn "缺少 .gitignore（应忽略 .env / .runtime/ / 依赖与构建产物）"
[ -f .vibe-template ] || wrn "缺少 .vibe-template（可能不是由 vibe-coding-starter/init.sh 生成，或早于 2026-10-31 的版本）"
[ -f .gitattributes ] || wrn "缺少 .gitattributes（换行约定：*.sh 为 LF、*.bat 为 CRLF）"
if [ -f .gitattributes ]; then
  grep -qE '^\*\.sh[[:space:]]+text[[:space:]]+eol=lf' .gitattributes \
    || bad ".gitattributes 缺少 '*.sh text eol=lf'：Windows 检出的 CRLF 脚本在 WSL / macOS / Linux / CI 上会直接报错"
  grep -qE '^\*\.bat[[:space:]]+text[[:space:]]+eol=crlf' .gitattributes \
    || wrn ".gitattributes 没有 '*.bat text eol=crlf'（项目没有 .bat 可忽略）"
fi
if [ -f .gitignore ]; then
  grep -qE '^\.env($|/|\*)' .gitignore \
    || wrn ".gitignore 没有忽略 .env（真实密钥 / 本机配置不得入库）"
  grep -qE '^\.runtime/?$' .gitignore \
    || wrn ".gitignore 没有忽略 .runtime/（PID / 日志 / 临时文件）"
  if [ -f package.json ] || [ -f web/package.json ]; then
    grep -qE '^node_modules/?$' .gitignore \
      || wrn ".gitignore 没有忽略 node_modules/"
  fi
  if [ -f pyproject.toml ]; then
    grep -qE '^\.venv/?$' .gitignore \
      || wrn ".gitignore 没有忽略 .venv/"
  fi
fi
# 版本标记：.vibe-template 与 AGENTS.md 文末标记应存在且一致（旧项目可能没有，只提醒）。
if [ -f .vibe-template ]; then
  vt_version="$(sed -n 's/^template_version=//p' .vibe-template | head -n1)"
  agents_version="$(sed -n 's/^<!-- vibe-coding-starter \([^ ]*\) ·.*/\1/p' AGENTS.md 2>/dev/null | tail -n1)"
  if [ -z "${vt_version}" ]; then
    wrn ".vibe-template 缺少 template_version（无法判断是否需要升级）"
  elif ! printf '%s' "${vt_version}" | grep -qE '^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$'; then
    wrn ".vibe-template 的 template_version 格式不合法：${vt_version}"
  fi
  if [ -n "${vt_version}" ] && [ -n "${agents_version}" ] && [ "${vt_version}" != "${agents_version}" ]; then
    wrn "AGENTS.md 版本标记 (${agents_version}) 与 .vibe-template (${vt_version}) 不一致"
  elif [ -z "${agents_version}" ]; then
    wrn "AGENTS.md 文末缺少 '<!-- vibe-coding-starter <版本> ·' 标记"
  fi
fi
# hook：存在 Claude Code 设置时，确认它确实调用 check-docs.sh --hook。
if [ -f .claude/settings.json ]; then
  if ! grep -q 'check-docs\.sh' .claude/settings.json || ! grep -q -- '--hook' .claude/settings.json; then
    wrn ".claude/settings.json 没有调用 check-docs.sh --hook（文档改动不会自动体检）"
  fi
fi

# 3. 体量（超标 = FAIL：只给 WARN 已被证明会被忽略）。
if [ -f AGENTS.md ]; then
  n="$(awk 'END { print NR }' AGENTS.md)"
  if [ "${n}" -gt "${AGENTS_MAX_LINES}" ]; then
    bad "AGENTS.md ${n} 行 > ${AGENTS_MAX_LINES}：删过时规则，局部规则下沉到 ARCHITECTURE（AGENTS §1.1）"
  else
    ok "AGENTS.md ${n} 行 ≤ ${AGENTS_MAX_LINES}"
  fi
fi
for f in ARCHITECTURE.md arch/*.md HANDOFF.md ROADMAP.md; do
  [ -f "${f}" ] || continue
  max="$(limit_of "${f}")"
  n="$(count_chars "${f}")"
  if [ "${n}" -gt "${max}" ]; then
    bad "${f} ${n} 字 > ${max}：$(advice_of "${f}")"
  else
    ok "${f} ${n} 字 ≤ ${max}"
  fi
done

# 4. 脚本换行：*.sh 含 CRLF 在 WSL / macOS / Linux / CI 上会直接报错（Windows 的 autocrlf 检出会造成）。
crlf=0
while IFS= read -r f; do
  # 不用 grep：Windows 的 MSYS grep 按文本模式读文件，会吞掉行尾的 \r。
  if [ "$(LC_ALL=C tr -cd '\r' < "${f}" | wc -c | tr -d ' ')" -gt 0 ]; then
    bad "脚本含 CRLF 换行：${f#./}（改回 LF：sed -i.bak 's/\r\$//' ${f#./} && rm -f ${f#./}.bak；并确认 .gitattributes 有 '*.sh text eol=lf'）"
    crlf=1
  fi
done < <(
  find . \( -name .git -o -name node_modules -o -name .venv -o -name dist -o -name build \
            -o -name target -o -name .runtime -o -name __pycache__ -o -name .next \
            -o -name out -o -name coverage -o -name htmlcov -o -name .vscode-test \
            -o -name release -o -name .claude \
            $([ "${DOTNET_PROJECT}" = "1" ] && printf '%s' '-o -name bin -o -name obj') \
          \) -prune -o -name '*.sh' -type f -print
)
[ "${crlf}" -eq 0 ] && ok "*.sh 均为 LF"

# 5. manager.sh help 与 README「manager.sh 命令」表一致（命令唯一来源是 manager.sh，README 手抄容易漂移）。
if [ -f manager.sh ] && [ -f README.md ]; then
  help_cmds="$(bash manager.sh help 2>/dev/null \
    | sed -nE 's/^[[:space:]]+([a-z][a-z0-9:_-]*)([[:space:]]+(\[[^]]*\]|<[^>]*>))?[[:space:]]{2,}.*$/\1/p' \
    | sort -u)"
  readme_cmds="$(awk '/^## .*manager\.sh/ {on=1; next} /^## / {on=0} on' README.md \
                 | sed -nE 's/^\| *`([a-z][a-z0-9:_-]*)[ `].*/\1/p' | sort -u)"
  if [ -z "${help_cmds}" ]; then
    wrn "跑不出 manager.sh help 的命令清单，跳过 README 命令表核对"
  elif [ -z "${readme_cmds}" ]; then
    wrn "README.md 里没找到命令表（标题含 manager.sh 的 ## 小节内、以 | \`命令\` | 开头的行），跳过核对"
  else
    only_help="$(comm -23 <(printf '%s\n' "${help_cmds}") <(printf '%s\n' "${readme_cmds}") | tr '\n' ' ')"
    only_readme="$(comm -13 <(printf '%s\n' "${help_cmds}") <(printf '%s\n' "${readme_cmds}") | tr '\n' ' ')"
    if [ -n "${only_help// /}" ] || [ -n "${only_readme// /}" ]; then
      bad "README 命令表与 manager.sh help 不一致：help 有而 README 无 [${only_help% }]；README 有而 help 无 [${only_readme% }]"
    else
      ok "README 命令表与 manager.sh help 一致"
    fi
  fi
fi

# 6. CHANGELOG 疑似漏记（软提示）：最近一次改动本项目的提交动了源码，却没动 CHANGELOG。
#    只看本项目目录（-- .），monorepo 里别的项目的提交不会干扰判断。
if command -v git >/dev/null 2>&1 && git rev-parse --git-dir >/dev/null 2>&1; then
  last="$(git log -1 --format=%H -- . 2>/dev/null || true)"
  if [ -n "${last}" ] && git rev-parse -q --verify "${last}^" >/dev/null 2>&1; then
    changed="$(git diff --name-only "${last}^" "${last}" -- . 2>/dev/null || true)"
    if printf '%s\n' "${changed}" | grep -qE '\.(py|cs|csproj|xaml|ts|tsx|js|jsx|mjs|vue|svelte|go|rs|java|kt|rb|php|swift|c|cc|cpp|h|ps1|sh|bat|iss)$' \
       && ! printf '%s\n' "${changed}" | grep -q 'CHANGELOG\.md'; then
      wrn "最近一次改动本项目的提交（${last:0:8}）改了源码但未动 CHANGELOG.md：确认是否漏记 [未发布]"
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
