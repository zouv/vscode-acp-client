// 记录类型图标（内联 SVG）：新增客户端模块。
// 参考 Claude Code 官方扩展的对话区：每类记录左侧一个小图标，一眼能分清「谁说的 / 在推理 /
// 跑了工具 / 是计划」。
//
// 为什么用内联 SVG 而不是 VS Code 的 codicon 字体：webview 的 CSP 是 `default-src 'none'`，
// 用字体要额外加 `font-src` 并把字体文件随扩展打包发布；而 SVG 元素不受 CSP 限制
// （CSP 管的是 `<img src>` / 字体 / 脚本，不管文档内的 SVG 标记）。用 `stroke="currentColor"`
// 还能自动跟随主题与所在文字的颜色（用户气泡=按钮前景色、推理=次要色）。
//
// **挂载位置是有讲究的**（放错会被抹掉）：
// · 助手气泡的文本会被流式更新整段重写、markdown 落地还会用 innerHTML 覆盖 → 图标放在
// **条目外层**（`.entry-assistant`），配一行 row 布局；
// · 推理块的 body 每片都重写 → 图标放在 **summary**（标签文字在收束时才重写一次，
// 那条路径已改成保留图标）；
// · 工具卡的头不会被整块清空（只改 status/title/kind 三个 span）→ 图标放**卡头**；
// · 用户消息只追加不重写 → 放气泡内最省事，但为统一仍走外层。
//
// 注意：本文件是嵌在模板字符串里的客户端代码，**每个反斜杠都要写成 `\\`**，禁用反引号。
export const iconsClient = `
(function (NS) {
  'use strict';

  var SVG_NS = 'http://www.w3.org/2000/svg';

  // 12x12 线稿图标。只用 circle / path 两种图元，路径刻意选直线与简单曲线——
  // 弧线命令写错时不会报错，只会画歪，所以宁可用基础图形拼。
  var SHAPES = {
    user: [
      ['circle', { cx: 6, cy: 4.5, r: 2.1 }],
      ['path', { d: 'M2.4 10.8c0-1.9 1.6-3.1 3.6-3.1s3.6 1.2 3.6 3.1' }]
    ],
    // [CUSTOM- 文件 chip 的图标：'</>'（官方插件的文件 tag 用的就是它）。
    // 三条 path 与原样式同规格（12×12、stroke=currentColor、无 fill），所以自动跟随主题色。
    file: [
      ['path', { d: 'M4.4 2.6 1.4 6l3 3.4' }],
      ['path', { d: 'M7.6 2.6 10.6 6l-3 3.4' }],
      ['path', { d: 'M8.6 1.9 3.4 10.1' }]
    ],
    // [CUSTOM- 额外根目录（additionalDirectories）的目录 chip 图标。
    folder: [
      ['path', { d: 'M1.5 3h3.2l1 1.2h4.8v6H1.5Z' }]
    ],
    // [CUSTOM- 通用「文档」图标（'Files or folders' 菜单项用，区别于 '</>' 代码文件）。
    document: [
      ['path', { d: 'M3 1.5h4.5L10 4v6.5H3Z' }],
      ['path', { d: 'M7.5 1.5V4H10' }]
    ],
    assistant: [
      ['path', { d: 'M2.4 3.2h7.2v4.4H5.8L3.6 9.6V7.6H2.4Z' }]
    ],
    thought: [
      ['circle', { cx: 6, cy: 4.7, r: 2.6 }],
      ['path', { d: 'M4.9 9.1h2.2' }],
      ['path', { d: 'M5.4 10.7h1.2' }]
    ],
    tool: [
      ['circle', { cx: 6, cy: 6, r: 2.1 }],
      ['path', { d: 'M6 1.9v1.4' }],
      ['path', { d: 'M6 8.7v1.4' }],
      ['path', { d: 'M1.9 6h1.4' }],
      ['path', { d: 'M8.7 6h1.4' }]
    ],
    plan: [
      ['path', { d: 'M2.6 3.2h6.8v6H2.6Z' }],
      ['path', { d: 'M4.5 5.4h3' }],
      ['path', { d: 'M4.5 7.4h2' }]
    ],
    notice: [
      ['circle', { cx: 6, cy: 6, r: 3.6 }],
      ['path', { d: 'M6 5.5v2.3' }],
      ['path', { d: 'M6 4.1v.01' }]
    ],
    // [CUSTOM- 历史会话：时钟。原来用文字字形 ↺，那是"撤销/刷新"的语义，
    // 读起来不像"历史"。时钟是"最近/历史"最通用的形状，且只用 circle + 直线，画不歪。
    history: [
      ['circle', { cx: 6, cy: 6.2, r: 3.9 }],
      ['path', { d: 'M6 3.9v2.4l1.7 1' }]
    ],
    // [CUSTOM- 地址栏「新输出自动展开」开关：上下两颗箭头朝外（卡片被撑开的样子）。
    expand: [
      ['path', { d: 'M6 1.8v3.2' }],
      ['path', { d: 'M4.5 3.5 6 5l1.5-1.5' }],
      ['path', { d: 'M6 10.2V7' }],
      ['path', { d: 'M4.5 8.5 6 7l1.5 1.5' }]
    ],
    // [CUSTOM- Tab 栏右侧的设置入口：圆心 + 四向刻度（简单齿轮，纯直线不画歪）。
    settings: [
      ['circle', { cx: 6, cy: 6, r: 2 }],
      ['path', { d: 'M6 1.5v1.6M6 8.9v1.6M1.5 6h1.6M8.9 6h1.6' }],
      ['path', { d: 'M2.9 2.9 4 4M8 8l1.1 1.1M9.1 2.9 8 4M4 8l-1.1 1.1' }]
    ],
    // [CUSTOM- 目录过滤 chip：折角文件夹（纯直线，画不歪）。
    folder: [
      ['path', { d: 'M1.8 3.2h2.6l1.1 1.2h4.7v4.6H1.8Z' }]
    ],
    // 输入区图标化：发送（向上箭头）/ 停止（方块）
    // 与图片附件的回退图标（相框，缩略图缺失时用）。
    send: [
      ['path', { d: 'M6 9.6V3.4' }],
      ['path', { d: 'M3.4 5.6 6 3l2.6 2.6' }]
    ],
    stop: [
      ['path', { d: 'M3.2 3.2h5.6v5.6H3.2Z' }]
    ],
    image: [
      ['path', { d: 'M2.5 3.2h7v5.6h-7Z' }],
      ['circle', { cx: 4.6, cy: 5.1, r: 0.8 }],
      ['path', { d: 'M3.2 8.2 5.4 6l1.6 1.6L9 5.4' }]
    ],
    // 历史列表行的悬停动作图标（归档 / 改名）。
    // 与官方插件的语义对齐；形状照本文件的规矩只用直线：归档 = 箱盖 + 箱体 + 提手缝，
    // 改名 = 一支斜放的铅笔（笔身四边形 + 笔头线），12×12、stroke=currentColor。
    archive: [
      ['path', { d: 'M1.6 2.4h8.8v2H1.6Z' }],
      ['path', { d: 'M2.4 5.2h7.2v4.4H2.4Z' }],
      ['path', { d: 'M4.8 6.6h2.4' }]
    ],
    rename: [
      ['path', { d: 'M8.2 2.2 9.8 3.8 4.6 9 2.4 9.6 3 7.4Z' }],
      ['path', { d: 'M7.2 3.2 8.8 4.8' }]
    ],
    // 历史列表行的真删除（与 Archive 并排）。同一条规矩：只用直线 —— 桶盖 + 提手 + 桶身
    // （上宽下窄）+ 两道桶纹。
    trash: [
      ['path', { d: 'M1.8 3.1h8.4' }],
      ['path', { d: 'M4.6 3.1V1.9h2.8v1.2' }],
      ['path', { d: 'M3.1 3.1 3.8 10.1h4.4l.7-7' }],
      ['path', { d: 'M5 5.2v3.2M7 5.2v3.2' }]
    ],
    // [CUSTOM- 输入卡四个选择器的按钮图标（2026-10-27）。原来的字符字形
    // （闪电 / 菱形 / 省略号 / 齿轮）语义不清，改成可辨认的线稿：
    // 模式 = 两条带滑块的滑轨；模型 = 芯片；Effort = 表盘；Agent = 机器人头。
    mode: [
      ['path', { d: 'M1.8 3.4h8.4' }],
      ['circle', { cx: '4.2', cy: '3.4', r: '1.3' }],
      ['path', { d: 'M1.8 8.6h8.4' }],
      ['circle', { cx: '7.8', cy: '8.6', r: '1.3' }]
    ],
    model: [
      ['path', { d: 'M3.2 3.2h5.6v5.6H3.2Z' }],
      ['path', { d: 'M4.8 4.8h2.4v2.4H4.8Z' }],
      ['path', { d: 'M4.6 3.2V1.6M7.4 3.2V1.6M4.6 10.4V8.8M7.4 10.4V8.8M3.2 4.6H1.6M3.2 7.4H1.6M10.4 4.6H8.8M10.4 7.4H8.8' }]
    ],
    effort: [
      ['path', { d: 'M2.1 9.4a4.6 4.6 0 0 1 7.8 0' }],
      ['path', { d: 'M6 9.4 8.1 6.1' }],
      ['circle', { cx: '6', cy: '9.4', r: '0.9' }]
    ],
    agent: [
      ['path', { d: 'M3 4.2h6v5H3Z' }],
      ['path', { d: 'M6 4.2V2.2' }],
      ['circle', { cx: '6', cy: '1.8', r: '0.5' }],
      ['path', { d: 'M4.6 6.2v.01M7.4 6.2v.01' }],
      ['path', { d: 'M4.8 7.8h2.4' }],
      ['path', { d: 'M3 5.6H1.8v2.2M9 5.6h1.2v2.2' }]
    ],
    check: [
      ['path', { d: 'M2.2 6.3 4.8 8.9 9.8 3.3' }]
    ]
  };

  /** Build the SVG element for a record kind, or null when there is no icon. */
  function svg(kind) {
    var shapes = SHAPES[kind];
    if (!shapes) { return null; }
    var root = document.createElementNS(SVG_NS, 'svg');
    root.setAttribute('viewBox', '0 0 12 12');
    root.setAttribute('width', '12');
    root.setAttribute('height', '12');
    root.setAttribute('fill', 'none');
    root.setAttribute('stroke', 'currentColor');
    root.setAttribute('stroke-width', '1');
    root.setAttribute('stroke-linecap', 'round');
    root.setAttribute('stroke-linejoin', 'round');
    root.setAttribute('aria-hidden', 'true');
    for (var i = 0; i < shapes.length; i++) {
      var part = document.createElementNS(SVG_NS, shapes[i][0]);
      var attrs = shapes[i][1];
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) {
          part.setAttribute(key, String(attrs[key]));
        }
      }
      root.appendChild(part);
    }
    return root;
  }

  /** Icon wrapper for one record kind (null when that kind has no icon). */
  function iconEl(kind, className) {
    var shape = svg(kind);
    if (!shape) { return null; }
    var wrap = NS.dom.el('span', className);
    wrap.appendChild(shape);
    return wrap;
  }

  // kind -> selector of the element that hosts the icon ('' = the entry itself).
  // Kinds left out on purpose: 'tool' gets its icon inside the card head (built by
  // toolCallView), 'content' is already visually distinct (image / chip rows),
  // and the permission card carries its own "?" badge.
  //
  // Everything that HAS an icon puts it inside its own content host (the bubble /
  // the summary / the plan title) rather than restructuring the entry: an earlier
  // attempt mounted the assistant icon on the entry and switched that entry to a
  // row layout, which touched the layout of every assistant record. The two
  // text-writing paths (setStreamingText, setSanitizedHtml) now preserve the icon
  // instead, so no layout change is needed at all.
  var HOST = {
    user: '.bubble',
    // [CUSTOM- The assistant record became a <details> whose summary is a
    // small header row; the icon belongs there (beside the caret), not in the body -
    // the body is the markdown host and gets rewritten on every chunk.
    assistant: '.msg-head',
    thought: 'summary',
    plan: '.plan-title',
    notice: ''
  };

  /**
   * Attach the type icon to an entry's DOM node. Idempotent: a node that already
   * carries an icon is left alone, so this is safe to call from both the first
   * paint and every rebuild path.
   */
  function attach(node, entry) {
    if (!node || !entry) { return; }
    var sel = HOST[entry.kind];
    if (sel === undefined) { return; }
    var host = sel ? node.querySelector(sel) : node;
    if (!host || host.querySelector('.rec-icon')) { return; }
    var icon = iconEl(entry.kind, 'rec-icon');
    if (!icon) { return; }
    host.insertBefore(icon, host.firstChild);
  }

  /** The icon for the tool card head (a different slot from 'attach'). */
  function toolIcon() {
    return iconEl('tool', 'tool-icon');
  }

  /** [CUSTOM- Clock icon for the history-sessions button. */
  function historyIcon() {
    return iconEl('history', 'btn-icon');
  }

  NS.icons = {
    attach: attach,
    toolIcon: toolIcon,
    historyIcon: historyIcon,
    // [CUSTOM- 大纲侧栏要按 kind 独立取图标（不再挂到记录气泡里），
    // 把私有的 iconEl 暴露出来。参数与 attach 里的一致：kind + 包装 class。
    icon: iconEl
  };
})(window.__vac = window.__vac || {});
`;
