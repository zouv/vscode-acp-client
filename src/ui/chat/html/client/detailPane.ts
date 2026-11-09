// [CUSTOM- Details 栏：把**当前检视的一张工具卡**完整渲染到右侧常驻栏。
//
// 为什么是"再渲染一份"而不是搬 DOM：toolCallView.update(node, tool, entryId) 是在
// 记录节点内部找 .tool-body 的，而引导条 / Tail / 滚动锚点都依赖记录节点留在 #messages。
// 复制一份只在这张卡被检视时运行，代价极小，且两边都不受影响。
//
// 本模块只做状态与容器；卡片本身仍由 toolCallView 用同一个视图模型渲染。
// markdown 往返用 'detail:' slot 前缀（与内联副本分开），同一段文本只问一次、两边都收。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
export const detailPaneClient = `
(function (NS) {
  'use strict';

  var SLOT_PREFIX = 'detail:';

  var root = null;        // #detailPane
  var bodyEl = null;      // .detail-pane-body（独立滚动）
  var kindEl = null;      // .detail-pane-kind
  var cardNode = null;    // 当前详情副本（toolCallView.render 的产物）
  var currentSessionId = null;
  var currentEntryId = null;
  // 按会话记"检视过哪一条"（客户端本地，随 vscode.setState 存活）。
  var bySession = {};

  /** IME 合成中（含死键 / AltGraph）的 Escape 属于输入法，不是详情栏的快捷键。 */
  function composing(event) {
    return !!(event && (event.isComposing || event.keyCode === 229 || event.key === 'Dead'
      || (event.getModifierState && event.getModifierState('AltGraph'))));
  }

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  function persist() {
    if (NS.boot && NS.boot.persistUi) {
      NS.boot.persistUi({
        detailPaneBySession: bySession,
        detailPaneWidth: lastWidth(),
        outlineWidthLocal: NS.outline && NS.outline.getOutlineWidth
          ? NS.outline.getOutlineWidth() : 0
      });
    }
  }

  function lastWidth() {
    if (NS.outline && NS.outline.getDetailWidth) {
      var detail = NS.outline.getDetailWidth();
      if (detail) { return detail; }
    }
    return NS.outline && NS.outline.getWidth ? NS.outline.getWidth() : 0;
  }

  function entryOf(id) {
    if (!id || !NS.transcriptView || !NS.transcriptView.entry) { return null; }
    return NS.transcriptView.entry(id);
  }

  /** Phase 1: only TOOL records have a detail view. */
  function isToolEntry(entry) {
    return !!entry && entry.kind === 'tool' && !!entry.toolView;
  }

  function isRunning(tool) {
    return !!tool && (tool.status === 'pending' || tool.status === 'in_progress');
  }

  function showEmpty() {
    if (!bodyEl) { return; }
    NS.dom.clear(bodyEl);
    cardNode = null;
    bodyEl.appendChild(NS.dom.el('div', 'detail-empty', "Open a card's details\\u2026"));
    if (kindEl) { kindEl.textContent = ''; kindEl.hidden = true; }
  }

  function renderKind(tool) {
    if (!kindEl) { return; }
    var label = tool ? (tool.toolName || tool.kind || '') : '';
    kindEl.textContent = label;
    kindEl.hidden = !label;
  }

  /** Independent scroll: pin to the bottom only while the call runs and the reader stays there. */
  function atBottom() {
    if (!bodyEl) { return true; }
    return bodyEl.scrollTop + bodyEl.clientHeight >= bodyEl.scrollHeight - 24;
  }

  function followBottom() {
    if (bodyEl) { bodyEl.scrollTop = bodyEl.scrollHeight; }
  }

  function renderCard(entry) {
    if (!bodyEl || !entry) { return; }
    NS.dom.clear(bodyEl);
    cardNode = NS.toolCallView.render(entry.toolView, entry.id, { slotPrefix: SLOT_PREFIX });
    // [CUSTOM- The detail copy is the "show me everything" surface: open its body
    // on first paint. This is the COPY's own expansion state; the inline card stays
    // collapsed exactly as before.
    var body = cardNode.querySelector('.tool-body');
    if (body) { body.hidden = false; }
    var head = cardNode.querySelector('.tool-head');
    if (head) {
      head.setAttribute('aria-expanded', 'true');
      var caret = head.querySelector('.tool-caret');
      if (caret) { caret.textContent = '\\u25be'; }
    }
    // The rail copy cannot usefully open a details pane — it is one.
    var buttons = cardNode.querySelectorAll('.tool-open-detail');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].parentNode) { buttons[i].parentNode.removeChild(buttons[i]); }
    }
    bodyEl.appendChild(cardNode);
    renderKind(entry.toolView);
    // [CUSTOM- Follow output only while the call is still running; a finished
    // card opens at its beginning, not at its tail.
    if (isRunning(entry.toolView)) { followBottom(); } else { bodyEl.scrollTop = 0; }
  }

  function paneIsDetails() {
    return !!(NS.outline && NS.outline.pane && NS.outline.pane() === 'details');
  }

  function remember(sessionId, entryId) {
    if (!sessionId) { return; }
    if (entryId) { bySession[sessionId] = entryId; }
    else if (hasOwn(bySession, sessionId)) { delete bySession[sessionId]; }
    persist();
  }

  /** Re-render/update from the transcript. Returns false when there is nothing to show. */
  function sync() {
    var entry = currentEntryId ? entryOf(currentEntryId) : null;
    if (!isToolEntry(entry)) {
      currentEntryId = null;
      remember(currentSessionId, null);
      showEmpty();
      return false;
    }
    if (cardNode && cardNode.parentNode === bodyEl) {
      var follow = isRunning(entry.toolView) && atBottom();
      NS.toolCallView.update(cardNode, entry.toolView, currentEntryId, { slotPrefix: SLOT_PREFIX });
      renderKind(entry.toolView);
      if (follow) { followBottom(); }
    } else {
      renderCard(entry);
    }
    return true;
  }

  function restoreForSession() {
    var remembered = currentSessionId ? bySession[currentSessionId] : '';
    var entry = entryOf(remembered);
    if (isToolEntry(entry)) {
      currentEntryId = remembered;
      if (NS.outline && NS.outline.openRail) { NS.outline.openRail(); }
      return sync();
    }
    if (remembered && currentSessionId) { delete bySession[currentSessionId]; persist(); }
    currentEntryId = null;
    showEmpty();
    return false;
  }

  /** Open one tool record in the rail's Details pane. */
  function open(entryId) {
    var entry = entryOf(entryId);
    if (!isToolEntry(entry)) { return; }
    currentEntryId = entryId;
    if (NS.outline && NS.outline.openRail) { NS.outline.openRail(); }
    remember(currentSessionId, entryId);
    sync();
  }

  /**
   * [CUSTOM- Focus changed (the single choke point, same shape as
   * outline.setSession / times.setFocus). Details are remembered per session; a
   * session whose entry no longer exists falls back to the calm empty state.
   */
  function setFocus(sessionId) {
    if (sessionId === currentSessionId) {
      // [CUSTOM- Same session: only re-sync a rail that is actually open. A focus
      // event must not undo the user's ✕ (closing keeps the mode; it does not
      // reopen by itself). Reopening goes through outline.show → onPaneChanged.
      if (paneIsDetails() && NS.outline && NS.outline.isOpen && NS.outline.isOpen()) {
        restoreForSession();
      }
      return;
    }
    currentSessionId = sessionId || null;
    currentEntryId = null;
    if (paneIsDetails()) {
      restoreForSession();
    } else {
      showEmpty();
    }
  }

  /** Transcript reset / hydrate: the detail copy points at nodes that no longer exist. */
  function onTranscriptReset() {
    currentEntryId = null;
    showEmpty();
  }

  /** A toolUpdate landed; keep the detail copy in step (same view model, same renderer). */
  function onEntryUpdated(entryId) {
    if (!currentEntryId || entryId !== currentEntryId) { return; }
    var entry = entryOf(entryId);
    if (!isToolEntry(entry)) {
      currentEntryId = null;
      remember(currentSessionId, null);
      showEmpty();
      return;
    }
    if (cardNode && cardNode.parentNode === bodyEl) {
      var follow = isRunning(entry.toolView) && atBottom();
      NS.toolCallView.update(cardNode, entry.toolView, entryId, { slotPrefix: SLOT_PREFIX });
      renderKind(entry.toolView);
      if (follow) { followBottom(); }
    } else {
      renderCard(entry);
    }
  }

  /** Details pane became visible / hidden (the rail owns the mode + width). */
  function onPaneChanged(pane) {
    if (pane !== 'details') { return; }
    if (!currentEntryId && currentSessionId) {
      var remembered = bySession[currentSessionId];
      if (isToolEntry(entryOf(remembered))) { currentEntryId = remembered; }
    }
    if (!sync()) { showEmpty(); }
  }

  /** Drag handle committed while Details owned the width. */
  function onWidthCommitted(width) {
    if (NS.outline && NS.outline.setDetailWidth) { NS.outline.setDetailWidth(width); }
    persist();
  }

  function focusInInput() {
    var active = document.activeElement;
    if (!active) { return false; }
    var tag = String(active.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!active.isContentEditable;
  }

  function floatingActive() {
    if (NS.popover && NS.popover.isOpen && NS.popover.isOpen()) { return true; }
    if (!NS.dom.qs) { return false; }
    var drawers = ['elicDrawer', 'permDrawer'];
    for (var i = 0; i < drawers.length; i++) {
      var drawer = NS.dom.qs(drawers[i]);
      if (drawer && !drawer.hidden) { return true; }
    }
    return false;
  }

  function focusTranscript() {
    if (!NS.dom.qs) { return; }
    var messages = NS.dom.qs('messages');
    if (messages && messages.focus) { messages.focus(); }
  }

  /**
   * [CUSTOM- Esc in Details mode: back to Outline, caret to the transcript.
   * Returns false (without consuming the key) when a floating layer or an input
   * owns the keystroke — outline.ts then leaves the rail alone.
   */
  function handleEscape(event) {
    if (!paneIsDetails() || composing(event)) { return false; }
    if (floatingActive() || focusInInput()) { return false; }
    if (NS.outline && NS.outline.setPane) { NS.outline.setPane('outline'); }
    focusTranscript();
    return true;
  }

  function readPrefs() {
    var ui = (NS.boot && NS.boot.recallUi) ? NS.boot.recallUi() : {};
    if (!ui) { return; }
    if (ui.detailPaneBySession && typeof ui.detailPaneBySession === 'object') {
      for (var key in ui.detailPaneBySession) {
        if (!hasOwn(ui.detailPaneBySession, key)) { continue; }
        var value = ui.detailPaneBySession[key];
        if (typeof value === 'string' && value) { bySession[key] = value; }
      }
    }
    if (typeof ui.detailPaneWidth === 'number' && NS.outline && NS.outline.setDetailWidth) {
      NS.outline.setDetailWidth(ui.detailPaneWidth);
    }
    if (typeof ui.outlineWidthLocal === 'number' && NS.outline && NS.outline.setOutlineWidth) {
      NS.outline.setOutlineWidth(ui.outlineWidthLocal);
    }
  }

  function init() {
    root = NS.dom.qs('detailPane');
    bodyEl = root && root.querySelector ? root.querySelector('.detail-pane-body') : null;
    kindEl = root && root.querySelector ? root.querySelector('.detail-pane-kind') : null;
    readPrefs();
    showEmpty();
  }

  NS.detailPane = {
    init: init,
    open: open,
    setFocus: setFocus,
    onEntryUpdated: onEntryUpdated,
    onTranscriptReset: onTranscriptReset,
    onPaneChanged: onPaneChanged,
    onWidthCommitted: onWidthCommitted,
    handleEscape: handleEscape
  };
})(window.__vac = window.__vac || {});
`;
