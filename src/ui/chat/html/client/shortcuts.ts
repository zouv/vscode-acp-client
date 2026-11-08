export const shortcutsClient = `
(function (NS) {
  'use strict';

  var bindings = {
    scrollTop: 'Alt+KeyA',
    scrollBottom: 'Alt+KeyE',
    focusInput: 'Alt+KeyI',
    previousSession: 'Alt+KeyP',
    nextSession: 'Alt+KeyN',
    closeSession: 'Alt+KeyW',
    restoreClosed: 'Alt+KeyT'
  };
  var installed = false;
  var navigationKeys = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];

  function fromEvent(event) {
    if (!event || event.isComposing || event.keyCode === 229 || event.key === 'Dead'
        || (event.getModifierState && event.getModifierState('AltGraph'))) { return null; }
    var code = event.code || '';
    var valid = (code.length === 4 && code.slice(0, 3) === 'Key' && code.charAt(3) >= 'A' && code.charAt(3) <= 'Z')
      || (code.length === 6 && code.slice(0, 5) === 'Digit' && code.charAt(5) >= '0' && code.charAt(5) <= '9')
      || navigationKeys.indexOf(code) >= 0;
    if (!valid) { return null; }
    // macOS 的 Option 会产出真实字符（Option+A → å），而默认 Alt 快捷键正是字母键。
    // 键面字符与物理 code 的字母不一致 ⇒ 这次按下的意图是输入，不是快捷键。
    // 方向键 / Home / End 等非字母 code 不受影响。
    if (code.length === 4 && code.slice(0, 3) === 'Key') {
      var typed = typeof event.key === 'string' ? event.key : '';
      if (typed.length === 1 && typed.toLowerCase() !== code.charAt(3).toLowerCase()) { return null; }
    }
    // Shift 只能叠加：仅 Shift 的绑定会吞掉正常的大写文本输入。
    if (!event.ctrlKey && !event.altKey && !event.metaKey) { return null; }
    var modifiers = [];
    if (event.ctrlKey) { modifiers.push('Ctrl'); }
    if (event.altKey) { modifiers.push('Alt'); }
    if (event.shiftKey) { modifiers.push('Shift'); }
    if (event.metaKey) { modifiers.push('Meta'); }
    modifiers.push(code);
    return modifiers.join('+');
  }

  function applyPrefs(prefs) {
    if (!prefs || !prefs.shortcuts) { return; }
    var next = prefs.shortcuts;
    Object.keys(bindings).forEach(function (action) {
      if (Object.prototype.hasOwnProperty.call(next, action)) { bindings[action] = next[action]; }
    });
  }

  function visible(id) {
    var node = document.getElementById && document.getElementById(id);
    return !!node && !node.hidden;
  }

  function blocked(event) {
    if ((NS.settingsPanel && NS.settingsPanel.isOpen && NS.settingsPanel.isOpen())
        || (NS.popover && NS.popover.isOpen && NS.popover.isOpen())) { return true; }
    var overlays = ['imageLightbox', 'ctxMenu', 'history', 'cwdMenu', 'slashPopup', 'stopConfirm'];
    for (var i = 0; i < overlays.length; i++) {
      if (visible(overlays[i])) { return true; }
    }
    if (document.querySelector && document.querySelector('.picker-menu.open')) { return true; }
    var target = event.target;
    if (target && target.closest) {
      if (target.closest('#elicDrawer, #permDrawer, #outline, #outlineSidebar')) { return true; }
      if (target.closest('input, textarea, select, [contenteditable]') && !target.closest('#composer')) { return true; }
    }
    return false;
  }

  function execute(action) {
    if (action === 'scrollTop' && NS.scroll && NS.scroll.jumpToTop) { NS.scroll.jumpToTop(); }
    else if (action === 'scrollBottom' && NS.scroll && NS.scroll.jumpToLatest) { NS.scroll.jumpToLatest(); }
    else if (action === 'focusInput' && NS.composer && NS.composer.isComposable
        && NS.composer.isComposable() && NS.composer.focusInput) { NS.composer.focusInput(); }
    else if (action === 'previousSession' && NS.tabs && NS.tabs.activateRelative) { NS.tabs.activateRelative(-1); }
    else if (action === 'nextSession' && NS.tabs && NS.tabs.activateRelative) { NS.tabs.activateRelative(1); }
    // 与 tab 上的 × / 中键 / 右键 Close 共用 closeModel 那条路（草稿丢弃、待恢复遗忘、
    // 运行中二次确认都在那里，不另写一份）。
    else if (action === 'closeSession' && NS.tabs && NS.tabs.closeActive) { NS.tabs.closeActive(); }
    // 还原上一个关闭的会话：宿主持有撤销栈（关会话的地方只有它），这里只需发一个面板级请求。
    else if (action === 'restoreClosed' && NS.bridge && NS.bridge.post) { NS.bridge.post({ type: 'restoreLastClosed' }); }
  }

  function onKeyDown(event) {
    if (!event || event.defaultPrevented || blocked(event)) { return; }
    var shortcut = fromEvent(event);
    if (!shortcut) { return; }
    var actions = Object.keys(bindings);
    for (var i = 0; i < actions.length; i++) {
      if (bindings[actions[i]] !== shortcut) { continue; }
      // 重复 keydown 仍要挡住冒泡（否则工作台会收到连发），但动作只执行一次。
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) { execute(actions[i]); }
      return;
    }
  }

  function init() {
    if (installed || !document.addEventListener) { return; }
    installed = true;
    document.addEventListener('keydown', onKeyDown);
  }

  NS.shortcuts = { init: init, applyPrefs: applyPrefs, fromEvent: fromEvent };
})(window.__vac = window.__vac || {});
`;
