// [CUSTOM- 2026-11-16] 消息面板内搜索（Ctrl/Cmd+F）。
//
// 只搜记录区 #messages，不碰输入框、大纲、侧栏与置顶副本。默认范围是**对话正文**
// （用户 / 助手 / 推理 / plan / notice / compact）；勾上 "All cards" 后覆盖整片记录区
// （工具卡的命令输出、diff 等）。勾选状态经宿主 uiPrefs 持久化，新会话沿用。
//
// 高亮用 CSS Custom Highlight API（`CSS.highlights` + `Highlight`），**不往 DOM 里塞
// <mark>**：记录区是流式增量渲染的，任何额外的 DOM 包裹都会被下一次 patch/重建抹掉，
// 而 Range 只指向文本节点，重扫一次就能跟上新文档。没有该 API 的环境（旧 Electron）
// 仍能逐条定位，只是没有底色。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号，
// 且不要写含 `/` 的正则（见 arch/chat-panel.md §5.2）。
export const findBarClient = `
(function (NS) {
  'use strict';

  var MAX_MATCHES = 4000;
  var SKIP_TAGS = {
    BUTTON: true, INPUT: true, TEXTAREA: true, SELECT: true,
    SVG: true, SCRIPT: true, STYLE: true
  };
  var PROSE_KEYS = [
    'entry-user', 'entry-assistant', 'thought', 'plan', 'entry-notice', 'entry-compact'
  ];

  var bar = null;
  var inputEl = null;
  var countEl = null;
  var allCardsEl = null;
  var shown = false;
  var query = '';
  var allCards = false;
  var ranges = [];
  var current = -1;
  var scanTimer = null;
  var observer = null;
  var installed = false;

  function composing(event) {
    return !!(event && (event.isComposing || event.keyCode === 229 || event.key === 'Dead'
      || (event.getModifierState && event.getModifierState('AltGraph'))));
  }

  function hasClass(node, name) {
    var cls = node && typeof node.className === 'string' ? node.className : '';
    if (!cls) { return false; }
    var parts = cls.split(' ');
    for (var i = 0; i < parts.length; i++) { if (parts[i] === name) { return true; } }
    return false;
  }

  function isProseRoot(node) {
    for (var i = 0; i < PROSE_KEYS.length; i++) {
      if (hasClass(node, PROSE_KEYS[i])) { return true; }
    }
    return false;
  }

  /** UI chrome inside a card is not "message content" (times, buttons, inputs). */
  function isSkipped(node) {
    if (!node || node.nodeType !== 1) { return false; }
    if (SKIP_TAGS[node.tagName]) { return true; }
    if (node.hidden === true) { return true; }
    if (node.getAttribute && node.getAttribute('hidden') !== null) { return true; }
    if (hasClass(node, 'rec-time')) { return true; }
    return false;
  }

  /**
   * Depth-first walk over #messages. 'prose' records whether an ancestor is one of the
   * dialogue-body cards, so the default scope can skip tool/permission/form cards
   * without touching the DOM.
   */
  function walk(node, prose, visit) {
    // childNodes rather than firstChild/nextSibling: the array shape is identical in a
    // real DOM and it keeps this module drivable from the stub-DOM tests.
    var children = node.childNodes || [];
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.nodeType === 3) {
        if (allCards || prose) { visit(child); }
      } else if (child.nodeType === 1 && !isSkipped(child)) {
        walk(child, prose || isProseRoot(child), visit);
      }
    }
  }

  function collect(node, needle) {
    // nodeValue is the DOM truth; the data/textContent fallbacks keep this module
    // drivable from the stub-DOM tests (their text nodes expose .data only).
    var raw = node.nodeValue;
    var text = raw === undefined || raw === null ? String(node.data || '') : String(raw);
    if (!text) { return; }
    var lower = text.toLowerCase();
    var at = 0;
    while (ranges.length < MAX_MATCHES) {
      var hit = lower.indexOf(needle, at);
      if (hit < 0) { return; }
      var range = document.createRange();
      range.setStart(node, hit);
      range.setEnd(node, hit + needle.length);
      ranges.push(range);
      at = hit + needle.length;
    }
  }

  function clearHighlights() {
    if (!(window.CSS && window.CSS.highlights)) { return; }
    window.CSS.highlights.delete('vac-find');
    window.CSS.highlights.delete('vac-find-current');
  }

  function paint() {
    if (!(window.CSS && window.CSS.highlights && typeof window.Highlight === 'function')) { return; }
    if (ranges.length === 0) { clearHighlights(); return; }
    try {
      var all = new window.Highlight();
      for (var i = 0; i < ranges.length; i++) { all.add(ranges[i]); }
      window.CSS.highlights.set('vac-find', all);
      if (current >= 0 && ranges[current]) {
        window.CSS.highlights.set('vac-find-current', new window.Highlight(ranges[current]));
      } else {
        window.CSS.highlights.delete('vac-find-current');
      }
    } catch (e) {
      // A range can point at a node a streaming re-render just detached; the next
      // MutationObserver pass replaces it. Never let the paint break navigation.
      clearHighlights();
    }
  }

  function updateCount() {
    if (!countEl) { return; }
    if (!shown || query.length === 0) { countEl.textContent = ''; return; }
    countEl.textContent = ranges.length === 0
      ? 'No results'
      : (current + 1) + '/' + ranges.length;
  }

  function scan(scrollToCurrent) {
    ranges = [];
    current = -1;
    var messages = NS.dom.qs('messages');
    var needle = query.toLowerCase();
    if (!shown || !messages || needle.length === 0) {
      paint();
      updateCount();
      return;
    }
    walk(messages, false, function (node) { collect(node, needle); });
    if (ranges.length > 0) { current = 0; }
    paint();
    updateCount();
    if (scrollToCurrent && current >= 0) { revealAndScroll(); }
  }

  /**
   * A match may live inside a collapsed <details> (folded assistant answer / thoughts).
   * The user asked for navigation, so open the fold instead of silently highlighting
   * text nobody can see. The Range survives (the text node is not replaced).
   */
  function revealAncestors(range) {
    var node = range.startContainer;
    var el = node && node.nodeType === 3 ? node.parentNode : node;
    while (el && el.nodeType === 1) {
      if (el.tagName === 'DETAILS' && el.open !== true) { el.open = true; }
      el = el.parentNode;
    }
  }

  function revealAndScroll() {
    var range = ranges[current];
    if (!range) { return; }
    revealAncestors(range);
    var messages = NS.dom.qs('messages');
    if (!messages || !range.getBoundingClientRect || !messages.getBoundingClientRect) { return; }
    var rect = range.getBoundingClientRect();
    var box = messages.getBoundingClientRect();
    if (!box.height) { return; }
    var top = rect.top - box.top;
    var bottom = rect.bottom - box.top;
    if (top >= 4 && bottom <= box.height - 4) { return; }
    var target = messages.scrollTop + top - box.height / 2;
    // jumpToOffset 同时关掉 Tail（用户主动离开底部），避免下一帧又把视口拽回去。
    if (NS.scroll && NS.scroll.jumpToOffset) { NS.scroll.jumpToOffset(target); }
    else { messages.scrollTop = target; }
  }

  function scheduleScan(scrollToCurrent) {
    if (scanTimer !== null) { window.clearTimeout(scanTimer); }
    scanTimer = window.setTimeout(function () {
      scanTimer = null;
      scan(scrollToCurrent === true);
    }, 120);
  }

  function step(delta) {
    if (!shown) { openBar(); return; }
    if (ranges.length === 0) { scan(true); return; }
    current = (current + delta + ranges.length) % ranges.length;
    paint();
    updateCount();
    revealAndScroll();
  }

  function openBar() {
    if (!bar) { return; }
    shown = true;
    bar.hidden = false;
    query = inputEl ? String(inputEl.value || '') : '';
    if (inputEl && inputEl.focus) {
      inputEl.focus();
      if (inputEl.select) { inputEl.select(); }
    }
    scan(true);
  }

  function closeBar() {
    if (!shown) { return; }
    shown = false;
    ranges = [];
    current = -1;
    if (bar) { bar.hidden = true; }
    clearHighlights();
    updateCount();
  }

  function applyPrefs(prefs) {
    var next = !!(prefs && prefs.findAllCards === true);
    allCards = next;
    if (allCardsEl) { allCardsEl.checked = next; }
    if (shown && query.length > 0) { scan(true); }
  }

  function onGlobalKey(event) {
    if (!event || composing(event)) { return; }
    var mod = event.ctrlKey || event.metaKey;
    if (mod && !event.altKey && (event.code === 'KeyF' || event.key === 'f' || event.key === 'F')) {
      if (NS.settingsPanel && NS.settingsPanel.isOpen && NS.settingsPanel.isOpen()) { return; }
      if (NS.popover && NS.popover.isOpen && NS.popover.isOpen()) { return; }
      if (event.preventDefault) { event.preventDefault(); }
      if (event.stopPropagation) { event.stopPropagation(); }
      openBar();
      return;
    }
    // [CUSTOM- F3 只在搜索条打开时才是"下一个命中"：关闭状态下这颗键
    // 归面板的会话历史开关（见 client/shortcuts.ts 的固定键），不能再被这里
    // 顺手拿去打开搜索条。
    if (event.key === 'F3' && shown) {
      if (event.preventDefault) { event.preventDefault(); }
      if (event.stopPropagation) { event.stopPropagation(); }
      step(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === 'Escape' && shown && event.target && bar && bar.contains
      && bar.contains(event.target)) {
      if (event.preventDefault) { event.preventDefault(); }
      if (event.stopPropagation) { event.stopPropagation(); }
      closeBar();
    }
  }

  function install() {
    if (installed) { return; }
    installed = true;
    bar = NS.dom.qs('findBar');
    if (!bar) { return; }
    inputEl = NS.dom.qs('findInput');
    countEl = NS.dom.qs('findCount');
    allCardsEl = NS.dom.qs('findAllCards');
    var prev = NS.dom.qs('findPrev');
    var next = NS.dom.qs('findNext');
    var close = NS.dom.qs('findClose');

    if (inputEl) {
      inputEl.addEventListener('input', function () {
        query = String(inputEl.value || '');
        // Typing is an explicit "take me to the match" action. The observer below uses
        // scan(false) instead, so streaming output never yanks the viewport.
        scheduleScan(true);
      });
      inputEl.addEventListener('keydown', function (event) {
        if (composing(event)) { return; }
        if (event.key === 'Enter') {
          if (event.preventDefault) { event.preventDefault(); }
          if (event.stopPropagation) { event.stopPropagation(); }
          step(event.shiftKey ? -1 : 1);
        } else if (event.key === 'Escape') {
          if (event.preventDefault) { event.preventDefault(); }
          if (event.stopPropagation) { event.stopPropagation(); }
          closeBar();
        }
      });
    }
    if (prev) { prev.addEventListener('click', function (event) { event.preventDefault(); step(-1); }); }
    if (next) { next.addEventListener('click', function (event) { event.preventDefault(); step(1); }); }
    if (close) { close.addEventListener('click', function (event) { event.preventDefault(); closeBar(); }); }
    if (allCardsEl) {
      // uiPrefs may have arrived before init (the host pushes it at attach time);
      // applyPrefs stored the value but could not touch the checkbox yet.
      allCardsEl.checked = allCards === true;
      allCardsEl.addEventListener('change', function () {
        allCards = allCardsEl.checked === true;
        if (NS.bridge && NS.bridge.post) {
          NS.bridge.post({ type: 'setUiPref', findAllCards: allCards });
        }
        if (query.length > 0) { scan(true); }
      });
    }

    document.addEventListener('keydown', onGlobalKey, true);

    // Streaming/re-render changes text nodes; ranges would go stale. Rescan while the
    // bar is open (debounced) so the count and highlights stay truthful.
    var messages = NS.dom.qs('messages');
    if (messages && window.MutationObserver) {
      observer = new window.MutationObserver(function () {
        if (shown && query.length > 0) { scheduleScan(false); }
      });
      observer.observe(messages, { childList: true, subtree: true, characterData: true });
    }
    closeBar();
  }

  NS.find = {
    init: install,
    open: openBar,
    close: closeBar,
    applyPrefs: applyPrefs
  };
})(window.__vac = window.__vac || {});
`;
