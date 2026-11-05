// Mermaid 图表：客户端懒加载、图表/原文切换、失败回退与主题重渲染。
//
// 宿主只把 fence 渲染成 <pre data-mermaid="1">；这里把它包成 .mermaid-block。
// 只有 mermaid.render() 产出的 SVG 会绕过 NS.dom.sanitize，源码只从 code.textContent 读取。
// 流式期间不渲染：transcriptView 只在记录定稿（或工具结束）后调用 decorate()。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
export const mermaidClient = `
(function (NS) {
  'use strict';

  var NONCE = (function () {
    try {
      var current = document.currentScript;
      if (current && current.nonce) { return current.nonce; }
      var tagged = document.querySelector ? document.querySelector('script[nonce]') : null;
      return tagged ? (tagged.nonce || tagged.getAttribute('nonce') || '') : '';
    } catch (e) { return ''; }
  })();

  var loadPromise = null;
  var loadFailed = false;
  var initializedKey = null;
  var seq = 0;
  var renderChain = Promise.resolve();
  var themeObserver = null;
  var ZOOM_MIN = 50;
  var ZOOM_MAX = 200;
  var ZOOM_STEP = 10;

  function cssVar(name, fallback) {
    try {
      var value = window.getComputedStyle(document.body).getPropertyValue(name);
      return String(value || '').trim() || fallback;
    } catch (e) { return fallback; }
  }

  function themeKey() {
    var cls = document.body && document.body.classList ? document.body.classList : null;
    if (cls && cls.contains('vscode-high-contrast-light')) { return 'hc-light'; }
    if (cls && cls.contains('vscode-high-contrast')) { return 'hc-dark'; }
    if (cls && cls.contains('vscode-light')) { return 'light'; }
    return 'dark';
  }

  function initialize(mermaid) {
    var key = themeKey();
    if (initializedKey === key) { return; }
    initializedKey = key;
    var dark = key !== 'light' && key !== 'hc-light';
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      theme: 'base',
      fontFamily: cssVar('--vscode-font-family', 'sans-serif'),
      themeVariables: {
        background: 'transparent',
        primaryColor: cssVar('--vscode-editorWidget-background', dark ? '#252526' : '#f3f3f3'),
        primaryTextColor: cssVar('--vscode-editor-foreground', dark ? '#cccccc' : '#333333'),
        primaryBorderColor: cssVar('--vscode-panel-border', dark ? '#555555' : '#c8c8c8'),
        lineColor: cssVar('--vscode-descriptionForeground', dark ? '#9d9d9d' : '#666666'),
        textColor: cssVar('--vscode-editor-foreground', dark ? '#cccccc' : '#333333'),
        mainBkg: cssVar('--vscode-editorWidget-background', dark ? '#252526' : '#f3f3f3'),
        nodeBorder: cssVar('--vscode-panel-border', dark ? '#555555' : '#c8c8c8'),
        clusterBkg: 'transparent',
        clusterBorder: cssVar('--vscode-panel-border', dark ? '#555555' : '#c8c8c8'),
        edgeLabelBackground: cssVar('--vscode-editor-background', dark ? '#1e1e1e' : '#ffffff')
      },
      flowchart: { htmlLabels: false, useMaxWidth: true },
      sequence: { useMaxWidth: true },
      gantt: { useMaxWidth: true }
    });
  }

  function loadLibrary() {
    if (window.mermaid && typeof window.mermaid.render === 'function') {
      return Promise.resolve(window.mermaid);
    }
    if (loadFailed) { return Promise.reject(new Error('mermaid unavailable')); }
    if (loadPromise) { return loadPromise; }
    var src = document.body && document.body.getAttribute
      ? document.body.getAttribute('data-mermaid-src') : '';
    if (!src) {
      loadFailed = true;
      return Promise.reject(new Error('mermaid source missing'));
    }
    loadPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.async = true;
      if (NONCE) { script.setAttribute('nonce', NONCE); }
      var timer = window.setTimeout(function () {
        loadFailed = true;
        reject(new Error('mermaid load timeout'));
      }, 20000);
      script.onload = function () {
        window.clearTimeout(timer);
        if (window.mermaid && typeof window.mermaid.render === 'function') {
          resolve(window.mermaid);
        } else {
          loadFailed = true;
          reject(new Error('mermaid global missing'));
        }
      };
      script.onerror = function () {
        window.clearTimeout(timer);
        loadFailed = true;
        reject(new Error('mermaid script failed'));
      };
      script.src = src;
      (document.head || document.body).appendChild(script);
    });
    return loadPromise;
  }

  function sourceOf(pre) {
    var code = pre.querySelector ? pre.querySelector('code') : null;
    return String((code && code.textContent) || pre.textContent || '');
  }

  function makeButton(label, view) {
    var button = NS.dom.el('button', 'mermaid-tab');
    button.type = 'button';
    button.setAttribute('data-mermaid-view', view);
    button.setAttribute('aria-pressed', view === 'chart' ? 'true' : 'false');
    button.textContent = label;
    return button;
  }

  function makeZoomButton(label, action, className) {
    var button = NS.dom.el('button', className || 'mermaid-tab');
    button.type = 'button';
    button.setAttribute('data-mermaid-zoom-action', action);
    button.setAttribute('aria-label', action === 'reset' ? 'Reset zoom to fit' : action === 'in' ? 'Zoom in' : 'Zoom out');
    button.title = action === 'reset' ? 'Reset zoom to fit' : action === 'in' ? 'Zoom in' : 'Zoom out';
    button.textContent = label;
    return button;
  }

  function applyZoom(block) {
    if (!block) { return; }
    var zoom = block.mermaidZoom || 100;
    block.setAttribute('data-mermaid-zoom', String(zoom));
    var chart = block.querySelector('.mermaid-chart');
    if (chart) {
      if (chart.style && chart.style.setProperty) {
        chart.style.setProperty('--vac-mermaid-zoom', String(zoom / 100));
      } else if (chart.setAttribute) {
        chart.setAttribute('style', '--vac-mermaid-zoom:' + zoom / 100);
      }
    }
    var label = block.querySelector('[data-mermaid-zoom-label]');
    if (label) { label.textContent = zoom + '%'; }
  }

  function zoom(button) {
    var block = button && button.closest ? button.closest('.mermaid-block') : null;
    if (!block) { return; }
    var action = button.getAttribute('data-mermaid-zoom-action');
    var current = block.mermaidZoom || 100;
    var next = current;
    if (action === 'in') { next = current + ZOOM_STEP; }
    else if (action === 'out') { next = current - ZOOM_STEP; }
    else if (action === 'reset') { next = 100; }
    if (next < ZOOM_MIN) { next = ZOOM_MIN; }
    if (next > ZOOM_MAX) { next = ZOOM_MAX; }
    block.mermaidZoom = next;
    applyZoom(block);
  }

  function setView(block, view) {
    if (!block) { return; }
    if (view === 'chart' && block.getAttribute('data-mermaid-state') === 'error') { return; }
    block.setAttribute('data-view', view);
    var chart = block.querySelector('.mermaid-chart');
    var source = block.querySelector('.mermaid-source');
    if (chart) { chart.hidden = view !== 'chart'; }
    if (source) { source.hidden = view !== 'source'; }
    var buttons = block.querySelectorAll('[data-mermaid-view]');
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute(
        'aria-pressed',
        buttons[i].getAttribute('data-mermaid-view') === view ? 'true' : 'false'
      );
    }
  }

  function showView(button) {
    var block = button && button.closest ? button.closest('.mermaid-block') : null;
    if (!block) { return; }
    setView(block, button.getAttribute('data-mermaid-view'));
  }

  function fail(block) {
    if (!block || !block.parentNode) { return; }
    block.setAttribute('data-mermaid-state', 'error');
    setView(block, 'source');
    var error = block.querySelector('.mermaid-error');
    if (error) {
      error.hidden = false;
      error.textContent = 'Diagram could not be rendered. Showing the source.';
    }
    var buttons = block.querySelectorAll('[data-mermaid-view]');
    for (var i = 0; i < buttons.length; i++) {
      if (buttons[i].getAttribute('data-mermaid-view') !== 'chart') { continue; }
      buttons[i].disabled = true;
      buttons[i].setAttribute('aria-pressed', 'false');
    }
  }

  function cleanupTemp(id) {
    if (!document.getElementById) { return; }
    var ids = [id, 'd' + id];
    for (var i = 0; i < ids.length; i++) {
      var node = document.getElementById(ids[i]);
      if (node && node.parentNode) { node.parentNode.removeChild(node); }
    }
  }

  function renderOne(block) {
    if (!block || !block.parentNode) { return Promise.resolve(); }
    var source = block.mermaidSource;
    return loadLibrary().then(function (mermaid) {
      initialize(mermaid);
      if (!block.parentNode || block.mermaidSource !== source) { return; }
      var id = 'vac-mermaid-' + (++seq);
      return Promise.resolve().then(function () {
        return mermaid.render(id, source);
      }).then(function (result) {
        if (!block.parentNode || block.mermaidSource !== source) { return; }
        var svg = result && typeof result === 'object' ? result.svg : result;
        if (!svg) { throw new Error('empty diagram'); }
        var chart = block.querySelector('.mermaid-chart');
        if (chart) { chart.innerHTML = String(svg); }
        applyZoom(block);
        block.setAttribute('data-mermaid-state', 'ready');
        setView(block, block.getAttribute('data-view') === 'source' ? 'source' : 'chart');
      }).catch(function () {
        cleanupTemp(id);
        throw new Error('render failed');
      });
    }).catch(function () { fail(block); });
  }

  function scheduleRender(block) {
    renderChain = renderChain.then(function () { return renderOne(block); });
  }

  function wrap(pre) {
    var source = sourceOf(pre);
    var block = NS.dom.el('div', 'mermaid-block');
    block.setAttribute('data-mermaid-block', '1');
    block.setAttribute('data-view', 'chart');
    block.setAttribute('data-mermaid-state', 'loading');
    block.setAttribute('data-mermaid-zoom', '100');
    block.mermaidSource = source;
    block.mermaidZoom = 100;

    var toolbar = NS.dom.el('div', 'mermaid-toolbar');
    var zoomGroup = NS.dom.el('div', 'mermaid-zoom');
    zoomGroup.appendChild(makeZoomButton('\\u2212', 'out'));
    var percent = makeZoomButton('100%', 'reset', 'mermaid-tab mermaid-zoom-pct');
    percent.setAttribute('data-mermaid-zoom-label', '');
    zoomGroup.appendChild(percent);
    zoomGroup.appendChild(makeZoomButton('+', 'in'));
    var viewGroup = NS.dom.el('div', 'mermaid-view');
    viewGroup.appendChild(makeButton('Diagram', 'chart'));
    viewGroup.appendChild(makeButton('Source', 'source'));
    toolbar.appendChild(zoomGroup);
    toolbar.appendChild(viewGroup);
    var chart = NS.dom.el('div', 'mermaid-chart');
    var sourceHost = NS.dom.el('div', 'mermaid-source');
    sourceHost.hidden = true;
    var error = NS.dom.el('div', 'mermaid-error');
    error.hidden = true;

    pre.setAttribute('data-mermaid-block', '1');
    pre.parentNode.insertBefore(block, pre);
    sourceHost.appendChild(pre);
    block.appendChild(toolbar);
    block.appendChild(chart);
    block.appendChild(sourceHost);
    block.appendChild(error);
    return block;
  }

  function rerenderAll() {
    if (!document.querySelectorAll) { return; }
    var blocks = document.querySelectorAll('.mermaid-block[data-mermaid-state="ready"]');
    for (var i = 0; i < blocks.length; i++) {
      blocks[i].setAttribute('data-mermaid-state', 'loading');
      scheduleRender(blocks[i]);
    }
  }

  function watchTheme() {
    if (themeObserver || typeof MutationObserver === 'undefined' || !document.body) { return; }
    themeObserver = new MutationObserver(function () {
      if (initializedKey === themeKey()) { return; }
      initializedKey = null;
      rerenderAll();
    });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  function decorate(root, streaming) {
    if (!root || streaming || !root.querySelectorAll) { return; }
    watchTheme();
    var pres = root.querySelectorAll('pre[data-mermaid]');
    for (var i = 0; i < pres.length; i++) {
      var pre = pres[i];
      if (pre.getAttribute('data-mermaid-block') !== null) { continue; }
      if (pre.parentNode && pre.parentNode.getAttribute
        && pre.parentNode.getAttribute('data-mermaid-block') !== null) { continue; }
      scheduleRender(wrap(pre));
    }
  }

  NS.mermaid = { decorate: decorate, showView: showView, zoom: zoom };
})(window.__vac = window.__vac || {});
`;
