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
    closeEditor();
    overlay.hidden = true;
    if (gear && gear.focus) { gear.focus(); }
  }

  function setItems(next) {
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
    if (item.warning) { text.appendChild(NS.dom.el('div', 'settings-warning', item.warning)); }
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

  function renderControl(item) {
    var wrap = NS.dom.el('div', 'settings-control');
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
      // 1 的步长适合小整数（目录条数 3–16）；尺寸类仍用 10。
      num.setAttribute('step', item.max !== undefined && item.max <= 20 ? '1' : '10');
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

  /** 自定义模型列表的一行：id / 显示名 / 描述 / 删除。 */
  function modelRow(key, list, model) {
    var row = NS.dom.el('div', 'settings-model-row');
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
    var remove = NS.dom.el('button', 'settings-model-remove', '\\u00d7');
    remove.type = 'button';
    remove.title = 'Remove';
    var changed = function () {
      var models = collectModels(list);
      if (modelCommit) { modelCommit.snapshot = JSON.stringify(models); }
      send(key, models);
    };
    id.addEventListener('change', changed);
    name.addEventListener('change', changed);
    desc.addEventListener('change', changed);
    remove.addEventListener('click', function () {
      if (row.parentNode && row.parentNode.removeChild) { row.parentNode.removeChild(row); }
      changed();
    });
    row.appendChild(id);
    row.appendChild(name);
    row.appendChild(desc);
    row.appendChild(remove);
    return row;
  }

  function collectModels(list) {
    var out = [];
    var rows = list.querySelectorAll ? list.querySelectorAll('.settings-model-row') : [];
    for (var i = 0; i < rows.length; i++) {
      var inputs = rows[i].querySelectorAll ? rows[i].querySelectorAll('input') : [];
      var modelId = inputs[0] ? String(inputs[0].value || '').trim() : '';
      if (!modelId) { continue; }
      var entry = { modelId: modelId };
      var name = inputs[1] ? String(inputs[1].value || '').trim() : '';
      var description = inputs[2] ? String(inputs[2].value || '').trim() : '';
      if (name) { entry.name = name; }
      if (description) { entry.description = description; }
      out.push(entry);
    }
    return out;
  }

  function isEditorOpen() { return !!subOverlay && subOverlay.hidden === false; }

  /** 打开子面板：模型列表 / JSON 编辑器。主面板保持打开，子面板盖在它上面。 */
  function openEditor(item) {
    if (!subOverlay || !subBody) { return; }
    modelCommit = null;
    if (subTitle) { subTitle.textContent = item.label || item.key; }
    NS.dom.clear(subBody);
    var editor = NS.dom.el('div', 'settings-editor');
    if (item.description) {
      editor.appendChild(NS.dom.el('div', 'settings-editor-intro', item.description));
    }
    if (item.type === 'models') {
      // [CUSTOM- 表头 + 右对齐的动作（2026-10-21 排版调整）。
      editor.appendChild(NS.dom.el('div', 'settings-editor-intro',
        'Model id is sent to the agent; Alias is the label in the picker; Description is its subtitle and tooltip.'));
      var head = NS.dom.el('div', 'settings-model-head');
      head.appendChild(NS.dom.el('span', '', 'Model id'));
      head.appendChild(NS.dom.el('span', '', 'Alias'));
      head.appendChild(NS.dom.el('span', '', 'Description'));
      head.appendChild(NS.dom.el('span', '', ''));
      editor.appendChild(head);

      var list = NS.dom.el('div', 'settings-models');
      var rows = Object.prototype.toString.call(item.value) === '[object Array]' ? item.value : [];
      for (var m = 0; m < rows.length; m++) {
        list.appendChild(modelRow(item.key, list, rows[m]));
      }
      editor.appendChild(list);
      modelCommit = { key: item.key, list: list, snapshot: JSON.stringify(collectModels(list)) };

      var add = NS.dom.el('button', 'settings-action settings-model-add', 'Add model');
      add.type = 'button';
      add.addEventListener('click', function () {
        // 空行只存在于本地：一提交就会被宿主的 normalize 丢掉（那不是"新增失败"）。
        list.appendChild(modelRow(item.key, list, { modelId: '', name: '', description: '' }));
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
    // [CUSTOM- Esc / 点遮罩关闭时输入框不一定触发 change：关面板前按 DOM 真值补交一次。
    if (modelCommit) {
      var models = collectModels(modelCommit.list);
      if (JSON.stringify(models) !== modelCommit.snapshot) {
        send(modelCommit.key, models);
      }
      modelCommit = null;
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
