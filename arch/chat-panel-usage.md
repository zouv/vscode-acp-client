> **分册导航**：本文件是 `ARCHITECTURE.md` §5.x 的分册之一（§5.59），由 [`chat-panel.md`](./chat-panel.md)
> 顶部的导航表指向。任务路由见 [`../ARCHITECTURE.md`](../ARCHITECTURE.md) §0.5。
> 纪律同分册群：**优先按函数名搜索、不依赖行号**；改了代码结构就同步本文件。
>
> 从 `chat-panel-input.md` 拆出（2026-11-12）：原分册超过 25,000 字上限，按 §1.1 把上下文用量
> Tip 一节独立出来。**§5.x 编号不重排**（代码与文档里有大量按编号的引用）。

### 5.59 上下文用量 Tip：点圆环弹出图表（2026-11-12）

用户要求：输入框里的上下文圆环支持点击，点击后在上方弹出 Tip 界面，以图表方式显示相关信息。

| 关注点 | 规则 |
|---|---|
| 圆环是入口 | `#contextMeter` 从 `div` 改成 `<button type="button">`（键盘可到达，`aria-haspopup="dialog"` / `aria-expanded` 由 client 维护）。不打开时 `title` 仍是那一行文本；`hidden` 判据不变（`!usage.size`）。 |
| 谁产出数据 | 宿主 `usage/ContextStats.ts`（纯逻辑，不 import vscode）。`usage_update` 是 `used/size/cost/model/rateLimit` 的唯一写入者；`PromptResponse.usage` 是**本轮**累计（claude-agent-acp 在轮次激活时重置 `accumulatedUsage`，一轮内多条 assistant result 会 `+=`），直接记成 `lastTurn`，并给 `history` 追加一个采样点。**任何统计字段都不写回 `used`**（§4「上下文圆环只认 usage_update」）。 |
| 压缩标记 | `compaction_update` 终态且无 `error` → `noteCompaction` 记下所处轮次；曲线在该轮画竖虚线 + ▼。失败压缩不算（上下文没被换掉）。 |
| 速率额度 | `usage_update._meta["_claude/rateLimit"]`（此前主会话分支直接丢弃）→ 按 `rateLimitType` 保留最新一份，Tip 里画进度条；没有这份数据就整块不显示。 |
| 子 agent 成本 | `AgentMapStore.totalCostUsd(rootId)` 扁平遍历求和，`metaOf` 合并到 `usage.subagentCostUsd`。 |
| 圆环双色（2026-11-12） | 适配器在 `usage_update._meta["_claude/usage"]` 里给最近一次调用的四项拆分（claude-agent-acp fork 的 `attachUsageModel`；压缩后 `lastAssistantUsage` 为 null，不带）。宿主 `contextUsageParts()` 转成 `usage.parts`，客户端把内环画成两段：提示段（input + cache read/write，沿用 warn/hot 阈值色）+ 输出段（output，固定绿）。**没有 parts 就退回单色**（旧适配器）；结构只在 `size` 或 hasParts 变化时重建，used / 弧长都走属性更新（外圈动画不重启）。 |
| 两个口径必须写明 | `parts` / 圆环 = **最近一次模型调用**（last call）；Tip 的 `This turn` = **本轮所有调用之和**（all calls，工具循环会重复读缓存）。Tip 标题与头部分别标注 `all calls` / `last call:`，避免把 45.4k 的累计缓存读误读成上下文占用。 |
| 客户端 | `html/client/contextTip.ts`：面板 `#contextTip` 在 `.composer-inner` 里、与 `#agentMapPanel` 同一位置家族。**关闭时不渲染也不量布局**；打开时按**结构签名**去重（used / size / 两段拆分的数值变化走 `updateLive` 原地更新，不重建面板），流式期间不重建（与圆环同一条教训）。图表全部手写 SVG，颜色走 `--vscode-charts-*`。 |
| 数据来源唯一 | `composer.renderContext` 是 Tip 的唯一数据入口（`NS.contextTip.setUsage(sessionId, usage)`），`setRunning` 同步 `/compact` 的可用性。Tip 不自己缓存第二份逻辑状态（pitfall #19）。 |
| 两个动作 | `/compact` = `sendPrompt` 发文本（轮次进行中禁用，宿主会拒绝第二个 prompt）；「Usage dashboard ↗」= 非会话作用域的 `openDashboard` 消息 → `vac-dashboard.focus`。 |
| 恢复会话 / 重启 | `ContextStats` 是宿主内存态，重启或重开历史后 `turns/history` 从 0 开始（Tip 只描述本窗口观察到的部分），不伪造历史。 |
| Tip 贴圆环（2026-11-12 修复） | 面板不按 `.composer-inner` 的 `right:0` 对齐整卡，而是在打开时量圆环与定位祖先的 rect：`right = 祖先右缘 − 圆环右缘`、`bottom = 祖先底边 − 圆环顶 + 6px`（`positionTip`）。窗口 resize / 输入卡高度变化（ResizeObserver）重算；rect 全 0（未布局）时保留 CSS 回退。 |
| 斜杠面板只看第一行（2026-11-12 修复） | `currentQuery` 只读 **第一行**（多行草稿下面有空格不再让面板弹不出来）；光标不在第一行时不弹；光标恰在 `/` 之后（`selectionStart === 1`）时显示全部命令。`acceptSlash` 只替换第一行，保留其余行。 |
