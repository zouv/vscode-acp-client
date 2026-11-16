// 图片点击放大（lightbox）：新增客户端模块。
// 记录区 content-image 与输入框 attachment-thumb 里的图片，点击后全屏放大查看。
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
export const lightboxClient = `
(function (NS) {
  'use strict';

  var overlay = null;
  var img = null;
  var currentSrc = '';
  // [CUSTOM- Pre-decode the PNG while the lightbox is open: the user's right-click →
  // "Copy image" then usually hits a ready blob instead of starting a decode whose
  // user activation may already have expired by the time the promise resolves.
  var cachedSrc = '';
  var cachedBlob = null;

  function open(src, alt) {
    if (!overlay || !img) { return; }
    currentSrc = src || '';
    if (currentSrc && currentSrc !== cachedSrc) {
      cachedSrc = currentSrc;
      cachedBlob = blobToPng(currentSrc);
    }
    img.setAttribute('src', src);
    img.setAttribute('alt', alt || '');
    overlay.hidden = false;
  }

  function close() {
    if (overlay) { overlay.hidden = true; }
    cachedSrc = '';
    cachedBlob = null;
  }

  /**
   * [CUSTOM- 2026-11-16] 把当前放大的图片写进系统剪贴板（用户要求：右键复制图片）。
   *
   * 宿主侧没有"写图片到剪贴板"的 API（vscode.env.clipboard 只有 writeText），所以走
   * webview 自己的 Clipboard API：把图片画到 canvas → toBlob('image/png') →
   * navigator.clipboard.write。Chromium 的 ClipboardItem 只稳定支持 image/png，
   * 因此统一转成 PNG；canvas 被跨域图片污染时 toBlob 抛错，退回"选中图片 + copy 命令"。
   *
   * 失败必须留痕（同仓库对复制失败的既有规矩）：webview console 只有 DevTools 里看得到，
   * 所以经 clientLog 写进扩展输出通道。
   */
  function logCopyFailure(reason) {
    if (NS.bridge && NS.bridge.post) {
      NS.bridge.post({
        type: 'clientLog', level: 'warn',
        message: 'copy image failed: ' + String(reason || 'unknown')
      });
    }
  }

  /** 选中放大图并让 Chromium 自己执行拷贝（支持图片的浏览器兜底路径）。 */
  function legacyCopy() {
    try {
      var selection = window.getSelection ? window.getSelection() : null;
      if (!selection || !document.createRange) { logCopyFailure('no selection API'); return; }
      var range = document.createRange();
      range.selectNode(img);
      selection.removeAllRanges();
      selection.addRange(range);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      selection.removeAllRanges();
      if (!ok) { logCopyFailure('execCommand copy refused'); }
    } catch (e) {
      logCopyFailure(e && e.message ? e.message : e);
    }
  }

  function blobToPng(url) {
    return new Promise(function (resolve) {
      var source = new Image();
      source.onload = function () {
        try {
          var canvas = document.createElement('canvas');
          canvas.width = source.naturalWidth || source.width;
          canvas.height = source.naturalHeight || source.height;
          if (!canvas.width || !canvas.height) { resolve(null); return; }
          var ctx = canvas.getContext('2d');
          if (!ctx) { resolve(null); return; }
          ctx.drawImage(source, 0, 0);
          if (!canvas.toBlob) { resolve(null); return; }
          canvas.toBlob(function (blob) { resolve(blob || null); }, 'image/png');
        } catch (e) {
          resolve(null);
        }
      };
      source.onerror = function () { resolve(null); };
      source.src = url;
    });
  }

  function copy() {
    var src = currentSrc;
    if (!src) { return; }
    var clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : null;
    if (!clipboard || !clipboard.write || !window.ClipboardItem) { legacyCopy(); return; }
    var ready = cachedSrc === src && cachedBlob ? cachedBlob : blobToPng(src);
    ready.then(function (blob) {
      if (!blob) { legacyCopy(); return; }
      try {
        return clipboard.write([new window.ClipboardItem({ 'image/png': blob })])
          .then(undefined, function (e) { legacyCopy(); logCopyFailure(e && e.message ? e.message : e); });
      } catch (e) {
        legacyCopy();
        logCopyFailure(e && e.message ? e.message : e);
        return null;
      }
    });
  }

  function isZoomable(node) {
    if (!node || node.tagName !== 'IMG') { return false; }
    var cls = String(node.className || '');
    return cls.indexOf('content-image') >= 0
      || cls.indexOf('content-thumb') >= 0
      || cls.indexOf('attachment-thumb') >= 0;
  }

  /**
   * [CUSTOM- What to enlarge for a click, or null.
   *
   * An image chip ('.content-image-chip') carries the source itself, so the WHOLE
   * chip is a hit target — clicking the filename must work as well as the thumbnail.
   * A bare image is still zoomable on its own (the input-box thumbnail).
   */
  function zoomTarget(node) {
    var current = node;
    while (current && current !== document.body) {
      if (current.getAttribute && current.getAttribute('data-zoom-src')) {
        return {
          src: current.getAttribute('data-zoom-src'),
          alt: current.getAttribute('data-zoom-alt') || ''
        };
      }
      if (isZoomable(current)) {
        return {
          src: current.getAttribute('src') || current.src || '',
          alt: current.getAttribute('alt') || ''
        };
      }
      current = current.parentNode;
    }
    return null;
  }

  function install() {
    overlay = NS.dom.qs('imageLightbox');
    if (!overlay) { return; }
    img = overlay.querySelector('.image-lightbox-img');
    var closeBtn = overlay.querySelector('.image-lightbox-close');
    if (closeBtn) { closeBtn.addEventListener('click', close); }
    // 点背景（不是图本身）就关。
    overlay.addEventListener('click', function (event) {
      if (event.target === overlay) { close(); }
    });
    document.addEventListener('keydown', function (event) {
      // [CUSTOM- 2026-10-29：capture + 标记已处理，保证它先于 composer 的
      // document Escape（停止确认）—— Esc 只关图，不该同时弹停止条。
      if (event.key !== 'Escape' || !overlay || overlay.hidden) { return; }
      if (event.preventDefault) { event.preventDefault(); }
      if (event.stopPropagation) { event.stopPropagation(); }
      close();
    }, true);
    document.body.addEventListener('click', function (event) {
      var hit = zoomTarget(event.target);
      if (hit && hit.src) {
        event.preventDefault();
        open(hit.src, hit.alt);
      }
    });
  }

  // [CUSTOM- 'install' 之外也把 'close' 交出去：切会话时 boot 要把它收起来
  // （浮层里是**上一个会话**的图，留着就盖住了新会话的内容 —— 与 154 那次"切走了浮框还在"
  // 同一条规矩：浮层属于它打开时的那个会话）。
  NS.lightbox = { install: install, close: close, copy: copy };
})(window.__vac = window.__vac || {});
`;
