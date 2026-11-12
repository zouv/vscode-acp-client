---
name: release
description: 一键发布当前仓库：读取仓库自己的发布约定，更新版本与 CHANGELOG、构建回归、打包、提交并推送 main 与 vX.Y.Z 标签，并通过 GitHub CLI 上传 Release 资产。仅在用户明确输入 /release X.Y.Z 或明确要求整套发版时使用，不要自动触发。
---

# release · 发布当前仓库

> **输入**：`$ARGUMENTS` 必须是 `X.Y.Z`，例如 `/release 0.4.0`。下文 `$VERSION` 指该参数；执行前先 `VERSION="$ARGUMENTS"`。
>
> **适配原则**：本技能跨仓库复用，**不要照搬 DeskPins 的路径**。先读本仓库 `AGENTS.md` / `README.md` / `package.bat` / `manager.sh` / `scripts/`，以仓库自己的发布说明为准。仓库已有更专门的 `*-release` / `*-publish` 技能时，优先按那些技能执行，本技能只做总编排。
>
> 用户输入本命令即授权：修改版本与 CHANGELOG、提交推送、创建标签、打包上传。仍禁止强推、改写已推送历史、提交凭据 / 用户数据 / 本机路径，或结束用户未确认的应用进程。

## 0. 前置检查与仓库画像（失败即停）

1. 位于项目根、分支为 `main`：
   ```bash
   git rev-parse --show-toplevel
   git branch --show-current
   ```
   不是 main 则停止。
2. 版本参数匹配 `^[0-9]+\.[0-9]+\.[0-9]+$`，且高于当前版本 / 最新标签。
3. 检查远程与 GitHub：
   ```bash
   git remote get-url origin
   gh auth status
   gh repo view --json nameWithOwner -q .nameWithOwner
   ```
   origin 与 `gh` 当前仓库不一致则停止。
4. 检查工作树；出现凭据、`.env`、`.runtime/`、`dist/`、`bin/`、`obj/`、用户数据、日志或本机绝对路径时停止，不得提交。
5. 读取发布约定：
   ```bash
   rg -n "发布|release|package|打包|版本" AGENTS.md README.md | head -80
   ls package.bat manager.sh scripts 2>/dev/null
   ```
6. 识别版本来源与工具链（按实际存在的文件，不要假设）：
   - .NET：`Directory.Build.props` 或 `*.csproj` 的 `<Version>`；测试 / 打包入口通常是 `scripts/build.ps1`、`package.ps1`、`package.bat`、`manager.sh package`；产物通常在 `dist/dev` / `dist/release`。
   - Tauri / Node：`package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`Cargo.lock`；打包入口通常是 `package.bat`、`pnpm tauri:build`、`npm run ...`，产物可能在 `dist/release` 或 `src-tauri/target/release/bundle`。
   - VS Code 扩展：`package.json` 的 `version`；打包入口通常是 `scripts/package-vsix.mjs` 或 `npm run ...`；产物是 `.vsix`。
   - Rust：`Cargo.toml` / `Cargo.lock`；按仓库脚本打包。
7. 检查运行实例与打包脚本的关闭逻辑；若脚本会询问关闭正在运行的应用，停止并让用户手动关闭后重跑。**不要**自动输入 Y，也不要 `Stop-Process` / `taskkill`。
8. 确认 `CHANGELOG.md` 有 `## [未发布]` 或 `## [Unreleased]` 且正文非空；为空则停止。

## 1. 更新版本与 CHANGELOG

1. 按仓库文档更新**所有**版本落点（.NET 通常是 props/csproj；Tauri 可能同时包含 `package.json`、`package-lock.json`、`tauri.conf.json`、`Cargo.toml`、`Cargo.lock`；VS Code 是 `package.json`）。不要只改一处。
2. 用仓库提供的版本检查命令复核，例如 `dotnet msbuild ... -getProperty:Version`、`node -p "require('./package.json').version"`、`grep '^version' Cargo.toml`。
3. 用 Edit 把 `CHANGELOG.md` 的 `## [未发布]` 或 `## [Unreleased]` 改为 `## [$VERSION] - YYYY-MM-DD`（当天日期）。不要保留空标题。
4. 提取 Release Notes 到忽略目录：
   ```bash
   VERSION="$ARGUMENTS"
   mkdir -p .runtime
   sed -n "/^## \[$VERSION\]/,/^## \[/p" CHANGELOG.md | sed '$d' > .runtime/release-notes.md
   ```
   检查非空。
5. 运行 `sh check-docs.sh`（如果存在）和 `git diff --check`。

## 2. 构建、回归、打包

1. 运行仓库文档指定的测试 / 校验命令（`manager.sh verify`、`scripts/build.ps1`、`npm test`、`npm run typecheck` 等）。失败即停止，不提交。
2. 运行仓库文档指定的打包命令；失败时保留工作树，报告日志路径。若因运行实例占用而失败，让用户关闭后重跑，不要强杀。
3. 校验产物存在且版本一致：查看 `dist/release`、`src-tauri/target/release/bundle` 或仓库文档指定目录，记录实际文件、大小与校验和。不要上传 Debug / 中间目录，除非仓库发布约定明确要求。

## 3. 提交、标签与推送

1. 再次检查 `git status --porcelain`，确认只包含本次发版文件。
2. 暂存并检查：
   ```bash
   git add -A
   git diff --cached --check
   git diff --cached --stat
   ```
   浏览 staged 内容，确认无凭据、个人路径、用户数据、日志、二进制产物。
3. 按仓库约定提交（标题用 `变更：发布 <项目> $VERSION` 或仓库已有前缀；按当前会话要求附署名）：
   ```bash
   git commit -m "变更：发布 <项目> $VERSION" \
              -m "Co-Authored-By: Claude Code <noreply@anthropic.com>"
   ```
4. 创建并推送标签，再推送 main：
   ```bash
   git tag -a "v$VERSION" -m "<项目> $VERSION"
   git push origin main
   git push origin "v$VERSION"
   ```
   推送失败时停止，不要 `--force`。确认 HEAD 与标签指向同一提交。

## 4. 上传 GitHub Release

1. 按仓库发布文档确定资产清单；常见为 Release zip / 安装包 / VSIX，加 `SHA256SUMS.txt` 或 manifest。不要凭猜测上传无关文件。
2. 如果 `gh release view "v$VERSION"` 已存在：
   ```bash
   gh release upload "v$VERSION" <assets...> --clobber
   gh release edit "v$VERSION" --title "<项目> $VERSION" --notes-file .runtime/release-notes.md
   ```
   否则：
   ```bash
   gh release create "v$VERSION" <assets...> \
     --title "<项目> $VERSION" --notes-file .runtime/release-notes.md
   ```
3. `gh release view "v$VERSION" --json tagName,url,assets` 核验资产名、大小与标题。上传失败时保留已推送提交和标签，报告可重试命令，不回滚、不强推。

## 5. 收尾

报告版本、提交 / 标签、Release URL、实际资产、测试与打包结果。未实测项（真实桌面、DPI、外部互通等）不要写成已验证。任何一步失败都停在失败点，说明哪些操作已生效。
