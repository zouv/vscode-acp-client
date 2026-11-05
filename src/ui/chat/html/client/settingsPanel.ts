// 设置面板（2026-10-21）：Tab 栏右侧的齿轮打开，左侧分组导航 + 右侧设置行。
//
// 数据与写入都在宿主（见 ChatPanelHost.settingsItems / handleSetSetting）：本模块只渲染、
// 把改动回传。每次写完宿主会重发整张表，所以控件显示的永远是真实值（值被夹紧过也能回显）。
// 用 overlay + panel 的原生 hidden 控制显隐；Esc 与点遮罩关闭。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
export const settingsPanelClient = `
(function (NS) {
  'use strict';

  var GROUPS = [
    { id: 'general', label: 'General' },
    { id: 'chat', label: 'Chat' },
    { id: 'appearance', label: 'Appearance' },
    { id: 'shortcuts', label: 'Shortcuts' },
    { id: 'advanced', label: 'Advanced' }
  ];

  var overlay = null;
  var navEl = null;
  var bodyEl = null;
  var closeBtn = null;
  var gear = null;
  // 子面板（自定义模型 / Agent 配置这类长编辑器）
  var subOverlay = null;
  var subTitle = null;
  var subBody = null;
  var subClose = null;
  var items = [];
  var active = 'general';
  // 模型编辑器还没提交的最终状态：Esc/点遮罩关闭时 change 事件不一定触发，
  // 关面板前按 DOM 里的真实值补一次提交（与上次提交相同的快照则跳过）。
  var modelCommit = null;
  // [CUSTOM- 模型排序请求的 id：多个 surface 都会收到 settings 广播，各自本地计数会撞号，
  // 所以用随机 UUID（不可用时退回「时间 + 随机 + 序号」），只让发起面认领自己的回执。
  var modelRequestSeq = 0;
  var modelDragRow = null;
  var modelDropIndicatorRow = null;
  // 快捷键录制（同一时刻只允许一个）：recording = { key, item, button, onBlur }。
  // 宿主每次 setSetting 后会重发整张表，所以录制结束前必须先退出录制态，否则
  // 重渲染出来的新按钮没有监听器，状态里却还挂着"正在录制"（幽灵录制）。
  var recording = null;
  // 客户端本地告警（录制冲突/不支持的键）与宿主 warning 共用同一行提示。
  var localWarnings = {};
  var rowWarnings = {};

  var SHORTCUT_ARROWS = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right'
  };

  var MODIFIER_CODES = {
    ControlLeft: true, ControlRight: true, ShiftLeft: true, ShiftRight: true,
    AltLeft: true, AltRight: true, MetaLeft: true, MetaRight: true,
    AltGraph: true, OSLeft: true, OSRight: true
  };

  function isOpen() { return !!overlay && overlay.hidden === false; }

  function open() {
    if (!overlay) { return; }
    overlay.hidden = false;
    NS.bridge.post({ type: 'getSettings' });
    renderNav();
    renderBody();
    if (closeBtn && closeBtn.focus) { closeBtn.focus(); }
  }

  function close() {
    if (!overlay) { return; }
    if (recording) { stopRecording(false); }
    // [CUSTOM- 写失败不是死锁：关闭整个设置面板时给出显式丢弃确认，确认后两层一起关。
    if (modelCommit && modelCommit.error) {
      discardModelChanges(function () {
        overlay.hidden = true;
        if (gear && gear.focus) { gear.focus(); }
      });
      if (isEditorOpen()) { return; }
      return;
    }
    closeEditor();
    // [CUSTOM- 模型编辑器在保存中/冲突/错误时会拒绝关闭（要保留草稿与选择按钮）；
    // 此时主面板也不能消失，否则那层 UI 跟着被藏掉，用户就再也看不到冲突。
    if (isEditorOpen()) { return; }
    overlay.hidden = true;
    if (gear && gear.focus) { gear.focus(); }
  }

  function setItems(next) {
    // 宿主重渲染 = 设置面板的权威状态变了：先收掉录制，避免旧按钮被换掉后还留下
    // 一个没有 UI 的"幽灵录制"。用户提交新键位前已经主动退出录制，二者不会打架。
    if (recording) { stopRecording(false); }
    // [CUSTOM- 模型列表的写入回执随同一次 settings 广播回来；只认自己那条 requestId。
    if (modelCommit && next) {
      for (var i = 0; i < next.length; i++) {
        if (next[i] && next[i].key === modelCommit.key && next[i].modelSync) {
          applyModelSync(next[i].modelSync);
          break;
        }
      }
    }
    localWarnings = {};
    items = next || [];
    var groups = groupsWithItems();
    if (groups.indexOf(active) < 0) { active = groups[0] || 'general'; }
    if (isOpen()) { renderNav(); renderBody(); }
  }

  function groupsWithItems() {
    var out = [];
    for (var i = 0; i < GROUPS.length; i++) {
      if (itemsFor(GROUPS[i].id).length > 0) { out.push(GROUPS[i].id); }
    }
    return out;
  }

  function itemsFor(group) {
    var out = [];
    for (var i = 0; i < items.length; i++) {
      if (items[i].group === group) { out.push(items[i]); }
    }
    return out;
  }

  function groupLabel(id) {
    for (var i = 0; i < GROUPS.length; i++) {
      if (GROUPS[i].id === id) { return GROUPS[i].label; }
    }
    return id;
  }

  function renderNav() {
    if (!navEl) { return; }
    NS.dom.clear(navEl);
    var groups = groupsWithItems();
    for (var i = 0; i < groups.length; i++) {
      var id = groups[i];
      var btn = NS.dom.el('button', 'settings-tab' + (id === active ? ' active' : ''), groupLabel(id));
      btn.type = 'button';
      btn.setAttribute('role', 'tab');
      btn.setAttribute('aria-selected', id === active ? 'true' : 'false');
      (function (group) {
        btn.addEventListener('click', function () {
          active = group;
          renderNav();
          renderBody();
        });
      })(id);
      navEl.appendChild(btn);
    }
  }

  function renderBody() {
    if (!bodyEl) { return; }
    NS.dom.clear(bodyEl);
    rowWarnings = {};
    if (active === 'shortcuts') {
      bodyEl.appendChild(NS.dom.el('div', 'settings-group-note',
        'Bindings use physical key positions, so on non-QWERTY layouts the recorded letter can differ from the printed key. On macOS, Option combinations (including the Alt+E/I/N defaults) can be intercepted as special-character input; rebind them if needed. Click a binding and press the new combination; Escape cancels.'));
    }
    var list = itemsFor(active);
    for (var i = 0; i < list.length; i++) {
      bodyEl.appendChild(renderRow(list[i]));
    }
  }

  function renderRow(item) {
    var row = NS.dom.el('div', 'settings-row' + (item.indent ? ' indent' : ''));
    var text = NS.dom.el('div', 'settings-text');
    var title = NS.dom.el('div', 'settings-label-row');
    title.appendChild(NS.dom.el('div', 'settings-label', item.label || item.key));
    var scope = renderScope(item);
    if (scope) { title.appendChild(scope); }
    text.appendChild(title);
    if (item.description) { text.appendChild(NS.dom.el('div', 'settings-desc', item.description)); }
    var override = overrideText(item);
    if (override) {
      var line = NS.dom.el('div', 'settings-override');
      line.appendChild(NS.dom.el('span', '', override));
      var inspect = NS.dom.el('button', 'settings-link', 'Inspect');
      inspect.type = 'button';
      inspect.addEventListener('click', function () { openInspect(item); });
      line.appendChild(inspect);
      text.appendChild(line);
    }
    // [CUSTOM- 摘要放在文字列（不是控件列）：这样 Edit… 与其它设置的控件右缘对齐。
    if (item.type === 'models' || item.type === 'json') {
      var summary = item.type === 'models'
        ? (Object.prototype.toString.call(item.value) === '[object Array]' ? item.value.length : 0) + ' model(s)'
        : 'JSON object';
      text.appendChild(NS.dom.el('div', 'settings-desc settings-summary', summary));
    }
    var warningText = localWarnings[item.key] || item.warning || '';
    var warningEl = NS.dom.el('div', 'settings-warning', warningText);
    warningEl.hidden = !warningText;
    rowWarnings[item.key] = warningEl;
    text.appendChild(warningEl);
    row.appendChild(text);
    row.appendChild(renderControl(item));
    return row;
  }

  /** [CUSTOM- 存储作用域胶囊：All IDEs / This IDE / Workspace / Default。点开看每一层。 */
  function renderScope(item) {
    var label = '';
    var cls = '';
    if (item.source) {
      var effective = item.source.effective;
      if (effective === 'workspace') { label = 'Workspace'; cls = 'workspace'; }
      else if (effective === 'global') { label = 'All IDEs'; cls = 'global'; }
      else if (effective === 'default') { label = 'Default'; cls = 'default'; }
      else { label = 'This IDE'; cls = 'ide'; }
    } else if (item.scope === 'global') {
      label = 'All IDEs';
      cls = 'global';
    } else if (item.scope === 'ide' || item.scope === 'panel') {
      label = 'This IDE';
      cls = 'ide';
    }
    if (!label) { return null; }
    var chip = NS.dom.el('button', 'settings-scope settings-scope-' + cls, label);
    chip.type = 'button';
    chip.title = 'Where this value comes from';
    chip.setAttribute('aria-label', 'Where this value comes from');
    chip.addEventListener('click', function () { openInspect(item); });
    return chip;
  }

  /** 只在"生效层高于该项默认层"时提示，普通的本层取值不打扰。 */
  function overrideText(item) {
    if (!item.source) { return ''; }
    var effective = item.source.effective;
    if (effective === 'workspace' && item.scope !== 'workspace') {
      return 'Overridden by workspace settings';
    }
    if (effective === 'user' && item.scope === 'global') {
      return 'Overridden by this IDE user settings';
    }
    if (effective === 'global' && item.scope === 'ide') {
      return 'Overridden by the cross-IDE global settings';
    }
    return '';
  }

  function inspectValue(value) {
    if (value === undefined) { return 'not set'; }
    if (Object.prototype.toString.call(value) === '[object Array]') { return value.length + ' item(s)'; }
    if (value && typeof value === 'object') { return 'JSON object'; }
    if (typeof value === 'boolean') { return value ? 'true' : 'false'; }
    return String(value);
  }

  function layerTitle(layer) {
    if (layer === 'workspace') { return 'Workspace'; }
    if (layer === 'user') { return 'This IDE (user)'; }
    if (layer === 'global') { return 'All IDEs (global)'; }
    return 'Built-in default';
  }

  function layerFile(entry) {
    if (entry && entry.file) { return entry.file; }
    var layer = entry && entry.layer;
    if (layer === 'workspace') { return '.vscode/settings.json'; }
    if (layer === 'user') { return 'settings.json'; }
    if (layer === 'global') { return '~/.vac/config.json'; }
    return 'package.json';
  }

  function writeTargetText(target) {
    if (target === 'workspace') { return 'workspace settings'; }
    if (target === 'global') { return 'the cross-IDE global config'; }
    if (target === 'panel') { return 'this IDE panel preferences'; }
    return 'this IDE user settings';
  }

  function inspectRow(item, layer, source) {
    var row = NS.dom.el('div',
      'settings-inspect-row' + (layer.layer === source.effective ? ' active' : ''));
    row.appendChild(NS.dom.el('div', 'settings-inspect-layer', layerTitle(layer.layer)));
    row.appendChild(NS.dom.el('div', 'settings-inspect-file', layerFile(layer)));
    row.appendChild(NS.dom.el('div', 'settings-inspect-value', inspectValue(layer.value)));
    var actions = NS.dom.el('div', 'settings-inspect-actions');
    if (layer.layer !== 'default') {
      var open = NS.dom.el('button', 'settings-link', 'Open');
      open.type = 'button';
      (function (target) {
        open.addEventListener('click', function () {
          NS.bridge.post({ type: 'settingAction', action: 'openSettingFile', layer: target });
        });
      })(layer.layer);
      actions.appendChild(open);
    }
    if (layer.layer !== 'default' && layer.value !== undefined) {
      var remove = NS.dom.el('button', 'settings-link', 'Remove');
      remove.type = 'button';
      (function (target) {
        remove.addEventListener('click', function () {
          NS.bridge.post({
            type: 'settingAction', action: 'removeSettingLayer', key: item.key, layer: target,
          });
          closeEditor();
        });
      })(layer.layer);
      actions.appendChild(remove);
    }
    row.appendChild(actions);
    return row;
  }

  /** 每一层的来源、当前生效层、写回目标。 */
  function openInspect(item) {
    if (!subOverlay || !subBody) { return; }
    modelCommit = null;
    if (subTitle) { subTitle.textContent = 'Where this value comes from'; }
    NS.dom.clear(subBody);
    var editor = NS.dom.el('div', 'settings-editor');
    editor.appendChild(NS.dom.el('div', 'settings-editor-intro', item.label || item.key));
    var source = item.source;
    if (!source) {
      editor.appendChild(NS.dom.el('div', 'settings-inspect-note',
        'This is a panel preference for this IDE. It lives in the extension global state, so another IDE (Insiders / VSCodium) has its own copy.'));
    } else {
      var table = NS.dom.el('div', 'settings-inspect');
      for (var i = 0; i < source.layers.length; i++) {
        table.appendChild(inspectRow(item, source.layers[i], source));
      }
      editor.appendChild(table);
      editor.appendChild(NS.dom.el('div', 'settings-inspect-note',
        'Edits are written to: ' + writeTargetText(source.writeTarget) + '.'));
      if (item.scope === 'global' && source.effective !== 'global') {
        var make = NS.dom.el('button', 'settings-action settings-inspect-promote',
          'Make this the default for all IDEs');
        make.type = 'button';
        make.addEventListener('click', function () {
          NS.bridge.post({ type: 'settingAction', action: 'makeSettingGlobal', key: item.key });
          closeEditor();
        });
        editor.appendChild(make);
      }
    }
    var footer = NS.dom.el('div', 'settings-editor-footer');
    var done = NS.dom.el('button', 'settings-action', 'Done');
    done.type = 'button';
    done.addEventListener('click', closeEditor);
    footer.appendChild(done);
    editor.appendChild(footer);
    subBody.appendChild(editor);
    subOverlay.hidden = false;
  }

  function send(key, value) {
    NS.bridge.post({ type: 'setSetting', key: key, value: value });
  }

  function shortcutDisabled(value) {
    return value === null || value === undefined || value === '';
  }

  /** 宿主存的规范串（Alt+KeyA）转成人看的形式（Alt+A）；空格/方向键也转。 */
  function displayShortcut(value) {
    if (shortcutDisabled(value)) { return 'Disabled'; }
    var parts = String(value).split('+');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (part.indexOf('Key') === 0 && part.length === 4) {
        out.push(part.slice(3));
      } else if (part.indexOf('Digit') === 0 && part.length === 6) {
        out.push(part.slice(5));
      } else {
        out.push(SHORTCUT_ARROWS[part] || part);
      }
    }
    return out.join('+');
  }

  function shortcutAria(item) {
    return (item.label || item.key) + ': ' + displayShortcut(item.value) + '. Click to record.';
  }

  function shortcutButtonClass(value, isRecording) {
    var cls = 'settings-shortcut-record';
    if (isRecording) { cls += ' recording'; }
    else if (shortcutDisabled(value)) { cls += ' is-disabled'; }
    return cls;
  }

  function isPureModifier(event) {
    var key = event.key || '';
    if (key === 'Control' || key === 'Shift' || key === 'Alt'
      || key === 'Meta' || key === 'AltGraph' || key === 'OS') {
      return true;
    }
    return MODIFIER_CODES[event.code] === true;
  }

  function hasRequiredModifier(event) {
    return event.ctrlKey === true || event.altKey === true || event.metaKey === true;
  }

  function isAltGraphEvent(event) {
    if (event.key === 'AltGraph') { return true; }
    if (event.getModifierState) {
      try {
        if (event.getModifierState('AltGraph')) { return true; }
      } catch (e) { /* some hosts reject unknown modifier names */ }
    }
    return false;
  }

  /** 规范串统一由快捷键分发器提供，设置面板不再维护第二份解析规则。 */
  function shortcutFromEvent(event) {
    return NS.shortcuts && typeof NS.shortcuts.fromEvent === 'function'
      ? NS.shortcuts.fromEvent(event)
      : null;
  }

  function setWarning(key, text) {
    localWarnings[key] = text || '';
    var el = rowWarnings[key];
    if (el) {
      el.textContent = text || '';
      el.hidden = !text;
    }
  }

  function conflictingItem(key, value) {
    for (var i = 0; i < items.length; i++) {
      var other = items[i];
      if (other.key === key || other.group !== 'shortcuts') { continue; }
      if (shortcutDisabled(other.value)) { continue; }
      if (String(other.value) === value) { return other; }
    }
    return null;
  }

  function startRecording(item, button) {
    if (recording) { stopRecording(false); }
    setWarning(item.key, '');
    recording = { key: item.key, item: item, button: button, onBlur: null };
    button.className = shortcutButtonClass(item.value, true);
    button.textContent = 'Press keys\\u2026';
    button.setAttribute('aria-pressed', 'true');
    button.setAttribute('aria-label',
      'Recording shortcut. Press a key combination; Escape cancels.');
    var onBlur = function () {
      if (recording && recording.button === button) { cancelRecording(false); }
    };
    recording.onBlur = onBlur;
    if (button.addEventListener) { button.addEventListener('blur', onBlur); }
    if (button.focus) { button.focus(); }
  }

  function stopRecording(refocus) {
    if (!recording) { return null; }
    var rec = recording;
    recording = null;
    setWarning(rec.key, '');
    if (rec.button) {
      if (rec.onBlur && rec.button.removeEventListener) {
        rec.button.removeEventListener('blur', rec.onBlur);
      }
      rec.button.className = shortcutButtonClass(rec.item.value, false);
      rec.button.textContent = displayShortcut(rec.item.value);
      rec.button.setAttribute('aria-pressed', 'false');
      rec.button.setAttribute('aria-label', shortcutAria(rec.item));
      if (refocus && rec.button.focus) { rec.button.focus(); }
    }
    return rec;
  }

  function cancelRecording(refocus) {
    stopRecording(refocus);
  }

  function onWindowBlur() {
    if (recording) { cancelRecording(false); }
  }

  /**
   * 录制期间在 window 捕获阶段吞掉所有按键：设置面板的其它快捷键、聊天动作、
   * 以及宿主工作台都不会收到它们。Escape 只取消录制，不关面板。
   */
  function onRecordingKeyDown(event) {
    if (!recording) { return; }
    // 输入法合成与 AltGraph 必须原样放行：不 preventDefault、不停止传播，
    // 否则会吞掉正在进行的输入（尤其是带死键/组合键的键盘布局）。
    if (event.isComposing || event.keyCode === 229 || event.key === 'Dead' || isAltGraphEvent(event)) { return; }
    if (event.key === 'Tab') {
      // 不 preventDefault：让焦点正常离开，按钮的 blur 会完成收尾。
      cancelRecording(false);
      if (event.stopPropagation) { event.stopPropagation(); }
      if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }
      return;
    }
    if (event.preventDefault) { event.preventDefault(); }
    if (event.stopPropagation) { event.stopPropagation(); }
    if (event.stopImmediatePropagation) { event.stopImmediatePropagation(); }

    if (event.repeat) { return; }
    if (event.key === 'Escape') { cancelRecording(true); return; }
    if (isPureModifier(event)) { return; }

    var value = shortcutFromEvent(event);
    if (value === null || value === undefined) {
      setWarning(recording.key, hasRequiredModifier(event)
        ? 'Unsupported key. Use Ctrl, Alt or Meta (Shift may be combined) plus A-Z, 0-9, an arrow key, Home, End, PageUp, or PageDown.'
        : 'Add at least one modifier: Ctrl, Alt or Meta. Shift alone would intercept capital letters.');
      return;
    }
    var conflict = conflictingItem(recording.key, value);
    if (conflict) {
      setWarning(recording.key, '"' + displayShortcut(value) + '" is already used by "'
        + (conflict.label || conflict.key) + '". Choose another combination.');
      return;
    }
    var rec = recording;
    // 先退出录制再把值交给宿主：宿主的重渲染不能留下一个"幽灵录制"。
    stopRecording(false);
    send(rec.key, value);
  }

  function renderShortcutControl(item, wrap) {
    wrap.className += ' settings-shortcut-control';
    var record = NS.dom.el('button', shortcutButtonClass(item.value, false), displayShortcut(item.value));
    record.type = 'button';
    record.title = 'Click to record a new shortcut. Escape cancels.';
    record.setAttribute('aria-label', shortcutAria(item));
    record.addEventListener('click', function () {
      if (recording && recording.key === item.key) { cancelRecording(true); return; }
      startRecording(item, record);
    });
    wrap.appendChild(record);

    var reset = NS.dom.el('button', 'settings-link settings-shortcut-reset', 'Reset');
    reset.type = 'button';
    reset.title = 'Restore the default shortcut';
    reset.addEventListener('click', function () {
      setWarning(item.key, '');
      send(item.key, 'default');
    });
    wrap.appendChild(reset);

    var disable = NS.dom.el('button', 'settings-link settings-shortcut-disable', 'Disable');
    disable.type = 'button';
    disable.title = 'Disable this shortcut';
    disable.addEventListener('click', function () {
      setWarning(item.key, '');
      send(item.key, null);
    });
    if (shortcutDisabled(item.value)) { disable.hidden = true; }
    wrap.appendChild(disable);
    return wrap;
  }

  function renderControl(item) {
    var wrap = NS.dom.el('div', 'settings-control');
    if (item.type === 'shortcut') {
      return renderShortcutControl(item, wrap);
    }
    if (item.type === 'boolean') {
      var box = NS.dom.el('input', 'settings-check');
      box.type = 'checkbox';
      box.checked = item.value === true;
      box.addEventListener('change', function () { send(item.key, box.checked === true); });
      wrap.appendChild(box);
      return wrap;
    }
    if (item.type === 'select') {
      var select = NS.dom.el('select', 'settings-select');
      var options = item.options || [];
      for (var i = 0; i < options.length; i++) {
        var opt = NS.dom.el('option', '', options[i].label);
        opt.setAttribute('value', String(options[i].value));
        if (String(options[i].value) === String(item.value)) { opt.selected = true; }
        select.appendChild(opt);
      }
      select.addEventListener('change', function () { send(item.key, select.value); });
      wrap.appendChild(select);
      return wrap;
    }
    if (item.type === 'number') {
      var num = NS.dom.el('input', 'settings-number');
      num.type = 'number';
      // 大纲宽度 160–480；自动展开的限高 0（不限）–2000；其余行由宿主给范围。
      var outlineWidth = item.key === 'panel.outlineWidth';
      num.setAttribute('min', String(item.min !== undefined ? item.min : (outlineWidth ? 160 : 0)));
      num.setAttribute('max', String(item.max !== undefined ? item.max : (outlineWidth ? 480 : 2000)));
      // 小跨度（<= 50，例如目录条数 0–30）用 1；尺寸类（几百）仍用 10。
      // [CUSTOM- 宿主显式给的 step 优先（历史显示上限等需要精确 1 步进）。
      var smallRange = item.max !== undefined
        && item.max - (item.min === undefined ? 0 : item.min) <= 50;
      var step = typeof item.step === 'number' && item.step > 0
        ? item.step
        : (smallRange ? 1 : 10);
      num.setAttribute('step', String(step));
      num.value = String(item.value === undefined || item.value === null ? '' : item.value);
      num.addEventListener('change', function () { send(item.key, num.value); });
      wrap.appendChild(num);
      return wrap;
    }
    if (item.type === 'text') {
      var input = NS.dom.el('input', 'settings-text-input');
      input.type = 'text';
      input.value = String(item.value === undefined || item.value === null ? '' : item.value);
      input.addEventListener('change', function () { send(item.key, input.value); });
      wrap.appendChild(input);
      // [CUSTOM- 目录类文本项给一个系统目录选择器（2026-10-21）。
      if (item.key === 'vac.defaultWorkingDirectory') {
        var browse = NS.dom.el('button', 'settings-action', 'Browse\\u2026');
        browse.type = 'button';
        browse.addEventListener('click', function () {
          NS.bridge.post({ type: 'settingAction', action: 'pickDefaultWorkingDirectory' });
        });
        wrap.appendChild(browse);
      }
      return wrap;
    }
    if (item.type === 'json' || item.type === 'models') {
      // [CUSTOM- 编辑器单独弹子面板（2026-10-21）：模型一多，内联列表会把主面板撑爆。
      // 摘要已放在文字列，这里只留按钮，右缘与其它控件对齐。
      var edit = NS.dom.el('button', 'settings-action', 'Edit\\u2026');
      edit.type = 'button';
      edit.addEventListener('click', function () { openEditor(item); });
      wrap.appendChild(edit);
      return wrap;
    }
    if (item.type === 'action') {
      var label = item.actionLabel || 'Run';
      var button = NS.dom.el('button', 'settings-action', label);
      button.type = 'button';
      button.addEventListener('click', function (event) {
        var send = function () {
          NS.bridge.post({ type: 'settingAction', action: String(item.key).replace(/^action\\./, '') });
        };
        // [CUSTOM-20261029] 破坏性动作（清缓存 / 重置偏好）先问一句；问在面板内，
        // 不用宿主 modal（它会挡住整个 IDE）。
        if (item.confirm && NS.popover && NS.popover.confirm && NS.popover.confirm({
          message: item.confirm,
          confirmLabel: label,
          danger: true,
          anchor: button,
          event: event,
          onConfirm: send
        })) { return; }
        send();
      });
      wrap.appendChild(button);
      return wrap;
    }
    // info：只读值
    wrap.appendChild(NS.dom.el('span', 'settings-value',
      item.value === undefined || item.value === null ? '\\u2014' : String(item.value)));
    return wrap;
  }

  /** 自定义模型列表的一行：拖拽手柄 / id / 显示名 / 描述 / 上移下移 / 删除。 */
  function modelRow(key, list, model) {
    var row = NS.dom.el('div', 'settings-model-row');
    var drag = NS.dom.el('span', 'settings-model-drag', '\\u2807');
    drag.title = 'Drag to reorder';
    drag.setAttribute('draggable', 'true');
    drag.setAttribute('aria-hidden', 'true');
    drag.addEventListener('dragstart', function (event) {
      modelDragRow = row;
      row.className += ' dragging';
      if (event && event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        try { event.dataTransfer.setData('text/plain', 'model-row'); } catch (e) { /* best effort */ }
      }
    });
    drag.addEventListener('dragend', function () {
      modelDragRow = null;
      removeModelClass(row, 'dragging');
      clearModelDropIndicator();
    });
    var id = NS.dom.el('input', 'settings-text-input settings-model-id');
    id.type = 'text';
    id.placeholder = 'model id';
    id.value = model && model.modelId ? String(model.modelId) : '';
    var name = NS.dom.el('input', 'settings-text-input settings-model-name');
    name.type = 'text';
    name.placeholder = 'display name';
    name.value = model && model.name ? String(model.name) : '';
    var desc = NS.dom.el('input', 'settings-text-input settings-model-desc');
    desc.type = 'text';
    desc.placeholder = 'description (optional)';
    desc.value = model && model.description ? String(model.description) : '';
    var move = NS.dom.el('div', 'settings-model-move');
    var up = NS.dom.el('button', 'settings-model-move-btn settings-model-up', '\\u2191');
    up.type = 'button';
    up.title = 'Move up';
    up.setAttribute('aria-label', 'Move model up');
    up.addEventListener('click', function (event) {
      moveModelRow(row, -1, event && event.currentTarget ? event.currentTarget : up);
    });
    var down = NS.dom.el('button', 'settings-model-move-btn settings-model-down', '\\u2193');
    down.type = 'button';
    down.title = 'Move down';
    down.setAttribute('aria-label', 'Move model down');
    down.addEventListener('click', function (event) {
      moveModelRow(row, 1, event && event.currentTarget ? event.currentTarget : down);
    });
    move.appendChild(up);
    move.appendChild(down);
    var remove = NS.dom.el('button', 'settings-model-remove', '\\u00d7');
    remove.type = 'button';
    remove.title = 'Remove';
    var changed = function () {
      syncModelMoveButtons(list);
      queueModelCommit(false);
    };
    id.addEventListener('change', changed);
    name.addEventListener('change', changed);
    desc.addEventListener('change', changed);
    remove.addEventListener('click', function () {
      if (row.parentNode && row.parentNode.removeChild) { row.parentNode.removeChild(row); }
      changed();
    });
    row.appendChild(drag);
    row.appendChild(id);
    row.appendChild(name);
    row.appendChild(desc);
    row.appendChild(move);
    row.appendChild(remove);
    return row;
  }

  /** DOM 顺序就是设置顺序；空 id 行与输入中的草稿都只在本地，不丢不并。 */
  function collectModels(list) {
    var out = [];
    var rows = list.querySelectorAll ? list.querySelectorAll('.settings-model-row') : [];
    for (var i = 0; i < rows.length; i++) {
      var inputs = rows[i].querySelectorAll ? rows[i].querySelectorAll('input') : [];
      var modelId = inputs[0] ? String(inputs[0].value || '').trim() : '';
      if (!modelId) { continue; }
      var entry = { modelId: modelId, name: (inputs[1] ? String(inputs[1].value || '').trim() : '') || modelId };
      var description = inputs[2] ? String(inputs[2].value || '').trim() : '';
      if (description) { entry.description = description; }
      out.push(entry);
    }
    return out;
  }

  /** 把宿主回执里的模型数组规范化成与 DOM 收集同形的快照，供"有没有改"比较。 */
  function canonicalModelValues(raw) {
    var list = Object.prototype.toString.call(raw) === '[object Array]' ? raw : [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i] && typeof list[i] === 'object' ? list[i] : {};
      var modelId = typeof entry.modelId === 'string' ? entry.modelId.trim() : '';
      if (!modelId) { continue; }
      var name = typeof entry.name === 'string' ? entry.name.trim() : '';
      var description = typeof entry.description === 'string' ? entry.description.trim() : '';
      var row = { modelId: modelId, name: name || modelId };
      if (description) { row.description = description; }
      out.push(row);
    }
    return out;
  }

  function modelRequestId() {
    // 跨 surface 唯一：回执与 requestId 都经 settings 广播，两个面各自从 1 开始会撞车。
    try {
      if (typeof crypto !== 'undefined' && crypto && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
      }
    } catch (e) { /* fall through to the random form */ }
    modelRequestSeq++;
    return String(Date.now()) + '-' + Math.random().toString(36).slice(2) + '-' + modelRequestSeq;
  }

  function syncModelMoveButtons(list) {
    var rows = list.querySelectorAll ? list.querySelectorAll('.settings-model-row') : [];
    for (var i = 0; i < rows.length; i++) {
      var buttons = rows[i].querySelectorAll ? rows[i].querySelectorAll('.settings-model-move button') : [];
      if (buttons[0]) { buttons[0].disabled = i === 0; }
      if (buttons[1]) { buttons[1].disabled = i === rows.length - 1; }
    }
  }

  function moveModelRow(row, delta, button) {
    if (!modelCommit || !modelCommit.list) { return; }
    var list = modelCommit.list;
    var rows = list.querySelectorAll ? list.querySelectorAll('.settings-model-row') : [];
    var index = -1;
    for (var i = 0; i < rows.length; i++) { if (rows[i] === row) { index = i; break; } }
    var target = index + delta;
    if (index < 0 || target < 0 || target >= rows.length) { return; }
    var reference = rows[target];
    if (delta < 0) {
      list.insertBefore(row, reference);
    } else {
      list.insertBefore(row, reference.nextSibling || null);
    }
    syncModelMoveButtons(list);
    announceModelMove(row);
    queueModelCommit(false);
    if (button) {
      // 移到边界后刚点的按钮会变成 disabled；焦点必须转到同一行仍可用的按钮，
      // 否则键盘用户会掉到 body 上。
      var focusTarget = button;
      if (button.disabled) {
        var buttons = row.querySelectorAll ? row.querySelectorAll('.settings-model-move button') : [];
        for (var b = 0; b < buttons.length; b++) {
          if (!buttons[b].disabled) { focusTarget = buttons[b]; break; }
        }
      }
      if (focusTarget && focusTarget.focus) { focusTarget.focus(); }
    }
  }

  function modelAnnounceName(row) {
    var inputs = row.querySelectorAll ? row.querySelectorAll('input') : [];
    var alias = inputs[1] ? String(inputs[1].value || '').trim() : '';
    var id = inputs[0] ? String(inputs[0].value || '').trim() : '';
    return alias || id || 'New model';
  }

  /** 拖拽/按钮排序后的屏幕阅读器播报：具体模型 + 所在序号。 */
  function announceModelMove(row) {
    var m = modelCommit;
    if (!m || !m.announceEl || !m.list) { return; }
    var rows = m.list.querySelectorAll ? m.list.querySelectorAll('.settings-model-row') : [];
    var index = -1;
    for (var i = 0; i < rows.length; i++) { if (rows[i] === row) { index = i; break; } }
    if (index < 0) { return; }
    m.announceEl.textContent = 'Moved model "' + modelAnnounceName(row)
      + '" to position ' + (index + 1) + ' of ' + rows.length + '.';
  }

  function dropTargetRow(list, y) {
    var rows = list.querySelectorAll ? list.querySelectorAll('.settings-model-row') : [];
    for (var i = 0; i < rows.length; i++) {
      var box = rows[i].getBoundingClientRect ? rows[i].getBoundingClientRect() : null;
      if (box && y < box.top + box.height / 2) { return rows[i]; }
    }
    return null;
  }

  function removeModelClass(node, name) {
    if (!node || !node.className) { return; }
    var parts = String(node.className).split(/\\s+/);
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      if (parts[i] && parts[i] !== name) { out.push(parts[i]); }
    }
    node.className = out.join(' ');
  }

  function clearModelDropIndicator() {
    if (!modelDropIndicatorRow) { return; }
    removeModelClass(modelDropIndicatorRow, 'settings-model-drop-before');
    removeModelClass(modelDropIndicatorRow, 'settings-model-drop-after');
    modelDropIndicatorRow = null;
  }

  function setModelDropIndicator(list, y) {
    var rows = list.querySelectorAll ? list.querySelectorAll('.settings-model-row') : [];
    var target = dropTargetRow(list, y);
    clearModelDropIndicator();
    if (!rows.length) { return; }
    var row = target || rows[rows.length - 1];
    row.className += target ? ' settings-model-drop-before' : ' settings-model-drop-after';
    modelDropIndicatorRow = row;
  }

  function installModelDrag(list) {
    list.addEventListener('dragover', function (event) {
      if (!modelDragRow || modelDragRow.parentNode !== list) { return; }
      if (event && event.preventDefault) { event.preventDefault(); }
      if (event && event.dataTransfer) { event.dataTransfer.dropEffect = 'move'; }
      setModelDropIndicator(list, event ? event.clientY : 0);
    });
    // 拖出列表或取消拖拽都必须清掉落点线，否则它会留在原地误导下一次拖拽。
    list.addEventListener('dragleave', function (event) {
      if (event && event.relatedTarget && list.contains && list.contains(event.relatedTarget)) { return; }
      clearModelDropIndicator();
    });
    list.addEventListener('drop', function (event) {
      if (!modelDragRow || modelDragRow.parentNode !== list) { clearModelDropIndicator(); return; }
      if (event && event.preventDefault) { event.preventDefault(); }
      var row = modelDragRow;
      var before = [];
      var currentRows = list.querySelectorAll('.settings-model-row');
      for (var i = 0; i < currentRows.length; i++) { before.push(currentRows[i]); }
      var oldIndex = before.indexOf(row);
      var target = event ? dropTargetRow(list, event.clientY) : null;
      if (target && target !== row) { list.insertBefore(row, target); }
      else if (!target) { list.appendChild(row); }
      var afterRows = list.querySelectorAll('.settings-model-row');
      var newIndex = -1;
      for (var j = 0; j < afterRows.length; j++) { if (afterRows[j] === row) { newIndex = j; break; } }
      clearModelDropIndicator();
      modelDragRow = null;
      removeModelClass(row, 'dragging');
      syncModelMoveButtons(list);
      if (oldIndex !== newIndex) {
        announceModelMove(row);
        queueModelCommit(false);
      }
    });
  }

  function setModelStatus(kind, text) {
    var m = modelCommit;
    if (!m || !m.statusEl) { return; }
    var el = m.statusEl;
    NS.dom.clear(el);
    el.className = 'settings-model-status' + (kind ? ' ' + kind : '');
    el.hidden = !text;
    if (!text) { return; }
    el.appendChild(NS.dom.el('div', 'settings-model-status-text', text));
    var actions = null;
    var action = function (label, handler) {
      if (!actions) {
        actions = NS.dom.el('div', 'settings-model-status-actions');
        el.appendChild(actions);
      }
      var button = NS.dom.el('button', 'settings-link', label);
      button.type = 'button';
      button.addEventListener('click', function (event) { handler(event); });
      actions.appendChild(button);
    };
    if (kind === 'conflict') {
      action('Reload', reloadModelConflict);
      action('Overwrite', overwriteModelConflict);
    } else if (kind === 'error') {
      action('Retry', retryModelError);
      action('Discard', function () { discardModelChanges(); });
    }
  }

  function queueModelCommit(force) {
    var m = modelCommit;
    if (!m) { return; }
    m.pending = { value: collectModels(m.list), force: force === true };
    // 一次只允许一条在途；错误/冲突也暂停自动提交，等用户明确选择。
    if (m.inFlight !== null || m.conflict || m.error) { return; }
    flushModelCommit();
  }

  function flushModelCommit() {
    var m = modelCommit;
    if (!m || m.inFlight !== null || m.conflict || m.error) { return; }
    var pending = m.pending;
    if (!pending) { maybeCloseEditor(); return; }
    m.pending = null;
    var signature = JSON.stringify(pending.value);
    if (!pending.force && signature === m.valueSignature) {
      setModelStatus('', '');
      maybeCloseEditor();
      return;
    }
    m.inFlight = modelRequestId();
    setModelStatus('', 'Saving\\u2026');
    NS.bridge.post({
      type: 'setModelList',
      requestId: m.inFlight,
      baseline: m.baseline,
      value: pending.value,
      force: pending.force === true
    });
  }

  function applyModelSync(sync) {
    var m = modelCommit;
    if (!m || !sync || sync.requestId !== m.inFlight) { return; }
    m.inFlight = null;
    if (sync.status === 'saved') {
      if (typeof sync.baseline === 'string') { m.baseline = sync.baseline; }
      // CAS token 只给宿主比对；本地"有没有改"用独立的规范化值快照。
      if (sync.models) { m.valueSignature = JSON.stringify(canonicalModelValues(sync.models)); }
      m.conflict = false;
      m.conflictModels = null;
      m.conflictBaseline = null;
      m.error = null;
      setModelStatus('', '');
      flushModelCommit();
      maybeCloseEditor();
      return;
    }
    if (sync.status === 'conflict') {
      m.conflict = true;
      m.conflictModels = sync.models || [];
      m.conflictBaseline = typeof sync.baseline === 'string'
        ? sync.baseline
        : JSON.stringify(sync.models || []);
      setModelStatus('conflict',
        (sync.message || 'Custom models changed elsewhere.')
        + ' Reload the current list or overwrite it with your changes.');
      return;
    }
    m.error = sync.message || 'Could not save custom models.';
    setModelStatus('error', 'Could not save custom models: ' + m.error);
  }

  function reloadModelConflict() {
    var m = modelCommit;
    if (!m) { return; }
    m.baseline = m.conflictBaseline || JSON.stringify(m.conflictModels || []);
    var models = m.conflictModels || [];
    m.valueSignature = JSON.stringify(canonicalModelValues(models));
    m.conflict = false;
    m.conflictModels = null;
    m.conflictBaseline = null;
    m.error = null;
    m.pending = null;
    NS.dom.clear(m.list);
    for (var i = 0; i < models.length; i++) { m.list.appendChild(modelRow(m.key, m.list, models[i])); }
    syncModelMoveButtons(m.list);
    setModelStatus('', '');
    maybeCloseEditor();
  }

  function overwriteModelConflict() {
    var m = modelCommit;
    if (!m) { return; }
    if (typeof m.conflictBaseline === 'string') { m.baseline = m.conflictBaseline; }
    m.conflict = false;
    m.conflictModels = null;
    m.conflictBaseline = null;
    m.error = null;
    m.pending = { value: collectModels(m.list), force: true };
    setModelStatus('', '');
    flushModelCommit();
  }

  function retryModelError() {
    var m = modelCommit;
    if (!m) { return; }
    m.error = null;
    // 失败后用户可能继续输入但没触发 change；Retry 必须以此刻 DOM 为准，
    // 不能用失败时那份旧快照（否则会把未失焦的新输入覆盖掉）。
    m.pending = { value: collectModels(m.list), force: false };
    setModelStatus('', '');
    flushModelCommit();
  }

  /** 写失败后唯一能退出错误态的动作：显式丢弃本地草稿（有改动时先确认）。 */
  function discardModelChanges(onDone) {
    var m = modelCommit;
    if (!m) { if (onDone) { onDone(); } return; }
    var dirty = JSON.stringify(collectModels(m.list)) !== m.valueSignature;
    var finish = function () {
      if (modelCommit === m) { hideEditor(); }
      if (onDone) { onDone(); }
    };
    if (!dirty) { finish(); return; }
    var message = 'Discard your unsaved custom model changes?';
    if (NS.popover && typeof NS.popover.confirm === 'function') {
      // 返回值只表示"确认框是否已被展示"；真正的丢弃只发生在 onConfirm。
      // 展示失败/被拒绝时必须保留草稿，不能落到 finish()。
      NS.popover.confirm({
        message: message,
        confirmLabel: 'Discard',
        danger: true,
        onConfirm: finish
      });
      return;
    }
    if (typeof window !== 'undefined' && typeof window.confirm === 'function') {
      if (window.confirm(message)) { finish(); }
      return;
    }
    // 没有任何确认手段：保留草稿并说明原因，绝不清空用户输入。
    setModelStatus('error', 'Could not show a discard confirmation. Your local changes were kept.');
  }

  function maybeCloseEditor() {
    var m = modelCommit;
    if (!m || !m.closeAfterSave) { return; }
    if (m.inFlight !== null || m.conflict || m.error) { return; }
    // [CUSTOM- 用户在"已经在保存 / 点了 Done"之后继续输入但没触发 change 时，
    // 关面板前必须重新读 DOM：否则回执一到就会把刚输入的内容直接关掉丢掉。
    var local = JSON.stringify(collectModels(m.list));
    if (local !== m.valueSignature) {
      m.pending = { value: collectModels(m.list), force: false };
      flushModelCommit();
      return;
    }
    hideEditor();
  }

  function hideEditor() {
    modelCommit = null;
    subOverlay.hidden = true;
    if (subBody) { NS.dom.clear(subBody); }
  }

  function isEditorOpen() { return !!subOverlay && subOverlay.hidden === false; }

  /** 打开子面板：模型列表 / JSON 编辑器。主面板保持打开，子面板盖在它上面。 */
  function openEditor(item) {
    if (!subOverlay || !subBody) { return; }
    modelCommit = null;
    modelDragRow = null;
    if (subTitle) { subTitle.textContent = item.label || item.key; }
    NS.dom.clear(subBody);
    var editor = NS.dom.el('div', 'settings-editor');
    if (item.description) {
      editor.appendChild(NS.dom.el('div', 'settings-editor-intro', item.description));
    }
    if (item.type === 'models') {
      // [CUSTOM- 表头 + 右对齐的动作（2026-10-21 排版调整）。
      editor.appendChild(NS.dom.el('div', 'settings-editor-intro',
        'Model id is sent to the agent; Alias is the label in the picker; Description is its subtitle and tooltip. The agent must support extra models, and new entries become available in newly created or restored sessions. Drag the handle or use the arrow buttons to set the picker order.'));
      var head = NS.dom.el('div', 'settings-model-head');
      head.appendChild(NS.dom.el('span', '', ''));
      head.appendChild(NS.dom.el('span', '', 'Model id'));
      head.appendChild(NS.dom.el('span', '', 'Alias'));
      head.appendChild(NS.dom.el('span', '', 'Description'));
      head.appendChild(NS.dom.el('span', '', 'Order'));
      head.appendChild(NS.dom.el('span', '', ''));
      editor.appendChild(head);

      var list = NS.dom.el('div', 'settings-models');
      var rows = Object.prototype.toString.call(item.value) === '[object Array]' ? item.value : [];
      for (var m = 0; m < rows.length; m++) {
        list.appendChild(modelRow(item.key, list, rows[m]));
      }
      editor.appendChild(list);
      syncModelMoveButtons(list);
      installModelDrag(list);

      var statusEl = NS.dom.el('div', 'settings-model-status');
      statusEl.hidden = true;
      statusEl.setAttribute('role', 'status');
      statusEl.setAttribute('aria-live', 'polite');
      editor.appendChild(statusEl);

      var announceEl = NS.dom.el('div', 'settings-model-announce');
      announceEl.setAttribute('role', 'status');
      announceEl.setAttribute('aria-live', 'polite');
      editor.appendChild(announceEl);

      modelCommit = {
        key: item.key,
        item: item,
        list: list,
        statusEl: statusEl,
        announceEl: announceEl,
        baseline: typeof item.modelBaseline === 'string'
          ? item.modelBaseline
          : JSON.stringify(collectModels(list)),
        valueSignature: JSON.stringify(collectModels(list)),
        inFlight: null,
        pending: null,
        conflict: false,
        conflictModels: null,
        conflictBaseline: null,
        error: null,
        closeAfterSave: false
      };

      var add = NS.dom.el('button', 'settings-action settings-model-add', 'Add model');
      add.type = 'button';
      add.addEventListener('click', function () {
        // 空行只存在于本地：一提交就会被宿主的 normalize 丢掉（那不是"新增失败"）。
        var row = modelRow(item.key, list, { modelId: '', name: '', description: '' });
        list.appendChild(row);
        syncModelMoveButtons(list);
        var first = row.querySelector ? row.querySelector('input') : null;
        if (first && first.focus) { first.focus(); }
      });
      editor.appendChild(add);

      var footer = NS.dom.el('div', 'settings-editor-footer');
      var done = NS.dom.el('button', 'settings-action', 'Done');
      done.type = 'button';
      done.addEventListener('click', closeEditor);
      footer.appendChild(done);
      editor.appendChild(footer);
    } else {
      var area = NS.dom.el('textarea', 'settings-json');
      area.rows = 14;
      area.value = JSON.stringify(item.value === undefined ? {} : item.value, null, 2);
      var error = NS.dom.el('div', 'settings-json-error');
      error.hidden = true;
      var actions = NS.dom.el('div', 'settings-editor-footer');
      var cancel = NS.dom.el('button', 'settings-action', 'Cancel');
      cancel.type = 'button';
      cancel.addEventListener('click', closeEditor);
      var save = NS.dom.el('button', 'settings-action', 'Save');
      save.type = 'button';
      save.addEventListener('click', function () {
        var parsed;
        try {
          parsed = JSON.parse(area.value);
        } catch (e) {
          error.textContent = 'Invalid JSON: ' + (e && e.message ? e.message : 'parse error');
          error.hidden = false;
          return;
        }
        send(item.key, parsed);
        closeEditor();
      });
      // Cancel 在左、Save 在右（用户指定）。
      actions.appendChild(cancel);
      actions.appendChild(save);
      editor.appendChild(area);
      editor.appendChild(error);
      editor.appendChild(actions);
    }
    subBody.appendChild(editor);
    subOverlay.hidden = false;
    if (subClose && subClose.focus) { subClose.focus(); }
  }

  function closeEditor() {
    if (!subOverlay) { return; }
    // [CUSTOM- 写失败后 Esc/关闭不能永远卡住：先显式确认丢弃本地草稿，再收起子面板。
    if (modelCommit && modelCommit.error) {
      discardModelChanges();
      return;
    }
    // [CUSTOM- 模型编辑器：先把 DOM 真值排队提交，再决定能不能关。
    // 在途/冲突必须留下面板，否则"保留草稿 + Reload/覆盖"没有落点。
    if (modelCommit) {
      var local = JSON.stringify(collectModels(modelCommit.list));
      if (local !== modelCommit.valueSignature || modelCommit.inFlight !== null
        || modelCommit.pending || modelCommit.conflict || modelCommit.error) {
        modelCommit.closeAfterSave = true;
        queueModelCommit(false);
        maybeCloseEditor();
        return;
      }
      hideEditor();
      return;
    }
    subOverlay.hidden = true;
    if (subBody) { NS.dom.clear(subBody); }
  }

  function init() {
    overlay = NS.dom.qs('settingsOverlay');
    navEl = NS.dom.qs('settingsNav');
    bodyEl = NS.dom.qs('settingsBody');
    closeBtn = NS.dom.qs('settingsClose');
    gear = NS.dom.qs('settingsBtn');
    subOverlay = NS.dom.qs('settingsSubOverlay');
    subTitle = NS.dom.qs('settingsSubTitle');
    subBody = NS.dom.qs('settingsSubBody');
    subClose = NS.dom.qs('settingsSubClose');

    if (gear && NS.icons && NS.icons.icon) {
      NS.dom.clear(gear);
      var glyph = NS.icons.icon('settings', 'btn-icon');
      if (glyph) { gear.appendChild(glyph); }
      gear.setAttribute('aria-label', 'Settings');
    }
    if (gear) {
      gear.addEventListener('click', function () { if (isOpen()) { close(); } else { open(); } });
    }
    if (closeBtn) { closeBtn.addEventListener('click', close); }
    if (overlay) {
      overlay.addEventListener('click', function (event) {
        if (event.target === overlay) { close(); }
      });
    }
    if (subClose) { subClose.addEventListener('click', closeEditor); }
    if (subOverlay) {
      subOverlay.addEventListener('click', function (event) {
        if (event.target === subOverlay) { closeEditor(); }
      });
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
      // capture：先于 document/聊天动作拿到按键；录制期间 stopPropagation 后
      // 事件不会再落到 window 的其它监听器（含宿主工作台）。
      window.addEventListener('keydown', onRecordingKeyDown, true);
      window.addEventListener('blur', onWindowBlur, false);
    }
    if (document.addEventListener) {
      document.addEventListener('keydown', function (event) {
        if (event.key !== 'Escape') { return; }
        // 子面板优先：Esc 先收起编辑器，再按一次才关设置面板。
        if (isEditorOpen()) {
          event.preventDefault();
          event.stopPropagation();
          closeEditor();
          return;
        }
        if (isOpen()) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
      }, true);
    }
  }

  NS.settingsPanel = {
    init: init,
    open: open,
    close: close,
    setItems: setItems,
    isOpen: isOpen,
    activeGroup: function () { return active; }
  };
})(window.__vac = window.__vac || {});
`;
