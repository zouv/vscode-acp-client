// 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 多会话标签行 + agent 选择器 + 会话头（标题 / usage 条）。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**。
export const tabsClient = `
(function (NS) {
  'use strict';

  var tabsEl = null;
  var stripEl = null;
  var agentBar = null;
  var agentSelect = null;
  var agentMenu = null;
  var tipEl = null;
  var cwdBtn = null;

  // [CUSTOM- 'drafts' are LOCAL tabs: a new session that does not
  // exist yet. They are client state on purpose — the host knows nothing about
  // them, so 'sessionsChanged' / 'boot' must never clear this list.
  var state = { sessions: [], focusedId: null, focusedAgent: null, drafts: [], focusedDraftId: null };
  // [CUSTOM- 「待恢复的会话」：本地 tab（宿主里还不存在），带 sessionId/agentName/cwd/title。
  // 与草稿一样是纯客户端状态 —— 点它才真去 load（懒恢复）；收到那个会话的 focus/sessionsChanged 时让位。
  var restoring = [];
  // [CUSTOM- 手工 tab 顺序（会话 id 数组）：宿主 globalState 里那份的本地副本
  // （uiPrefs 消息带回，见 applyPrefs）。**不在表里的会话按原顺序排在其后** —— 新会话永远
  // 不会因为"你没拖过它"而消失或跑到最前。
  var tabOrder = [];
  // [CUSTOM- 草稿（本地页）的顺序与锚点（2026-11-12）。它们没有会话 id，不能进 tabOrder；
  // 但用户要求草稿也能拖拽、并且"新建到某个会话右侧"能生效，所以：
  // · draftOrder：草稿之间的相对顺序；
  // · draftAfter：draftId → 锚点 id（某个会话 / 待恢复 tab；'__front__' = 排在最前）。
  //   没有锚点的草稿追加在末尾（与旧行为一致）。纯客户端内存，刷新即丢（草稿本来也不持久化）。
  var draftOrder = [];
  var draftAfter = {};
  // 拖动中的会话 id 与落点（'before' | 'after'，相对 dropId）。
  var dragId = null;
  var dropId = null;
  var dropAt = null;
  // [CUSTOM- 宿主解析出的默认目录（随 boot 到达）。**没有聚焦会话**时地址栏
  // 显示它 —— 连接适配器（npx 下载）那几十秒里面板正是"已连接、还没有会话"，那时整格空着
  // 会看着像坏了（090 当初把这一格隐藏，代价就是这个）。它同时是草稿页地址栏的兜底文案。
  var defaultCwd = '';
  // [CUSTOM- Set when a tab was moved to by ARROW KEY, so the next
  // render can put DOM focus back on it (see setFocus).
  var tabFocusExpected = false;
  // [CUSTOM- 快捷键懒恢复的**全局单飞**闸门：任何一个恢复在途时，activateRelative
  // 一律 no-op。否则连续按键会让多个 load 晚到、依次把会话焦点抢回去。点击 tab 不走这里。
  // 宿主无论成败都会回 'restoreFinished'；pending 不设超时，避免慢加载时重复请求。
  var restorePending = {};
  // [CUSTOM- 快捷键从 tab 栏发起懒恢复时，真正的切换要等 load 回来；
  // 记住"恢复完成后把焦点还给新的活动 tab"，但用户若已把焦点移进输入框就不抢。
  // 意图从请求起一直保留到完成/取消；只有成功回执后才启动独立短超时清理。
  var RESTORE_FOCUS_INTENT_MS = 5000;
  var restoreFocusAfterId = {};
  var restoreFocusTimers = {};

  /**
   * [CUSTOM- Ordered tab models: real sessions first, then drafts.
   *
   * One list so that roving tabindex and the arrow keys work across BOTH kinds —
   * otherwise a focused draft would leave every real tab at 'tabIndex = -1' and
   * Tab could not reach them.
   */
  function tabModels() {
    var i;
    // [CUSTOM- 会话按**手工顺序**排（tabOrder 里没有的按原顺序接在后面）。
    // [CUSTOM- **待恢复的会话与真会话一起排**：它们本来就在上次那张 tabOrder 里，
    // 一起排队才恢复得出原来的位置（否则恢复出来的 tab 会全挤在真会话后面）。
    var entries = [];
    for (i = 0; i < state.sessions.length; i++) {
      entries.push({ kind: 'session', id: state.sessions[i].sessionId, summary: state.sessions[i] });
    }
    for (i = 0; i < restoring.length; i++) {
      entries.push({ kind: 'restore', id: restoring[i].sessionId, restore: restoring[i] });
    }
    var sideTabs = state.sessions.length > 0 && !!state.sessions[0].sideChat;
    if (tabOrder.length > 0 && !sideTabs) {
      var rank = {};
      for (i = 0; i < tabOrder.length; i++) { rank[tabOrder[i]] = i; }
      var known = [], unknown = [];
      for (i = 0; i < entries.length; i++) {
        if (rank[entries[i].id] === undefined) { unknown.push(entries[i]); }
        else { known.push(entries[i]); }
      }
      known.sort(function (a, b) { return rank[a.id] - rank[b.id]; });
      entries = known.concat(unknown);
    }
    // [CUSTOM- 草稿不再是"永远最后"：按 draftOrder 排，再按 draftAfter 的锚点插进
    // entries（同锚点按 draftOrder 依次排在锚点后面；'__front__' = 插到最前；
    // 锚点不存在的退回末尾）。这是"新建 Session 到右侧"与草稿拖拽排序的共同基础。
    var drafts = [];
    for (i = 0; i < state.drafts.length; i++) {
      drafts.push({ kind: 'draft', id: state.drafts[i].draftId, draft: state.drafts[i] });
    }
    var draftRank = {};
    for (i = 0; i < draftOrder.length; i++) { draftRank[draftOrder[i]] = i; }
    drafts.sort(function (a, b) {
      var ra = draftRank[a.id] === undefined ? 1e9 : draftRank[a.id];
      var rb = draftRank[b.id] === undefined ? 1e9 : draftRank[b.id];
      return ra - rb;
    });
    var insertTail = {};
    for (i = 0; i < drafts.length; i++) {
      var model = drafts[i];
      var anchor = draftAfter[model.id];
      if (anchor === '__front__') {
        var fpos = insertTail['__front__'] === undefined ? 0 : insertTail['__front__'];
        entries.splice(fpos, 0, model);
        insertTail['__front__'] = fpos + 1;
        continue;
      }
      var at = anchor ? indexOfModelId(entries, anchor) : -1;
      if (at < 0) { entries.push(model); continue; }
      var pos = insertTail[anchor] === undefined ? at + 1 : insertTail[anchor];
      entries.splice(pos, 0, model);
      insertTail[anchor] = pos + 1;
    }
    return entries;
  }

  function indexOfModelId(models, id) {
    for (var i = 0; i < models.length; i++) { if (models[i].id === id) { return i; } }
    return -1;
  }

  /** 草稿只活在客户端：清掉已经不存在的 draftId，新增的按 drafts 原顺序接在后面。 */
  function syncDraftOrder() {
    var alive = {};
    var i;
    for (i = 0; i < state.drafts.length; i++) { alive[state.drafts[i].draftId] = true; }
    var kept = [];
    for (i = 0; i < draftOrder.length; i++) {
      if (alive[draftOrder[i]]) { kept.push(draftOrder[i]); }
    }
    for (i = 0; i < state.drafts.length; i++) {
      if (kept.indexOf(state.drafts[i].draftId) === -1) { kept.push(state.drafts[i].draftId); }
    }
    draftOrder = kept;
    for (var id in draftAfter) {
      if (Object.prototype.hasOwnProperty.call(draftAfter, id) && !alive[id]) { delete draftAfter[id]; }
    }
  }

  function isActiveModel(model) {
    return model.kind === 'session'
      ? model.id === state.focusedId
      : model.id === state.focusedDraftId;
  }

  function activateModel(model, trackRestore) {
    if (model.kind === 'draft') {
      if (NS.draft) { NS.draft.focus(model.id); }
      return;
    }
    // [CUSTOM- 待恢复的 tab：点它才真去把那个会话 load 回来（懒恢复）。
    // 'keepOthers: true' —— 恢复是"多开"，不该像历史选择器那样关掉当前聚焦的那个（099）。
    if (model.kind === 'restore') {
      var r = model.restore || {};
      var open = {
        type: 'openHistorySession',
        agentName: r.agentName,
        sessionId: model.id,
        cwd: r.cwd,
        title: r.title,
        keepOthers: true
      };
      // 只有快捷键路径要求宿主回 'restoreFinished'；手动点击维持原协议。
      if (trackRestore) { open.trackRestore = true; }
      NS.bridge.post(open);
      return;
    }
    if (model.id !== state.focusedId) {
      // [CUSTOM- 先本地切 tab/地址栏，再发请求：宿主回 'focus' 之前的那次绘制就能看到
      // 新 tab 高亮（旧写法要等消息往返 + 整份记录重渲染完才重绘，点击像"卡了一下"）。
      // 宿主回包会再走一次 setFocus（同值，幂等）；切到非 live 会话失败时，下一次
      // sessionsChanged/focus 会把高亮纠正回来。
      setFocus(model.summary);
      NS.bridge.post({
        type: model.summary && model.summary.sideChat ? 'sideFocus' : 'focusSession',
        sessionId: model.id
      });
    }
  }

  function clearRestoreFocusIntent(id) {
    if (!id) { return; }
    delete restoreFocusAfterId[id];
    if (Object.prototype.hasOwnProperty.call(restoreFocusTimers, id)) {
      if (window.clearTimeout) { window.clearTimeout(restoreFocusTimers[id]); }
      delete restoreFocusTimers[id];
    }
  }

  /**
   * 'keepFocusIntent'：恢复成功的路径里 setSessions 先到、focus 后到，
   * 此时不能把"完成后再还焦点"的意图一起丢掉（setFocus 会消费它）。
   */
  function releaseRestore(id, keepFocusIntent) {
    if (!id) { return; }
    delete restorePending[id];
    if (!keepFocusIntent) { clearRestoreFocusIntent(id); }
  }

  /** 焦点在 tab 栏内？（快捷键发起时用它决定切换后要不要把焦点还给新活动 tab。） */
  function focusInTabs() {
    if (!tabsEl) { return false; }
    var active = document.activeElement;
    if (!active) { return false; }
    return active === tabsEl || (tabsEl.contains ? tabsEl.contains(active) : false);
  }

  /** 恢复完成时：焦点仍在 tab 栏、或已掉到 body（DOM 重建）才还焦点；在输入框里不抢。 */
  function focusAllowedAfterRestore() {
    var active = document.activeElement;
    if (!active) { return true; }
    if (active === document.body) { return true; }
    return focusInTabs();
  }

  function markRestoreFocusIntent(id) {
    if (!id) { return; }
    clearRestoreFocusIntent(id);
    // [CUSTOM- 意图从请求发出起一直保留到恢复完成/取消：真正 load 可能远超任何固定
    // 短窗口，过早过期会让慢恢复完成时焦点掉到 body。清理计时器只在成功回执后启动。
    restoreFocusAfterId[id] = true;
  }

  function armRestoreFocusIntentTimeout(id) {
    if (!id || !window.setTimeout) { return; }
    if (Object.prototype.hasOwnProperty.call(restoreFocusTimers, id)) {
      if (window.clearTimeout) { window.clearTimeout(restoreFocusTimers[id]); }
      delete restoreFocusTimers[id];
    }
    restoreFocusTimers[id] = window.setTimeout(function () { clearRestoreFocusIntent(id); }, RESTORE_FOCUS_INTENT_MS);
  }

  function consumeRestoreFocusIntent(id) {
    if (!id || !Object.prototype.hasOwnProperty.call(restoreFocusAfterId, id)) { return false; }
    clearRestoreFocusIntent(id);
    return true;
  }

  function hasPendingRestore() {
    for (var id in restorePending) {
      if (Object.prototype.hasOwnProperty.call(restorePending, id)) { return true; }
    }
    return false;
  }

  /** 标记一次恢复请求；已有在途请求时返回 false（调用方跳过重复发送）。 */
  function holdRestore(id) {
    if (Object.prototype.hasOwnProperty.call(restorePending, id)) { return false; }
    restorePending[id] = true;
    return true;
  }

  /**
   * [CUSTOM- 快捷键恢复的完结通知（宿主只对带 trackRestore 的请求回这条，且保证必回）。
   * 失败立刻解锁并清焦点意图，下一次快捷键可立即重试；成功只解 pending，把"还焦点"
   * 意图留给紧随其后的 focus 消息消费。pending 不靠超时解锁，避免真实 load 超时后重复请求。
   */
  function finishRestore(sessionId, ok) {
    if (!sessionId) { return false; }
    if (ok === false) {
      releaseRestore(sessionId);
      return false;
    }
    releaseRestore(sessionId, true);
    // 成功回执早于 focus 时才开始清理窗口；focus 已到则意图早被消费、不会启动。
    if (Object.prototype.hasOwnProperty.call(restoreFocusAfterId, sessionId)) {
      armRestoreFocusIntentTimeout(sessionId);
    }
    return true;
  }

  /**
   * [CUSTOM- 相对当前活动 tab 前进 / 后退，首尾循环。快捷键与未来入口共用。
   *
   * 顺序就是 tabModels() 的顺序（live → 待恢复 → draft；Side 面板内是 Side 顺序）。
   * 懒恢复是异步的：**只要还有一个在途，整个快捷键路径就 no-op** —— 不允许越过它
   * 去加载别的恢复，也不允许切到别的会话，避免晚到的 load 依次抢回焦点。
   * 成功/失败由 focus 或 restoreFinished 解锁；输入框和 tab 栏各自保留原焦点。
   */
  function activateRelative(direction) {
    var step = direction === -1 ? -1 : (direction === 1 ? 1 : 0);
    if (!step || hasPendingRestore()) { return false; }
    var models = tabModels();
    if (models.length < 2) { return false; }
    var base = -1;
    for (var i = 0; i < models.length; i++) {
      if (isActiveModel(models[i])) { base = i; break; }
    }
    if (base < 0) { base = step > 0 ? -1 : 0; }
    var next = models[(base + step + models.length) % models.length];
    if (isActiveModel(next)) { return false; }
    var fromTabs = focusInTabs();
    if (next.kind === 'restore') {
      if (!holdRestore(next.id)) { return false; }
      if (fromTabs) { markRestoreFocusIntent(next.id); }
      activateModel(next, true);
      return true;
    }
    if (fromTabs) { tabFocusExpected = true; }
    activateModel(next);
    return true;
  }

  function closeModel(model, anchor, event) {
    if (model.kind === 'draft') {
      if (NS.draft) { NS.draft.drop(model.id); }
      return;
    }
    // [CUSTOM- 关掉一个"还没加载"的：只丢本地那条，并让宿主把它从快照里忘掉
    // —— 否则下次重载还会拿它问你（而用户的动作明确是"不要它"）。
    if (model.kind === 'restore') {
      dropRestoring(model.id);
      NS.bridge.post({ type: 'forgetRestorable', sessionId: model.id });
      return;
    }
    var close = function () {
      NS.bridge.post({
        type: model.summary && model.summary.sideChat ? 'sideClose' : 'closeSession',
        sessionId: model.id
      });
    };
    // [CUSTOM- 2026-10-29：运行中的会话先问一句，但问在面板内（非模态浮层），
    // 不再用宿主 modal 挡住整个 IDE。summary.running 与宿主 isSessionRunning 同源
    // （轮次在飞或后台任务未结束），四个关闭入口都汇到这里，一次覆盖全部。
    var running = !!(model.summary && model.summary.running);
    if (running && NS.popover && NS.popover.confirm) {
      var title = model.summary && model.summary.title ? model.summary.title : model.id;
      if (NS.popover.confirm({
        message: 'Close "' + title + '"? The agent is still working — closing cancels the current turn.',
        confirmLabel: 'Close',
        danger: true,
        anchor: anchor,
        event: event,
        onConfirm: close
      })) { return; }
    }
    close();
  }

  // 会话 tab 右键菜单的入口（见 contextMenu.itemsFor）。
  // 模型解析留在本模块：菜单只拿得到 DOM 元素，而"这个元素是哪一条、关掉它意味着什么"
  // （草稿=丢弃 / 待恢复=本地忘掉 / 真会话=closeSession）是这里独有的知识。
  /** The model behind a tab element, by whichever id attribute its kind carries. */
  function modelOfNode(node) {
    if (!node || !node.getAttribute) { return null; }
    var id = node.getAttribute('data-session-id') || node.getAttribute('data-draft-id')
      || node.getAttribute('data-restore-id');
    if (!id) { return null; }
    var models = tabModels();
    for (var i = 0; i < models.length; i++) { if (models[i].id === id) { return models[i]; } }
    return null;
  }

  /** 菜单 Close：与 tab 上的 × 同一条路（closeModel 按 kind 分派）。 */
  function closeTabNode(node, event) {
    var model = modelOfNode(node);
    if (model) { closeModel(model, node, event); }
  }

  /**
   * [CUSTOM- 关闭当前活动的 tab（Alt+W）：草稿丢弃、待恢复遗忘、运行中二次确认
   * 全部复用 closeModel —— 快捷键只是"找到活动模型"的另一个入口，不是第二条关闭路径。
   */
  function closeActive() {
    var models = tabModels();
    for (var i = 0; i < models.length; i++) {
      if (isActiveModel(models[i])) {
        closeModel(models[i], activeTabNode(), null);
        return true;
      }
    }
    return false;
  }

  /**
   * [CUSTOM- 2026-10-29：改名改成面板内输入浮层（原来弹宿主 InputBox，抢焦点、
   * 盖住窗口顶部）。tab 右键菜单与历史行共用同一形态；提交后由宿主应用并回
   * 'sessionAction'，tab 名靠 'sessionsChanged' 同步。
   */
  function startRename(tabEl, event) {
    if (!tabEl || !tabEl.getAttribute || !NS.popover || !NS.popover.prompt) { return false; }
    var sessionId = tabEl.getAttribute('data-session-id');
    if (!sessionId) { return false; }
    var labelEl = tabEl.querySelector ? tabEl.querySelector('.tab-label') : null;
    var current = labelEl ? String(labelEl.textContent || '') : '';
    return NS.popover.prompt({
      title: 'Rename Session',
      message: 'New name for this session',
      value: current,
      confirmLabel: 'Rename',
      anchor: tabEl,
      event: event,
      onSubmit: function (value) {
        var title = String(value === undefined || value === null ? '' : value).trim();
        // 清空 / 没改都当"没改"（与宿主原来的 InputBox 语义一致）。
        if (!title || title === current) { return; }
        NS.bridge.post({ type: 'renameSession', sessionId: sessionId, title: title });
      }
    });
  }

  function init() {
    tabsEl = NS.dom.qs('tabs');
    // [CUSTOM- 整条标签栏（含最后一个 tab 右边的空白）才是落点容器，见 installDrag。
    stripEl = NS.dom.qs('tabStrip');
    agentBar = NS.dom.qs('agentBar');
    agentSelect = NS.dom.qs('agentSelect');
    agentMenu = NS.dom.qs('agentMenu');
    cwdBtn = NS.dom.qs('cwdBtn');
    // [CUSTOM- 会话 tab / 目录图标的悬停提示要**分色**（SessionId、State 用灰色），
    // 原生 title 做不到分段着色 —— 用一条自绘的浮层（2026-10-27）。
    tipEl = NS.dom.el('div', 'tab-tip');
    tipEl.hidden = true;
    document.body.appendChild(tipEl);

    NS.dom.qs('newTab').addEventListener('click', function () {
      // [CUSTOM- '+' opens a LOCAL DRAFT instead of creating a
      // session immediately. The directory is chosen on that page, and creating
      // the session there and then would mean "change the directory" has to
      // close and recreate it — and 'session/close' does NOT remove a session
      // from the agent's history, so every change would leave an empty one
      // behind. The session is created on the first send instead.
      //
      // [CUSTOM- …but only once the agent is up. Opening a draft while
      // offline produced a page whose composer was still disabled (nothing can be sent
      // without a process), which reads as "I clicked + and cannot type". So an offline
      // '+' connects first and leaves its intent behind: boot opens the draft when the
      // connection lands. Already connected = unchanged, immediate draft.
      if (NS.stateCard && !NS.stateCard.isConnected()) {
        NS.stateCard.beginConnect(true);
        return;
      }
      if (NS.draft) { NS.draft.start(); }
      // [CUSTOM- New session = the user wants to type. (focus() on
      // a disabled textarea is a harmless no-op.)
      if (NS.composer) { NS.composer.focusInput(); }
    });

    agentSelect.addEventListener('click', function (event) {
      event.stopPropagation();
      if (!agentMenu) { return; }
      var open = agentMenu.className.indexOf('open') !== -1;
      closeAgentMenu();
      if (!open) {
        agentMenu.className = 'picker-menu down agent-menu open';
        renderAgentMenu();
      }
    });
    // 点菜单外任意处收起（菜单项自己的 click 会 stopPropagation）。
    document.addEventListener('click', function () { closeAgentMenu(); });
    document.addEventListener('scroll', hideTip, true);
    window.addEventListener('resize', function () { hideTip(); updateDensity(); });

    // [CUSTOM- The tablist keyboard contract: arrows move the
    // selection, Delete closes. Needed because the roving tabindex deliberately
    // leaves only the ACTIVE tab in the tab order.
    // [CUSTOM- …and it spans drafts too, hence 'tabModels()'.
    tabsEl.addEventListener('keydown', function (event) {
      var index = modelIndexOf(event.target);
      if (index < 0) { return; }
      var models = tabModels();
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        // 带修饰键的箭头留给 document 级快捷键（例如 Alt+Arrow 导航），
        // 这里既不消费也不切换，让它继续冒泡。
        if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) { return; }
        event.preventDefault();
        if (models.length < 2) { return; }
        var next = (index + (event.key === 'ArrowRight' ? 1 : -1) + models.length) % models.length;
        tabFocusExpected = true;
        activateModel(models[next]);
        return;
      }
      if (event.key === 'Delete') {
        event.preventDefault();
        closeModel(models[index], event.target, event);
      }
    });

    // [CUSTOM- 拖拽排序的落点监听挂在**条带**上，不挂在每个 tab 上（见 installDrag）。
    installDrag();
    // [CUSTOM- 竖向滚轮横向翻 tab 条（见 installWheel）。
    installWheel();
  }

  /**
   * [CUSTOM- 会话 tab 溢出时，竖向鼠标滚轮在条带上横向滚动。
   *
   * 真正的滚动容器是内层 #tabs（#tabStrip 自己是 overflow: hidden，这样 + / 设置按钮
   * 永远固定在右边）。只处理"纯竖向"滚轮：横向触控板手势（deltaX）与 Shift/Ctrl/Meta 组合
   * 保持原生（与 scroll.ts 的门控同一取舍），滚到边界或没有溢出时也不 preventDefault。
   */
  function installWheel() {
    if (!stripEl || !tabsEl || !stripEl.addEventListener) { return; }
    stripEl.addEventListener('wheel', function (event) {
      if (!event || event.deltaY === 0 || event.deltaX) { return; }
      if (event.ctrlKey || event.metaKey || event.shiftKey) { return; }
      var max = tabsEl.scrollWidth - tabsEl.clientWidth;
      if (!(max > 1)) { return; }
      var delta = event.deltaY;
      if (event.deltaMode === 1) { delta = delta * 16; }
      else if (event.deltaMode === 2) { delta = delta * tabsEl.clientWidth; }
      var before = tabsEl.scrollLeft || 0;
      if ((delta < 0 && before <= 0) || (delta > 0 && before >= max)) { return; }
      if (event.preventDefault) { event.preventDefault(); }
      tabsEl.scrollLeft = Math.max(0, Math.min(max, before + delta));
      hideTip();
    }, { passive: false });
  }

  function tabLabel(summary) {
    if (summary.sideChat) {
      var parent = summary.sideChat.parentTitle || summary.sideChat.parentSessionId;
      return parent + ' · ' + summary.sessionId.slice(0, 8);
    }
    if (summary.title && summary.title.length > 0) { return summary.title; }
    if (summary.sessionId) { return summary.sessionId.slice(0, 8); }
    return 'session';
  }

  /**
   * [CUSTOM- 目录标识：取目录名单词的头几个字母（最多 4 个，2x2 布局）。
   *
   * 规则（用户指定）：按非字母数字切分取每段首字母，大写。如：
   * 'alpha-beta-gamma' → 'ABG'（3 段）
   * 'AbcDeFg' → 'ADF'（按驼峰拆：Abc / De / Fg）
   * 'abc-de-fg' → 'ADF'
   * 'a' → 'A'，'ab' → 'AB'
   *
   * 与"取前 4 个字符"不同：按单词边界取首字母，用户一眼能认出是哪个目录。
   * 拆词不用正则 lookbehind（本文件要走 check-webview-client.mjs 的 new Function 解析，
   * lookbehind 在它的目标解析里会报 Unexpected token）—— 用两轮拆分。
   */
  function directoryAbbrev(cwd) {
    if (!cwd || typeof cwd !== 'string') { return ''; }
    // [CUSTOM- 模板串里的反斜杠要双写：这里写四个，客户端拿到两个，
    // 正则才是 /[\\/]/（同时匹配反斜杠与正斜杠）。只写两个的话客户端收到 /[\/]/ ——
    // 只匹配正斜杠，Windows 路径整条不拆（实测：D 盘路径不拆分，缩写成 DGZX 而不是 Y）。
    var parts = cwd.split(/[\\\\/]/).filter(Boolean);
    if (parts.length === 0) { return ''; }
    var name = parts[parts.length - 1];
    // 第一轮：按非字母数字切；第二轮：按驼峰边界再切。
    var words = [];
    var rough = name.split(/[^a-zA-Z0-9]+/);
    for (var r = 0; r < rough.length; r++) {
      var seg = rough[r];
      if (!seg) { continue; }
      var cur = '';
      for (var c = 0; c < seg.length; c++) {
        var ch = seg[c];
        if (cur && ch >= 'A' && ch <= 'Z' && seg[c - 1] >= 'a' && seg[c - 1] <= 'z') {
          words.push(cur); cur = '';
        }
        cur += ch;
      }
      if (cur) { words.push(cur); }
    }
    var letters = [];
    for (var i = 0; i < words.length && letters.length < 4; i++) {
      var w = words[i];
      if (w.length === 0) { continue; }
      letters.push(w[0].toUpperCase());
    }
    return letters.join('');
  }

  function dotClass(summary) {
    // 而早先把 running 映射成"颜色 + 整体脉动"时，两件事被挤进了同一个信号里。
    var cls = 'tab-dot';
    // 优先级：等人回答 > 轮次在跑 > 载入历史 > 后台有新输出 > 平常。
    // 「等人回答」排最前是因为只有它**没有任何东西会自己往前走**。
    if (summary.waiting) { cls += ' waiting'; }
    else if (summary.running) { cls += ' running'; }
    else if (summary.loading) { cls += ' loading'; }
    else if (summary.unread) { cls += ' attention'; }
    // 外圈：轮次在跑，或正在 replay 载入——都算"这个会话正在做事"。
    if (summary.running || summary.loading) { cls += ' busy'; }
    return cls;
  }

  /**
   * [CUSTOM-229 dot 用**颜色**说状态，而颜色是读不出名字的（且没有图例）。所以把同一份
   * 状态**也说给 tooltip**：悬停时除了目录路径，还要能读到"这个色块现在是什么意思"。
   * 优先级与 dotClass 逐条对齐 —— 两处一旦不一致，颜色和文字就会互相打脸。
   */
  function dotStatusText(summary) {
    if (summary.waiting) { return 'Waiting for your answer'; }
    if (summary.running) { return 'Turn in progress'; }
    if (summary.loading) { return 'Loading history'; }
    if (summary.unread) { return 'New output in the background'; }
    return 'Idle';
  }

  /**
   * [CUSTOM- The index in the COMBINED tab list that a keydown
   * originated from, or -1. Replaces the session-only lookup: a focused draft
   * would otherwise make every real tab unreachable by arrow key.
   */
  function modelIndexOf(node) {
    while (node && node !== tabsEl) {
      if (node.getAttribute) {
        var id = node.getAttribute('data-session-id') || node.getAttribute('data-draft-id')
          || node.getAttribute('data-restore-id');
        if (id) {
          var models = tabModels();
          for (var i = 0; i < models.length; i++) {
            if (models[i].id === id) { return i; }
          }
          return -1;
        }
      }
      node = node.parentNode;
    }
    return -1;
  }

  function activeTabNode() {
    var nodes = tabsEl.querySelectorAll('.tab.active');
    return nodes.length > 0 ? nodes[0] : null;
  }

  // [CUSTOM- 手工排序：按住左键把一个 tab 拖到目标位置上。
  //
  // 用原生 HTML5 拖拽（不需要自定义"长按"计时器），并在落点那一侧画一条 2px 指示线
  // （styles.ts 的 .drop-before / .drop-after）。顺序落盘走宿主的 setUiPref
  // （globalState，与大纲偏好同一条记录）⇒ 两个面看到同一条顺序。
  //
  // [CUSTOM- 落点从"命中了哪个 tab 元素"改成**指针在条带上的横坐标**。
  // 198 把 dragover/drop 挂在每个 .tab 自己身上，而 '.tabs' 是 'flex: 0 0 auto'：
  // 最后一个 tab 右边的空白属于 .tab-strip、tab 之间还有 2px 的缝，指针一旦落在这些地方
  // 就**没有 drop 目标**（松手即复位），而指示线又没有 dragleave 清除 —— 现场就是
  // "线还在、松手却没插进去"。现在条带里的任何位置都是落点。
  function allTabNodes() {
    var nodes = stripEl ? stripEl.querySelectorAll('.tab') : [];
    var out = [];
    for (var i = 0; i < nodes.length; i++) {
      // [CUSTOM- 2026-11-12 草稿也参与落点：它们现在可以拖拽、也可以被插到会话右侧，
      // 所以视觉顺序（含草稿）才是落点计算的依据。kind 区分"落到会话之间"与"落到草稿之间"。
      // [CUSTOM- 2026-11-10] 待恢复（还没 load）的 tab 与真会话共用同一张 tabOrder，算落点。
      if (!nodes[i].getAttribute) { continue; }
      var draftId = nodes[i].getAttribute('data-draft-id');
      var id = nodes[i].getAttribute('data-session-id')
        || nodes[i].getAttribute('data-restore-id') || draftId;
      if (id) { out.push({ node: nodes[i], id: id, kind: draftId ? 'draft' : 'session' }); }
    }
    return out;
  }

  /** 可见 id 的类型：草稿（客户端本地）还是会话/待恢复（走宿主 tabOrder）。 */
  function kindOfTabId(id) {
    for (var i = 0; i < state.drafts.length; i++) {
      if (state.drafts[i].draftId === id) { return 'draft'; }
    }
    return 'session';
  }

  /** 指针的横坐标；拿不到（合成的/老事件）返回 null —— 没有坐标就别猜落点。 */
  function pointerX(event) {
    var x = event && event.clientX;
    return (typeof x === 'number' && isFinite(x)) ? x : null;
  }

  /** 横坐标对应的插入位（0..n，n = 插到最后）与此刻屏幕上的会话 id 顺序。 */
  function boundaryFor(x) {
    var tabs = allTabNodes();
    var ids = [];
    var index = 0;
    for (var i = 0; i < tabs.length; i++) {
      ids.push(tabs[i].id);
      var rect = tabs[i].node.getBoundingClientRect ? tabs[i].node.getBoundingClientRect() : null;
      var mid = (rect && typeof rect.left === 'number' && typeof rect.width === 'number')
        ? rect.left + rect.width / 2
        : null;
      // 量不出中点时按"已经过了它"算，落点只会往右偏、不会是随机的。
      if (mid === null || x > mid) { index += 1; }
    }
    return { index: index, ids: ids };
  }

  /** 落点指示线：第 index 个 tab 的左侧；index === n 时画在最后一个的右侧。 */
  function markBoundary(index) {
    var tabs = allTabNodes();
    if (tabs.length === 0) { return; }
    var side = index >= tabs.length ? 'after' : 'before';
    var id = tabs[Math.min(index, tabs.length - 1)].id;
    if (dropId === id && dropAt === side) { return; }
    dropId = id;
    dropAt = side;
    for (var i = 0; i < tabs.length; i++) {
      var cls = String(tabs[i].node.className || '').replace(/ drop-(before|after)/g, '');
      if (tabs[i].id === id) { cls += ' drop-' + side; }
      tabs[i].node.className = cls;
    }
  }

  /** 只清指示线（指针离开条带用）；拖动本身还在 —— 松手前回来仍然能落。 */
  function clearIndicator() {
    dropId = null;
    dropAt = null;
    var tabs = allTabNodes();
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].node.className = String(tabs[i].node.className || '').replace(/ drop-(before|after)/g, '');
    }
  }

  function endDrag() {
    dragId = null;
    dropId = null;
    dropAt = null;
    var tabs = allTabNodes();
    for (var i = 0; i < tabs.length; i++) {
      tabs[i].node.className = String(tabs[i].node.className || '').replace(/ (dragging|drop-before|drop-after)/g, '');
    }
  }

  /**
   * 把 'fromId' 搬到 'ids' 里的第 'index' 位，即"插在当前位置为 index 的那条之前"
   * （index === ids.length 表示插到最后）。搬完原地不动时返回 false —— 判据是**搬动前后
   * 的数组内容**，所以"插到自己原来的位置"不会白白重渲染一次、也不会白写一次 globalState。
   */
  function moveTo(fromId, index, ids) {
    var from = ids.indexOf(fromId);
    if (from < 0) { return false; }
    var before = ids.slice();
    ids.splice(from, 1);
    // 摘掉自己之后，原来在它右边的那些都左移了一位 —— 目标下标要跟着挪。
    var to = from < index ? index - 1 : index;
    if (to < 0) { to = 0; }
    if (to > ids.length) { to = ids.length; }
    ids.splice(to, 0, fromId);
    for (var i = 0; i < ids.length; i++) { if (ids[i] !== before[i]) { return true; } }
    return false;
  }

  function dropOn(x) {
    var fromId = dragId;
    var boundary = boundaryFor(x);
    var index = boundary.index;
    var ids = boundary.ids;
    var fromKind = fromId ? kindOfTabId(fromId) : null;
    endDrag();
    // 诊断常驻（本仓库的既有风格，见 scroll# / markdownRendered）：真机若仍"松手复位"，
    // 这一行与 dragStart 那一行合起来就能区分三种断法 —— dragstart 没跑 / drop 没到 /
    // 落了但顺序被别的东西覆盖（那就看日志里这条之后的 uiPrefs 回话）。
    console.warn('[vac] tabdrag drop from=' + String(fromId) + ' to=' + index + ' order=' + ids.join(','));
    if (!fromId) { return; }
    if (fromKind === 'draft') {
      dropDraftAt(fromId, index, ids);
      return;
    }
    // [CUSTOM- 会话只和会话排（宿主 tabOrder 里没有草稿）。落点折算成"前面有几条会话"。
    var sessionIds = [];
    var sessionIndex = 0;
    for (var i = 0; i < ids.length; i++) {
      if (kindOfTabId(ids[i]) === 'draft') { continue; }
      if (i < index) { sessionIndex += 1; }
      sessionIds.push(ids[i]);
    }
    if (!moveTo(fromId, sessionIndex, sessionIds)) { return; }
    tabOrder = sessionIds;
    // 先落盘再重渲染：渲染若抛错，顺序也已经交上去了（两件事没有共享的失败点）。
    NS.bridge.post({ type: 'setUiPref', tabOrder: sessionIds });
    renderTabs();
  }

  /**
   * [CUSTOM- 草稿的落点（纯客户端，不写宿主 tabOrder）：
   * · 锚点 = 落点左侧最近的非草稿 tab；拖到整条末尾 = 没有锚点（排在末尾）；
   * · 拖到最前、左侧只有草稿时用 '__front__'；
   * · 同锚点的草稿之间用 draftOrder 决定先后，落点相邻的草稿决定插在它前面还是后面。
   */
  function dropDraftAt(fromId, index, ids) {
    var anchor = null;
    var i;
    for (i = index - 1; i >= 0; i--) {
      if (ids[i] !== fromId && kindOfTabId(ids[i]) !== 'draft') { anchor = ids[i]; break; }
    }
    if (index >= ids.length) {
      delete draftAfter[fromId];
    } else if (anchor) {
      draftAfter[fromId] = anchor;
    } else if (index <= 0) {
      draftAfter[fromId] = '__front__';
    } else {
      var leftId = null;
      for (i = index - 1; i >= 0; i--) { if (ids[i] !== fromId) { leftId = ids[i]; break; } }
      if (leftId && draftAfter[leftId]) { draftAfter[fromId] = draftAfter[leftId]; }
      else { delete draftAfter[fromId]; }
    }

    var order = draftOrder.slice();
    var at = order.indexOf(fromId);
    if (at >= 0) { order.splice(at, 1); }
    var leftDraft = null;
    for (i = index - 1; i >= 0; i--) {
      if (ids[i] !== fromId && kindOfTabId(ids[i]) === 'draft') { leftDraft = ids[i]; break; }
    }
    var rightDraft = null;
    for (i = index; i < ids.length; i++) {
      if (ids[i] !== fromId && kindOfTabId(ids[i]) === 'draft') { rightDraft = ids[i]; break; }
    }
    if (leftDraft) {
      var li = order.indexOf(leftDraft);
      if (li >= 0) { order.splice(li + 1, 0, fromId); } else { order.push(fromId); }
    } else if (rightDraft) {
      var ri = order.indexOf(rightDraft);
      if (ri >= 0) { order.splice(ri, 0, fromId); } else { order.unshift(fromId); }
    } else {
      order.push(fromId);
    }
    draftOrder = order;
    renderTabs();
  }

  /** 宿主 globalState 里那份顺序（随 boot 的 uiPrefs 到达；空表 = 保持原顺序）。 */
  function applyPrefs(prefs) {
    var order = prefs && prefs.tabOrder;
    if (!order || !order.length) { return; }
    tabOrder = order.slice();
    renderTabs();
  }

  /**
   * [CUSTOM- 落点容器是整条标签栏：dragover / drop / dragleave 都挂在它身上。
   * 每个 tab 自己只留 dragstart（谁被拖）与 dragend（拖动结束归位清理）。
   */
  function installDrag() {
    if (!stripEl) { return; }
    stripEl.addEventListener('dragover', function (event) {
      if (!dragId) { return; }
      var x = pointerX(event);
      if (x === null) { return; }
      if (event.preventDefault) { event.preventDefault(); }
      if (event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
      markBoundary(boundaryFor(x).index);
    });
    stripEl.addEventListener('drop', function (event) {
      if (!dragId) { return; }
      var x = pointerX(event);
      if (x === null) { return; }
      if (event.preventDefault) { event.preventDefault(); }
      dropOn(x);
    });
    stripEl.addEventListener('dragleave', function (event) {
      // 子节点之间移动也会冒上来（relatedTarget 仍在条带内）—— 只有真离开条带才清指示线。
      if (!dragId) { return; }
      var to = event.relatedTarget;
      if (to && stripEl.contains && stripEl.contains(to)) { return; }
      clearIndicator();
    });
  }

  function dragStart(tab, model, event) {
    // 从关闭按钮起拖不该搬走整个 tab（用户点的是 ×）。
    if (event.target && event.target.closest && event.target.closest('.tab-close')) {
      if (event.preventDefault) { event.preventDefault(); }
      return;
    }
    dragId = model.id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = 'move';
      // 有些浏览器不给 dataTransfer 挂数据就取消整次拖拽 —— 写个占位值最稳。
      try { event.dataTransfer.setData('text/plain', model.id); } catch (e) { /* 桩 DOM 没有它 */ }
    }
    tab.className = String(tab.className || '') + ' dragging';
    console.warn('[vac] tabdrag start=' + model.id);
  }

  function renderTabs() {
    // 重建会移除触发悬停的节点，mouseleave 不会再到达 —— 先收起自绘提示。
    hideTip();
    NS.dom.clear(tabsEl);
    var models = tabModels();
    // Roving tabindex: exactly ONE tab in the tab order across both kinds (the
    // standard tablist pattern, and arrow keys move between them) so Tab does
    // not stop once per session on the way to the composer.
    var activeSeen = false;
    for (var i = 0; i < models.length; i++) { if (isActiveModel(models[i])) { activeSeen = true; break; } }

    for (var j = 0; j < models.length; j++) {
      (function (model, index) {
        var active = isActiveModel(model);
        var isDraft = model.kind === 'draft';
        var isRestore = model.kind === 'restore';
        var side = !isDraft && !isRestore && !!(model.summary && model.summary.sideChat);
        var label = isDraft ? 'New session'
          : (isRestore ? tabLabel(model.restore) : tabLabel(model.summary));
        var idAttr = isDraft ? 'data-draft-id' : (isRestore ? 'data-restore-id' : 'data-session-id');
        // [CUSTOM- A real <button>, not a div with a click handler:
        // the strip was unreachable by keyboard before, and Enter/Space on a
        // button fires 'click' natively (no keydown branch needed).
        var tab = NS.dom.el('button', 'tab' + (isDraft ? ' tab-draft' : '')
          + (isRestore ? ' tab-restore' : '') + (active ? ' active' : ''));
        tab.type = 'button';
        tab.setAttribute('role', 'tab');
        tab.setAttribute(idAttr, model.id);
        // [CUSTOM- 2026-10-29] 右键菜单 "Copy working directory" 用；草稿/待恢复没有真正的会话目录。
        if (!isDraft && !isRestore && model.summary && model.summary.cwd) {
          tab.setAttribute('data-cwd', model.summary.cwd);
        }
        // [CUSTOM- 2026-10-29] 未读标记也写到 tab 上：即使 running 的优先级让圆点暂时是蓝色，
        // 右键菜单仍能知道"已经标记过未读"并置灰。
        if (!isDraft && !isRestore && model.summary && model.summary.unread) {
          tab.setAttribute('data-unread', '');
        }
        tab.setAttribute('aria-selected', active ? 'true' : 'false');
        // [CUSTOM- 2026-11-12：紧凑模式下标题文字会被隐藏（只留目录徽标），
        // aria-label 让屏幕阅读器仍然读得到这个 tab 的名字。
        tab.setAttribute('aria-label', label);
        tab.tabIndex = active || (!activeSeen && index === 0) ? 0 : -1;
        // [CUSTOM- 自绘悬停提示（2026-10-27）：标签名正常色，会话 id 灰色。
        var tabLines = isDraft
          ? [{ text: model.draft.cwd || 'Default directory' },
            { text: '(not created yet)', dim: true }]
          : (isRestore
            ? [{ text: label },
              { text: model.id, dim: true }]
              .concat(model.restore.app ? [{ text: '(' + model.restore.app + ')', dim: true }] : [])
              .concat([{ text: '(not loaded yet \\u2014 click to open)', dim: true }])
            : (side
              ? [{ text: 'From ' + (model.summary.sideChat.parentTitle || model.summary.sideChat.parentSessionId) },
                { text: 'Side: ' + model.id, dim: true },
                { text: 'Inherited: ' + model.summary.sideChat.forkedAt, dim: true }]
              : [{ text: label }, { text: model.id, dim: true }]));

        // [CUSTOM- 目录标识：dot 里写目录缩写，一个字母一个 span
        // （3 个走「上 2 下 1」、4 个走 2x2，靠 styles.ts 那套两列网格排）。
        // 228：字母数写进 data-len —— styles.ts 按它分档字号、并决定走单行还是两行网格。
        // 229：dot 同时承载状态色，所以 tooltip 是**两行、各带标签**：目录路径 + 当前状态
        // （颜色读不出名字，得让悬停能问）。没有 cwd 的会话只留状态那一行。
        var dot = NS.dom.el('span', isDraft ? 'tab-dot draft'
          : (isRestore ? 'tab-dot restore' : dotClass(model.summary)));
        var dotLines = null;
        if (!isDraft && !isRestore) {
          var abbrev = directoryAbbrev(model.summary.cwd);
          if (abbrev.length > 0) { dot.setAttribute('data-len', String(abbrev.length)); }
          for (var li = 0; li < abbrev.length; li++) {
            dot.appendChild(NS.dom.el('span', 'dir-letter', abbrev[li]));
          }
          // [CUSTOM- 2026-10-27：路径不再带 'Dir:' 前缀，State 文字用次要色。
          dotLines = (model.summary.cwd ? [{ text: model.summary.cwd }] : [])
            .concat([{ text: 'State: ' + dotStatusText(model.summary), dim: true }]);
        }
        // [CUSTOM- 同一层 mouseover 决定这次悬停讲的是「tab」还是「目录图标」：
        // mouseenter 不冒泡，从图标移回 tab 背景时不会再触发一次，提示会消失。
        tab.addEventListener('mouseover', function (event) {
          var target = event && event.target;
          var onDot = dotLines && target
            && (target === dot || (dot.contains && dot.contains(target)));
          showTip(onDot ? dot : tab, onDot ? dotLines : tabLines);
        });
        tab.addEventListener('mouseleave', hideTip);
        tab.addEventListener('focus', function () { showTip(tab, tabLines); });
        tab.addEventListener('blur', hideTip);
        tab.appendChild(dot);
        tab.appendChild(NS.dom.el('span', 'tab-label', label));

        var close = NS.dom.el('button', 'tab-close', '\\u00d7');
        close.type = 'button';
        close.title = isDraft ? 'Discard this draft'
          : (isRestore ? 'Forget this session (do not offer it again)' : 'Close this session');
        close.setAttribute('aria-label', (isDraft ? 'Discard ' : 'Close ') + label);
        // [CUSTOM- OUT of the tab order. The × lives inside the tab button,
        // so with the default tabindex every session's close button was its own tab stop
        // — ten sessions meant ten extra stops on the way to the composer, defeating the
        // roving tabindex the strip is built around (and a stray Enter on the way closed
        // a session). Delete/Backspace already closes the focused tab.
        close.tabIndex = -1;
        close.addEventListener('click', function (event) {
          event.stopPropagation();
          closeModel(model, close, event);
        });
        tab.appendChild(close);

        tab.addEventListener('click', function () {
          if (!active) { activateModel(model); }
        });
        // [CUSTOM- 中键关闭（2026-10-21）：与 × / Delete / 右键 Close 汇入同一个
        // closeModel（草稿、待恢复、真会话各自的语义都不变）。
        // mousedown 里先阻止默认行为 —— 否则 WebView 会进入中键自动滚动。
        tab.addEventListener('mousedown', function (event) {
          if (event.button === 1 && event.preventDefault) { event.preventDefault(); }
        });
        tab.addEventListener('auxclick', function (event) {
          if (event.button !== 1) { return; }
          if (event.preventDefault) { event.preventDefault(); }
          if (event.stopPropagation) { event.stopPropagation(); }
          closeModel(model, tab, event);
        });
        // [CUSTOM- 手工排序。2026-11-12 起**草稿也能拖**（它现在有 draftOrder / draftAfter，
        // 见 tabModels）；Side 仍不参与（Side 面板有自己的顺序语义）。
        // [CUSTOM- 2026-11-10] 待恢复（未 load）的 tab 也参与：它和真会话共用 tabOrder，
        // 不让拖就会留下"恢复出来的几条永远钉在原位/别的 tab 插不进去"的死角。Side 仍不参与。
        // [CUSTOM- 这里只留"谁被拖"与"拖完清理"；落点（dragover/drop/dragleave）
        // 在条带上，见 installDrag。
        if (!side) {
          tab.setAttribute('draggable', 'true');
          tab.addEventListener('dragstart', function (event) { dragStart(tab, model, event); });
          tab.addEventListener('dragend', function () { endDrag(); });
        }
        tabsEl.appendChild(tab);
      })(models[j], j);
    }
    updateDensity();
  }

  /**
   * [CUSTOM- 页签密度（2026-11-12）：tab 多时先压缩宽度（浏览器式），压到只剩省略号
   * 仍放不下就隐藏标签文字，最后隐藏关闭按钮；都不行才退回横向滚动（.tabs 的
   * overflow-x 兜底）。读 scrollWidth 会同步 reflow，但只在重绘时做两次、tab 数量有限。
   * 桩 DOM 没有布局（scrollWidth / clientWidth 为 0）⇒ 不切换任何密度类。
   */
  function updateDensity() {
    if (!tabsEl) { return; }
    tabsEl.className = 'tabs';
    if (!tabsEl.scrollWidth || !tabsEl.clientWidth) { return; }
    if (tabsEl.scrollWidth <= tabsEl.clientWidth + 1) { return; }
    tabsEl.className = 'tabs compact';
    if (tabsEl.scrollWidth <= tabsEl.clientWidth + 1) { return; }
    tabsEl.className = 'tabs compact tight';
  }

  /**
   * [CUSTOM- 自绘悬停提示（2026-10-27）。原生 title 只能整段同色，而用户要求
   * 会话 tab 的 SessionId、目录图标的 State 用灰色 —— 只能渲染成一条浮层。
   * 'lines' 里每项是 { text, dim }；dim = 次要色。
   */
  function hideTip() {
    if (tipEl) { tipEl.hidden = true; }
  }

  function showTip(anchor, lines) {
    if (!tipEl || !anchor || !lines || lines.length === 0) { return; }
    NS.dom.clear(tipEl);
    for (var i = 0; i < lines.length; i++) {
      tipEl.appendChild(NS.dom.el(
        'div', 'tab-tip-line' + (lines[i].dim ? ' dim' : ''), lines[i].text || ''));
    }
    tipEl.hidden = false;
    var rect = anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : { left: 0, bottom: 0, width: 0 };
    var width = tipEl.getBoundingClientRect ? tipEl.getBoundingClientRect().width : 0;
    var viewport = window.innerWidth || 800;
    var left = Math.max(4, Math.min(rect.left || 0, viewport - width - 8));
    tipEl.style.left = left + 'px';
    tipEl.style.top = ((rect.bottom || 0) + 6) + 'px';
  }

  /** The agent bar is only worth showing when more than one agent is live. */
  function renderAgentBar() {
    var agents = [];
    var seen = {};
    for (var i = 0; i < state.sessions.length; i++) {
      var name = state.sessions[i].agentName;
      if (!seen[name]) { seen[name] = true; agents.push(name); }
    }
    if (agents.length <= 1) {
      agentBar.hidden = true;
      closeAgentMenu();
      return;
    }
    agentBar.hidden = false;
    // [CUSTOM- 按钮本身也是「图标 + 当前 agent 名」（2026-10-27）。
    NS.dom.clear(agentSelect);
    var glyph = NS.icons && NS.icons.icon ? NS.icons.icon('agent', 'picker-icon') : null;
    if (glyph) { agentSelect.appendChild(glyph); }
    agentSelect.appendChild(NS.dom.el('span', 'picker-label', state.focusedAgent || agents[0]));
    if (agentMenu && agentMenu.className.indexOf('open') !== -1) { renderAgentMenu(); }
  }

  function closeAgentMenu() {
    if (agentMenu) { agentMenu.className = 'picker-menu down agent-menu'; }
  }

  function agentDescription(name) {
    var kind = null;
    for (var i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].agentName === name) { kind = state.sessions[i].agentKind || null; break; }
    }
    if (kind === 'claude') { return 'Claude Code agent'; }
    if (kind === 'codex') { return 'OpenAI Codex agent'; }
    return 'ACP agent';
  }

  function renderAgentMenu() {
    if (!agentMenu) { return; }
    NS.dom.clear(agentMenu);
    agentMenu.appendChild(NS.dom.el('div', 'picker-title', 'Agents'));
    var agents = [];
    var seen = {};
    for (var i = 0; i < state.sessions.length; i++) {
      var name = state.sessions[i].agentName;
      if (!seen[name]) { seen[name] = true; agents.push(name); }
    }
    for (var j = 0; j < agents.length; j++) {
      (function (name) {
        var active = name === state.focusedAgent;
        var item = NS.dom.el('button', 'picker-item' + (active ? ' active' : ''), '');
        item.type = 'button';
        item.setAttribute('role', 'option');
        item.setAttribute('aria-selected', active ? 'true' : 'false');
        var body = NS.dom.el('span', 'picker-item-body');
        body.appendChild(NS.dom.el('span', 'picker-item-label', name));
        body.appendChild(NS.dom.el('span', 'picker-item-desc', agentDescription(name)));
        item.appendChild(body);
        if (active) {
          var check = NS.icons && NS.icons.icon ? NS.icons.icon('check', 'picker-check') : null;
          if (check) { item.appendChild(check); }
        }
        item.addEventListener('click', function (event) {
          event.stopPropagation();
          closeAgentMenu();
          NS.bridge.post({ type: 'focusAgent', agentName: name });
        });
        agentMenu.appendChild(item);
      })(agents[j]);
    }
  }

  /**
   * [CUSTOM- 没有聚焦会话/草稿时地址栏显示的那一份内容：宿主解析出的默认目录，
   * 宿主值到达前先给一句文案（与 058 草稿页原本的兜底同一句）。单点函数是为了让
   * 'renderHeader(null)' / 'renderDraftHeader' / 'currentCwd' 三处**同源**（pitfalls #19）。
   */
  function defaultCwdLabel() {
    return defaultCwd || 'Default directory';
  }

  function renderHeader(summary) {
    if (!summary) {
      // [CUSTOM- 这一格**不再隐藏**（090 的相反决定）。那时面板是"已连接、
      // 还没有会话"—— 连接适配器（npx 下载）那几十秒正是这个状态：整格空着像坏了，而且
      // 这一行唯一的弹性项就是它（.session-title 是 flex: 1），隐藏它会把 Times 那一组
      // 右侧控件整组拽到左边。090 的顾虑是"能点开目录抽屉、抽屉却在讲一个没有会话的面板"
      // —— 改用 disabled 解决：按钮在事件层面点不动，抽屉根本打不开。
      cwdBtn.hidden = false;
      cwdBtn.disabled = true;
      cwdBtn.textContent = defaultCwdLabel();
      cwdBtn.title = defaultCwd
        ? defaultCwd + '\\nThe next session will be created here'
        : 'Working directory';
      return;
    }
    cwdBtn.hidden = false;
    cwdBtn.disabled = false;
    cwdBtn.textContent = summary.cwd || '';
    cwdBtn.title = summary.cwd || '';
  }

  /**
   * [CUSTOM- The directory the header (the "address bar") is showing
   * right now, or null when it shows none.
   *
   * Read off the same state renderHeader/renderDraftHeader render from, so "what
   * the history filter defaults to" cannot drift away from "what the user sees up
   * there" (pitfalls #19). A DRAFT's directory is client-local (058), so this is
   * also the only side that can answer for a draft page at all.
   */
  function currentCwd() {
    var i;
    for (i = 0; i < state.drafts.length; i++) {
      if (state.drafts[i].draftId === state.focusedDraftId) { return state.drafts[i].cwd || null; }
    }
    for (i = 0; i < state.sessions.length; i++) {
      if (state.sessions[i].sessionId === state.focusedId) { return state.sessions[i].cwd || null; }
    }
    // [CUSTOM- 空态现在**也显示**一个目录（默认目录），所以这里跟着答它 ——
    // 否则"用户看到的"与"历史默认筛的"就分家了，而 155 整条规则建立在这两者同源上。
    return defaultCwd || null;
  }

  /** [CUSTOM- Header for a draft: it shows the directory it WILL use. */
  function renderDraftHeader(draft) {
    // [CUSTOM- A draft HAS a directory to show (and to pick), so the button
    // comes back even though there is no session yet.
    cwdBtn.hidden = false;
    cwdBtn.disabled = false;
    // [CUSTOM- 还没选过目录时显示**真正的默认目录**（宿主值），与空态那一格
    // 同一份文案 —— 草稿的抽屉收到 choices 后也会把 defaultCwd 采用成自己的 cwd（058）。
    cwdBtn.textContent = draft && draft.cwd ? draft.cwd : defaultCwdLabel();
    cwdBtn.title = 'This session will be created in this directory\\n(not created yet)';
  }

  function setSessions(sessions) {
    // [CUSTOM- 重建 tab 条会移除当前聚焦的节点；焦点若在 tab 栏内，重绘后要还回去。
    var keepTabFocus = focusInTabs();
    state.sessions = sessions || [];
    // [CUSTOM- 某个待恢复的会话已经活了（用户点了它、或它被别处 load 回来）⇒
    // 真 tab 顶替本地那条，别两处并存。
    var live = {};
    var i;
    for (i = 0; i < state.sessions.length; i++) {
      live[state.sessions[i].sessionId] = true;
      // [CUSTOM- 只收割"会话已活"这一事实，**不解 pending**：Sessions 注册可能早于
      // 真正的 focus / load 完成，此时解除单飞会让下一次按键发出重复请求。
      // pending 只由真正的 focus 或 restoreFinished 释放；focus 意图在 setFocus 消费。
    }
    var kept = [];
    for (i = 0; i < restoring.length; i++) { if (!live[restoring[i].sessionId]) { kept.push(restoring[i]); } }
    restoring = kept;
    if (keepTabFocus) { tabFocusExpected = true; }
    renderTabs();
    renderAgentBar();
    if (keepTabFocus) { restoreFocusIfExpected(); }
  }

  /** [CUSTOM- 建一批"待恢复"的本地 tab（点 Restore 时由 boot 调）。 */
  function setRestoring(list) {
    restoring = (list || []).slice();
    // 已经不在列表里的（被关掉 / 宿主放弃）不再锁着，下一次还能重新请求。
    var known = {};
    var i;
    for (i = 0; i < restoring.length; i++) { known[restoring[i].sessionId] = true; }
    var held = [];
    for (var id in restorePending) {
      if (Object.prototype.hasOwnProperty.call(restorePending, id) && !known[id]) { held.push(id); }
    }
    for (i = 0; i < held.length; i++) { releaseRestore(held[i]); }
    renderTabs();
  }

  function dropRestoring(sessionId) {
    releaseRestore(sessionId);
    var kept = [];
    for (var i = 0; i < restoring.length; i++) {
      if (restoring[i].sessionId !== sessionId) { kept.push(restoring[i]); }
    }
    restoring = kept;
    renderTabs();
  }

  function setFocus(summary) {
    // [CUSTOM- 宿主对同一会话的 focus 回包会再次触发本函数并重绘 tab 条；
    // 若此刻焦点在 tab 栏内（例如快捷键刚把焦点放上去），重绘后必须还回去，
    // 否则焦点掉到 body，下一次快捷键/键盘导航就断了。
    var keepTabFocus = focusInTabs();
    var refocusAfterRestore = summary ? consumeRestoreFocusIntent(summary.sessionId) : false;
    if (summary) { releaseRestore(summary.sessionId); }
    if (keepTabFocus || (refocusAfterRestore && focusAllowedAfterRestore())) { tabFocusExpected = true; }
    state.focusedId = summary ? summary.sessionId : null;
    state.focusedAgent = summary ? summary.agentName : null;
    if (summary) { state.focusedDraftId = null; }
    renderTabs();
    renderHeader(summary);
    restoreFocusIfExpected();
  }

  /**
   * [CUSTOM- Drafts are LOCAL, so the server-driven 'setSessions'
   * must leave them alone — that is the whole reason this is a separate entry
   * point rather than part of 'state.sessions'.
   */
  function setDrafts(drafts, focusedDraftId) {
    state.drafts = drafts || [];
    state.focusedDraftId = focusedDraftId || null;
    syncDraftOrder();
    renderTabs();
  }

  /**
   * [CUSTOM- 把新草稿插到某个 tab 右侧（右键菜单的 "New Session to the Right" 与
   * "New Session in This Folder"）。锚点只是客户端内存，不写宿主 tabOrder。
   */
  function placeDraftAfter(draftId, anchorId) {
    if (!draftId) { return; }
    if (anchorId) { draftAfter[draftId] = anchorId; } else { delete draftAfter[draftId]; }
    if (draftOrder.indexOf(draftId) === -1) { draftOrder.push(draftId); }
    renderTabs();
  }

  /** Focus a draft (client-local, no host round-trip). */
  function setDraftFocus(draft) {
    state.focusedId = null;
    state.focusedDraftId = draft ? draft.draftId : null;
    renderTabs();
    renderDraftHeader(draft);
    restoreFocusIfExpected();
  }

  /**
   * [CUSTOM- The host's resolved default directory (rides on 'boot').
   * Only the state that actually shows it needs a repaint: with a session or a draft
   * focused the address bar is showing something else, and the next render will pick
   * the new value up anyway (it is read, never copied).
   */
  function setDefaultCwd(value) {
    var next = typeof value === 'string' ? value : '';
    if (next === defaultCwd) { return; }
    defaultCwd = next;
    if (!state.focusedId && !state.focusedDraftId) { renderHeader(null); }
  }

  function restoreFocusIfExpected() {
    // [CUSTOM- Arrow navigation changed the selection, but the
    // re-render dropped DOM focus to <body>; put it back on the new active tab
    // so the next arrow key still works. Only done when the move came from the
    // keyboard — a mouse click should not steal focus.
    if (!tabFocusExpected) { return; }
    tabFocusExpected = false;
    var active = activeTabNode();
    if (active) { active.focus(); }
  }

  /** Let boot's draft path reuse the keyboard focus restore. */
  function expectTabFocus() { tabFocusExpected = true; }

  /**
   * [CUSTOM- Focus the first real session, if there is one.
   * Used when the last draft is discarded and something has to take over.
   */
  function focusFirstSession() {
    var models = tabModels();
    for (var i = 0; i < models.length; i++) {
      if (models[i].kind === 'session') {
        NS.bridge.post({ type: 'focusSession', sessionId: models[i].id });
        return true;
      }
    }
    return false;
  }

  NS.tabs = {
    init: init,
    setSessions: setSessions,
    setFocus: setFocus,
    setDrafts: setDrafts,
    setDraftFocus: setDraftFocus,
    expectTabFocus: expectTabFocus,
    focusFirstSession: focusFirstSession,
    // [CUSTOM- The history picker's filter default comes from here.
    currentCwd: currentCwd,
    // [CUSTOM- 手工 tab 顺序：宿主 globalState 那份，随 uiPrefs 消息到达。
    applyPrefs: applyPrefs,
    // [CUSTOM- 空态地址栏显示的那份默认目录（随 boot 消息到达）。
    setDefaultCwd: setDefaultCwd,
    // [CUSTOM- 待恢复的会话（本地 tab）：由 boot 的 restoreChoice 喂。
    setRestoring: setRestoring,
    // [CUSTOM- 会话 tab 右键菜单的 Close 入口（见 contextMenu.itemsFor）。
    closeTabNode: closeTabNode,
    // [CUSTOM- 快捷键 Alt+W：关闭当前活动 tab（与 × / 中键 / 右键 Close 同一条 closeModel）。
    closeActive: closeActive,
    // [CUSTOM- 会话 tab 右键菜单的 Rename 入口（面板内输入浮层）。
    startRename: startRename,
    // [CUSTOM- 前/后一个 tab（-1 / +1，首尾循环），快捷键入口。
    activateRelative: activateRelative,
    // [CUSTOM- 快捷键懒恢复的完结结果（宿主 'restoreFinished' 消息消费）。
    finishRestore: finishRestore,
    // [CUSTOM- 右键菜单「在右侧新建 Session」：把刚创建的草稿插到指定 tab 右边。
    placeDraftAfter: placeDraftAfter
  };
})(window.__vac = window.__vac || {});
`;
