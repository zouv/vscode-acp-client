# 连接超时与崩溃恢复（2026-11-02）

入口：ARCHITECTURE §2.1–2.3；不读 ChatPanelHost 全文件。

## 定位

| 职责 | 文件 / 函数 |
|---|---|
| 握手超时 | core/ConnectionManager.connect → utils/AsyncDeadline.withDeadline |
| 取消/晚到防护 | core/AgentConnector.ensure / cancel / ensureOnce |
| 崩溃暂停 | core/SessionManager.suspendAgent / canRecover |
| 恢复任务 | SessionManager.startRecovery / recoverAgent / resumeRetainedSession / resumeRetainedSessionOnce |
| 退避预算 | core/AgentRecovery.RecoveryBudget / recoveryDelay |
| 手动重连 | SessionManager.ensureConnected / connectToAgent / openExistingSession |
| Side fork | SessionManager.requestFork / forkSideSession；UI 由 SideChatPanel.open 调用 |
| Side 关闭 | SideChatPanel.close / closeGroup / closeAll → SessionManager.deleteSession；close/delete 前复用 cancelTurn 与两桥结算 |
| 配置通知/取消 | extension.activate 的 agentConfigListener |
| 回归 | test/recovery-regression.test.ts；core/AgentRecovery.spec.ts；utils/AsyncDeadline.spec.ts |

## 契约

- initialize 默认 60s，vac.connectionTimeoutMs 可设 1–300s；超时清 pending terminals，connector 杀掉进程。主动取消优先拒绝，晚到成功不登记。
- vac.autoReconnect 默认 true。仅意外退出、已有会话且缓存能力支持 session/resume 时恢复；load-only agent 继续手动历史恢复，不自动回放。
- 退避 1s/3s/8s，最多三次；成功后连续稳定 60s 才重置预算，防止反复崩溃造成无限重试。
- suspend 不 emit session-closed、不改焦点：保留同一 SessionInfo、tab、transcript、草稿与选择；释放旧 connection ownership，结算权限/表单与旧轮次。
- 不重发 prompt、不继续上一轮工具，不走 unattended auth retry。认证/会话不存在/仍在线的 resume RPC 出错立即停止；连接再次退出才继续剩余预算。
- resume 默认 30s 超时；自动恢复失败清连接并杀进程，手动恢复超时也停止进程，均保留离线 tab。显式 Connect 可认证并恢复离线对象；Disconnect 才关闭其 tab。
- 同 retained SessionInfo / 同 ConnectionInfo 的并发手动恢复共享一次 resume；失败释放共享任务，可再次显式重试，不与新连接混用。
- 同 agent、同一个 retained SessionInfo 对象且 resume 成功后，才更新 agentId/能力并 claim 新 owner；禁止放宽 SessionStore.add 的跨连接覆盖禁令。
- 恢复过程中关闭的会话不复活；用户切换的焦点不被恢复抢走。旧 prompt 的晚到响应不能结束新连接上的轮次。
- Disconnect / dispose / 关闭 autoReconnect 取消延时和握手，不再启动后台恢复；dispose 不发失败通知。配置变更只提示 Reload Window，不自动重载。
- Side 与普通 fork 共用 `requestFork` 的 live 主会话、agent 归属和 fork capability 校验，并通过 `connector.enqueue` 在同一连接调用 `unstable_forkSession`。Side 不传 messageId，从打开时末尾派生；不 load/resume/focus/写历史，`SessionInfo.sideChat` 记录源 sessionId 与 forkedAt。
- `forkSideSession` 注册后立即 emit `session-created(..., 'side')`；`getMainLiveSessions` 与默认 `getSessionIdsForAgent` 排除 Side，ownership、通知和 transcript 活跃集合仍包含它。`SessionStore.focus` 拒绝 Side，后继焦点跳过 Side。
- SideChatPanel 只在 fork 成功后登记成员并创建/复用单个多标签面板；每次 open 都产生独立 Side，创建/attach/activate 失败只回滚本次新 Side，fork 在途时 dispose 或源已关闭会删除晚到 Side。活动 tab 关闭优先选右邻、否则左邻，最后一个 tab 才销毁面板；源关闭批量清理其子 Side。关闭先移除成员防重入，再 `deleteSession`：待决权限/表单先结算，有在途轮次先 `cancelTurn`，然后 close（能力允许）、best-effort delete 与本地 forget。
- 不支持 fork 时不创建空 Side；不支持 delete 或厂商删除失败不阻断本地清理，但不能据此承诺厂商磁盘转录或 `session/list` 无残留。

## 边界

真实 Claude/Codex 认证、session/resume 的厂商持久化与真实账号 Webview 交互验收另做；替身回归不能代替这些验收。记录区真实 Chromium 已验证缓存保留选区与流式预览不读全文，预览不等于账号验收。
测试工具与宿主分离：Node≥22.13 构建期打包 SDK 与 Mocha 串行 API供 Node18 宿主运行；移除旧 CLI 后升级开发依赖，全量/生产 audit 均为 0。最低 VS Code 1.85 的真实宿主回归仍是兼容性闸门。
