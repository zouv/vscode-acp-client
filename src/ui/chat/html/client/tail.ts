// 地址栏「Tail」（消息面板自动追尾）开关：状态与接线（2026-10-28）。
//
// 与 Times 完全同一形态（client/times.ts）：
// · tailBySession —— 用户在那个会话里最后一次拨动的值；
// · tailDefault   —— 没有记录的会话 / 草稿页用的默认值（默认 **true**：不开按钮时也照旧
//   跟到最后一条，那是改动前就有的行为，按钮只是把它显式化、可关掉）；
// · 有效值 = tailBySession[会话] ?? tailDefault。
//
// 运行时真正"追"的动作在 scroll.ts（`setTail` / `follow`）。两条退出条件都在那边：
// 用户用滚轮或拖动滚动条改变了阅读进度（`cancelFromScroll`），以及换会话时恢复到一个
// 用户自己选的中间位置（`cancelFromRestore`）。**两条都不改默认值**：滚动不是"拨偏好"。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
export const tailClient = `
(function (NS) {
  'use strict';

  var toggleEl = null;
  // 谁在聚焦（由 boot 的焦点咽喉点喂进来）—— 拨开关时要记到它名下。
  var currentSessionId = null;
  var bySession = {};
  var fallback = true;
  // 本面当前知道的会话 id：写回宿主前用它裁表（见 pruned）。
  var known = [];
  // 宿主的偏好到了之前不许"落定"任何会话：否则会用本地的默认值把用户真正的选择盖掉。
  var prefsSeen = false;

  /** 这个会话此刻该不该自动追尾：它自己的记录，没有就回落默认。 */
  function enabledFor(sessionId) {
    if (sessionId && Object.prototype.hasOwnProperty.call(bySession, sessionId)) {
      return bySession[sessionId] === true;
    }
    return fallback === true;
  }

  /**
   * 把状态推给 scroll，并更新按钮。
   * 'immediate' 只有"用户点了按钮"那一次为 true —— 换会话时由 restore 决定落点。
   */
  function apply(immediate) {
    var on = enabledFor(currentSessionId);
    if (NS.scroll && NS.scroll.setTail) { NS.scroll.setTail(on, immediate === true); }
    if (toggleEl) {
      toggleEl.className = on ? 'nest-toggle on' : 'nest-toggle off';
      toggleEl.title = on
        ? 'Following new output — scroll to stop'
        : 'Follow new output automatically';
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
    NS.bridge.post({ type: 'setUiPref', tailBySession: pruned(), tailDefault: fallback === true });
  }

  /**
   * [CUSTOM- **把"已开启的会话"落定**（用户 2026-10-28 的要求：改开关只影响当前会话，
   * 只有**下一个新开的会话**才继承新默认值）。
   *
   * 没有这一步时，"A 会话里拨开关"会连带改掉所有**没有记录**的会话（它们回落到默认值）——
   * 表现就是"改了 A，切到 B 发现它也变了"。给每个已知会话补一条当时的有效值，
   * 之后默认值怎么变都与它们无关。
   */
  function seedKnown() {
    if (!prefsSeen) { return; }
    var changed = false;
    for (var i = 0; i < known.length; i++) {
      var id = known[i];
      if (!Object.prototype.hasOwnProperty.call(bySession, id)) {
        bySession[id] = fallback === true;
        changed = true;
      }
    }
    if (changed) { persist(); }
  }

  function noteSessions(sessions) {
    var ids = [];
    for (var i = 0; i < sessions.length; i++) {
      var id = sessions[i] && sessions[i].sessionId;
      if (id) { ids.push(id); }
    }
    known = ids;
    seedKnown();
  }

  /** 焦点变了：换成**这个会话**的值（boot 的 applyFocus 是唯一咽喉点）。 */
  function setFocus(sessionId) {
    currentSessionId = sessionId || null;
    if (currentSessionId && known.indexOf(currentSessionId) < 0) { known.push(currentSessionId); }
    seedKnown();
    apply(false);
  }

  /** 收下宿主那份偏好。缺字段 = 那一项从来没被写过 ⇒ 保留本地值（同 times.applyPrefs）。 */
  function applyPrefs(prefs) {
    prefsSeen = true;
    if (prefs && prefs.tailBySession && typeof prefs.tailBySession === 'object') {
      var next = {};
      for (var key in prefs.tailBySession) {
        if (Object.prototype.hasOwnProperty.call(prefs.tailBySession, key)) {
          next[key] = prefs.tailBySession[key] === true;
        }
      }
      bySession = next;
    }
    if (prefs && typeof prefs.tailDefault === 'boolean') { fallback = prefs.tailDefault; }
    seedKnown();
    apply(false);
  }

  /** 用户滚动改了阅读进度（scroll.ts 调）：关掉这个会话的 Tail，不动默认值。 */
  function cancelFromScroll() { setOff(); }

  /** 换会话时恢复到了用户自己选的中间位置（scroll.ts 调）：同上。 */
  function cancelFromRestore() { setOff(); }

  function setOff() {
    if (!currentSessionId) { return; }
    if (bySession[currentSessionId] === false) { return; }
    bySession[currentSessionId] = false;
    apply(false);
    persist();
  }

  function init() {
    toggleEl = NS.dom.qs('tailBtn');
    if (toggleEl && NS.icons && NS.icons.icon) {
      NS.dom.clear(toggleEl);
      var glyph = NS.icons.icon('tail', 'tail-icon');
      if (glyph) { toggleEl.appendChild(glyph); }
      toggleEl.setAttribute('aria-label', 'Follow new output');
    }
    apply(false);
    if (toggleEl) {
      toggleEl.addEventListener('click', function () {
        var on = !enabledFor(currentSessionId);
        // 与 Times 同一条语义：记到这个会话名下，同时成为默认值（新会话沿用最后一次拨的值）。
        fallback = on;
        if (currentSessionId) { bySession[currentSessionId] = on; }
        apply(true);
        persist();
      });
    }
  }

  NS.tail = {
    init: init,
    apply: apply,
    setFocus: setFocus,
    applyPrefs: applyPrefs,
    noteSessions: noteSessions,
    cancelFromScroll: cancelFromScroll,
    cancelFromRestore: cancelFromRestore,
    isOn: function () { return enabledFor(currentSessionId); }
  };
})(window.__vac = window.__vac || {});
`;
