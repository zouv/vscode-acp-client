// 面板内通用浮层：非模态确认框 / 输入框。
//
// 为什么不用宿主的 showWarningMessage / showInputBox：前者是窗口级 modal（挡住整个 IDE），
// 后者在窗口顶部抢焦点——两者都会打断别的会话。这里只盖住面板内一个小浮层，点外面 / Esc
// 即取消，不铺背景遮罩，也不改窗口状态。
//
// 调用约定（opts）：
//   confirm: { title?, message, confirmLabel, cancelLabel?, danger?, anchor?, event?, onConfirm }
//   prompt:  { title?, message?, value, placeholder?, confirmLabel?, cancelLabel?, anchor?, event?, onSubmit }
// `anchor` 是定位参照（通常是刚点的按钮）；`event` 是打开浮层的那个 click 事件——
// 同一个事件会继续冒泡到 document，不认出来就会"刚打开就被外面的关闭判据关掉"。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
export const popoverClient = `
(function (NS) {
  'use strict';

  var root = null;
  var titleEl = null;
  var messageEl = null;
  var inputWrap = null;
  var inputEl = null;
  var actionsEl = null;
  var kind = null;
  var callback = null;
  var openedBy = null;

  function isOpen() { return !!root && !root.hidden; }

  function close() {
    if (!root || root.hidden) { return; }
    root.hidden = true;
    kind = null;
    callback = null;
    openedBy = null;
  }

  /** Enter / 确认按钮：先关再回调，避免回调里再开一个浮层时被本层的 close 关掉。 */
  function submit() {
    var cb = callback;
    var wasPrompt = kind === 'prompt';
    var value = null;
    if (wasPrompt) {
      value = inputEl && inputEl.value !== undefined && inputEl.value !== null
        ? String(inputEl.value) : '';
    }
    close();
    if (!cb) { return; }
    if (wasPrompt) { cb(value); } else { cb(); }
  }

  /** 锚点下方优先；越界翻到上方；左右/上下都夹在视口内。 */
  function place(anchor) {
    if (!root) { return; }
    var rect = anchor && anchor.getBoundingClientRect ? anchor.getBoundingClientRect() : null;
    var hasRect = !!rect && (rect.left !== 0 || rect.top !== 0 || rect.width !== 0 || rect.height !== 0);
    var x = hasRect ? rect.left : Math.max(8, ((window.innerWidth || 0) - 220) / 2);
    var y = hasRect ? rect.bottom + 6 : 72;
    root.style.left = x + 'px';
    root.style.top = y + 'px';
    var box = root.getBoundingClientRect ? root.getBoundingClientRect() : null;
    if (!box) { return; }
    var width = box.width || 0;
    var height = box.height || 0;
    var maxLeft = Math.max(8, (window.innerWidth || 0) - width - 8);
    if (x > maxLeft) { root.style.left = maxLeft + 'px'; }
    if (x < 8) { root.style.left = '8px'; }
    var maxTop = Math.max(8, (window.innerHeight || 0) - height - 8);
    if (y > maxTop) {
      var above = hasRect && rect.top ? rect.top - height - 6 : maxTop;
      root.style.top = Math.max(8, above) + 'px';
    }
  }

  function makeButton(label, action, danger) {
    var btn = NS.dom.el('button', 'popover-btn' + (danger ? ' danger' : ''), label);
    btn.type = 'button';
    btn.setAttribute('data-popover-action', action);
    btn.addEventListener('click', function (event) {
      if (event.preventDefault) { event.preventDefault(); }
      if (event.stopPropagation) { event.stopPropagation(); }
      if (action === 'cancel') { close(); } else { submit(); }
    });
    return btn;
  }

  function renderConfirm(opts) {
    titleEl.hidden = !opts.title;
    titleEl.textContent = opts.title || '';
    messageEl.textContent = opts.message || '';
    inputWrap.hidden = true;
    NS.dom.clear(actionsEl);
    actionsEl.appendChild(makeButton(opts.cancelLabel || 'Cancel', 'cancel', false));
    var ok = makeButton(opts.confirmLabel || 'OK', 'confirm', !!opts.danger);
    actionsEl.appendChild(ok);
    // 危险操作默认停在 Cancel：误按回车不会删东西。
    var focusTarget = opts.danger ? actionsEl.firstChild : ok;
    if (focusTarget && focusTarget.focus) { focusTarget.focus(); }
  }

  function renderPrompt(opts) {
    titleEl.hidden = !opts.title;
    titleEl.textContent = opts.title || '';
    messageEl.textContent = opts.message || '';
    inputWrap.hidden = false;
    inputEl.value = opts.value === undefined || opts.value === null ? '' : String(opts.value);
    inputEl.placeholder = opts.placeholder || '';
    NS.dom.clear(actionsEl);
    actionsEl.appendChild(makeButton(opts.cancelLabel || 'Cancel', 'cancel', false));
    actionsEl.appendChild(makeButton(opts.confirmLabel || 'OK', 'confirm', false));
    inputEl.focus();
    if (inputEl.select) { inputEl.select(); }
  }

  /** Opens the popover; false when it is not installed (callers keep their old path). */
  function open(opts, nextKind, cb) {
    if (!root) { return false; }
    kind = nextKind;
    callback = cb || null;
    openedBy = opts.event || null;
    // 先渲染再显示：hide 状态下量不到尺寸（place 依赖真实 rect）。
    if (nextKind === 'prompt') { renderPrompt(opts); } else { renderConfirm(opts); }
    root.hidden = false;
    place(opts.anchor);
    return true;
  }

  function confirm(opts) {
    opts = opts || {};
    return open(opts, 'confirm', opts.onConfirm);
  }

  function prompt(opts) {
    opts = opts || {};
    return open(opts, 'prompt', opts.onSubmit);
  }

  function install() {
    root = NS.dom.qs('popover');
    if (!root) { return; }
    titleEl = root.querySelector('.popover-title');
    messageEl = root.querySelector('.popover-message');
    inputWrap = root.querySelector('.popover-input-wrap');
    inputEl = root.querySelector('.popover-input');
    actionsEl = root.querySelector('.popover-actions');
    // 浮层里的点击不冒泡：历史抽屉 / 设置面板都有"点外面关闭"的 document 监听，
    // 不拦住的话点确认按钮会先把抽屉/面板关掉。
    root.addEventListener('click', function (event) {
      if (event.stopPropagation) { event.stopPropagation(); }
    });
    root.addEventListener('mousedown', function (event) {
      if (event.stopPropagation) { event.stopPropagation(); }
    });
    if (inputEl) {
      inputEl.addEventListener('keydown', function (event) {
        // 输入框里的按键不冒泡给标签栏（Delete/方向键有会话 tab 的语义）。
        if (event.stopPropagation) { event.stopPropagation(); }
        if (event.key === 'Enter') {
          if (event.preventDefault) { event.preventDefault(); }
          submit();
        } else if (event.key === 'Escape') {
          if (event.preventDefault) { event.preventDefault(); }
          close();
        }
      });
    }
    // capture：先于输入卡的 Escape（取消轮次）与标签栏的按键处理。
    document.addEventListener('keydown', function (event) {
      if (event.key !== 'Escape' || !isOpen()) { return; }
      if (event.preventDefault) { event.preventDefault(); }
      if (event.stopPropagation) { event.stopPropagation(); }
      close();
    }, true);
    document.addEventListener('click', function (event) {
      if (!isOpen() || event === openedBy) { return; }
      if (root.contains && root.contains(event.target)) { return; }
      close();
    });
    // 滚动/改尺寸后锚点已经不在原地：收起比留在错位的地方好。
    document.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    close();
  }

  NS.popover = {
    confirm: confirm,
    prompt: prompt,
    close: close,
    install: install,
    isOpen: isOpen
  };
})(window.__vac = window.__vac || {});
`;
