// 记录区「新输出自动展开」开关（2026-10-21）。
//
// 与 Times 完全同一形态（client/times.ts）：
// · autoExpandBySession —— 用户在那个会话里最后一次拨动的值；
// · autoExpandDefault   —— 没有记录的会话 / 草稿页用的默认值；
// · autoExpandKinds     —— **全局**卡片类型白名单（tool / thought / diff），由设置面板改。
// 有效值 = autoExpandBySession[会话] ?? autoExpandDefault。
//
// 真正的展开动作在 transcriptView.setAutoExpand / append 里（只有 live 输出，不含 hydrate）。
// 本模块只负责状态、按钮与持久化。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
export const autoExpandClient = `
(function (NS) {
  'use strict';

  var toggleEl = null;
  var currentSessionId = null;
  var bySession = {};
  var fallback = false;
  // [CUSTOM- 没写过这一项时的默认卡片类型：推理块 + 工具卡（最常用的两种）。
  // 用户在设置面板里取消勾选后，宿主会明确发回 []，那时就真的一个都不展开。
  var kinds = ['thought', 'tool'];
  // [CUSTOM- 自动展开卡片的限高（px，0 = 不限）。只对"自动展开"的卡生效，
  // 手动点开的不受限；写在 body 的 CSS 变量上，由 styles.ts 的两条规则消费。
  var toolHeight = 360;
  var thoughtHeight = 240;
  var known = [];

  function enabledFor(sessionId) {
    if (sessionId && Object.prototype.hasOwnProperty.call(bySession, sessionId)) {
      return bySession[sessionId] === true;
    }
    return fallback === true;
  }

  /** 限高值：0 表示不限；其余 80–2000。非法值回落默认。 */
  function heightOf(value, fallback) {
    var n = Number(value);
    if (!isFinite(n)) { return fallback; }
    if (n <= 0) { return 0; }
    return Math.max(80, Math.min(2000, Math.round(n)));
  }

  function applySizes() {
    if (!document.body || !document.body.style || !document.body.style.setProperty) { return; }
    document.body.style.setProperty('--vac-tool-expand-h', toolHeight > 0 ? toolHeight + 'px' : 'none');
    document.body.style.setProperty('--vac-thought-expand-h', thoughtHeight > 0 ? thoughtHeight + 'px' : 'none');
  }

  /** 把当前状态推给记录层，并更新按钮。改默认值、换会话、改卡片类型都会走到这里。 */
  function apply() {
    var on = enabledFor(currentSessionId);
    if (NS.transcriptView && NS.transcriptView.setAutoExpand) {
      NS.transcriptView.setAutoExpand(on, kinds);
    }
    if (toggleEl) {
      toggleEl.className = on ? 'nest-toggle on' : 'nest-toggle off';
      toggleEl.title = on
        ? 'Stop expanding cards as new output arrives'
        : 'Expand cards as new output arrives';
      toggleEl.setAttribute('aria-pressed', on ? 'true' : 'false');
    }
  }

  /** 只带本面知道的会话（与 times.pruned 同一理由：表随会话增长，需要裁剪）。 */
  function pruned() {
    var out = {};
    for (var i = 0; i < known.length; i++) {
      var id = known[i];
      if (Object.prototype.hasOwnProperty.call(bySession, id)) { out[id] = bySession[id] === true; }
    }
    return out;
  }

  function persist() {
    NS.bridge.post({
      type: 'setUiPref',
      autoExpandBySession: pruned(),
      autoExpandDefault: fallback === true,
      autoExpandKinds: kinds.slice()
    });
  }

  function noteSessions(sessions) {
    var ids = [];
    for (var i = 0; i < sessions.length; i++) {
      var id = sessions[i] && sessions[i].sessionId;
      if (id) { ids.push(id); }
    }
    known = ids;
  }

  function setFocus(sessionId) {
    currentSessionId = sessionId || null;
    if (currentSessionId && known.indexOf(currentSessionId) < 0) { known.push(currentSessionId); }
    apply();
  }

  /** 收下宿主那份偏好。缺字段 = 那一项从来没被写过 ⇒ 保留本地值（同 times.applyPrefs）。 */
  function applyPrefs(prefs) {
    if (prefs && prefs.autoExpandBySession && typeof prefs.autoExpandBySession === 'object') {
      var next = {};
      for (var key in prefs.autoExpandBySession) {
        if (Object.prototype.hasOwnProperty.call(prefs.autoExpandBySession, key)) {
          next[key] = prefs.autoExpandBySession[key] === true;
        }
      }
      bySession = next;
    }
    if (prefs && typeof prefs.autoExpandDefault === 'boolean') { fallback = prefs.autoExpandDefault; }
    if (prefs && Object.prototype.toString.call(prefs.autoExpandKinds) === '[object Array]') {
      var list = [];
      for (var i = 0; i < prefs.autoExpandKinds.length; i++) {
        var kind = String(prefs.autoExpandKinds[i]);
        if ((kind === 'tool' || kind === 'thought' || kind === 'diff') && list.indexOf(kind) < 0) {
          list.push(kind);
        }
      }
      kinds = list;
    }
    if (prefs) {
      if (prefs.autoExpandToolHeight !== undefined) {
        toolHeight = heightOf(prefs.autoExpandToolHeight, 360);
      }
      if (prefs.autoExpandThoughtHeight !== undefined) {
        thoughtHeight = heightOf(prefs.autoExpandThoughtHeight, 240);
      }
    }
    applySizes();
    apply();
  }

  function init() {
    toggleEl = NS.dom.qs('autoExpandBtn');
    if (toggleEl && NS.icons && NS.icons.icon) {
      NS.dom.clear(toggleEl);
      var glyph = NS.icons.icon('expand', 'auto-expand-icon');
      if (glyph) { toggleEl.appendChild(glyph); }
      toggleEl.setAttribute('aria-label', 'Auto-expand new output');
    }
    if (toggleEl) {
      toggleEl.addEventListener('click', function () {
        var on = !enabledFor(currentSessionId);
        // 与 Times 同一条语义：记到这个会话名下，同时成为默认值。
        fallback = on;
        if (currentSessionId) { bySession[currentSessionId] = on; }
        apply();
        persist();
      });
    }
    applySizes();
    apply();
  }

  NS.autoExpand = {
    init: init,
    setFocus: setFocus,
    applyPrefs: applyPrefs,
    noteSessions: noteSessions,
    isOn: function () { return enabledFor(currentSessionId); },
    kinds: function () { return kinds.slice(); }
  };
})(window.__vac = window.__vac || {});
`;
