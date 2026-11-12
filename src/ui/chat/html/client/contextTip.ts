// [CUSTOM- 上下文用量 Tip（2026-11-12）：点输入卡右下角的圆环，在它上方弹出。
//
// 数据全部来自宿主的 meta.usage（宿主在 usage_update / 轮次结束 / 压缩时填），
// 本模块只渲染、不推断：没有的字段就不画那一块，不显示 0 也不编估算值。
// 图表是手写 SVG，颜色走 --vscode-charts-*，浅色 / 深色 / 高对比主题自动适配。
//
// 面板关闭时不渲染、不量布局；打开时按签名去重 —— 流式期间 meta 推送频繁，
// 无脑重建会让曲线闪烁（与 composer 圆环同一条教训）。
export const contextTipClient = `
(function (NS) {
  'use strict';

  var meter = null;
  var panel = null;
  var sessionId = null;
  var usage = null;
  var running = false;
  var open = false;
  var signature = null;
  var tickTimer = null;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  // --- 格式化 -------------------------------------------------------------

  function fmtNumber(value) {
    if (typeof value !== 'number' || !isFinite(value)) { return ''; }
    if (value < 1000) { return String(Math.round(value)); }
    if (value < 1000000) {
      return value < 100000 ? (value / 1000).toFixed(1).replace(/\\.0$/, '') + 'k'
        : Math.round(value / 1000) + 'k';
    }
    return (value / 1000000).toFixed(1).replace(/\\.0$/, '') + 'M';
  }

  function fmtCost(amount) {
    if (typeof amount !== 'number' || !isFinite(amount)) { return ''; }
    return '$' + (amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2));
  }

  function fmtPercent(ratio) {
    if (typeof ratio !== 'number' || !isFinite(ratio)) { return ''; }
    return Math.round(ratio * 100) + '%';
  }

  function finite(value) {
    return typeof value === 'number' && isFinite(value) ? value : null;
  }

  var LIMIT_LABELS = {
    five_hour: '5-hour',
    seven_day: '7-day',
    seven_day_opus: '7-day Opus',
    seven_day_sonnet: '7-day Sonnet',
    overage: 'Overage',
  };

  function limitLabel(type) {
    return LIMIT_LABELS[type] || String(type || 'Limit');
  }

  /** "in 2h 13m" / "in 3d 4h" / "now" — 相对时间只在这里算，数据本身是 epoch 毫秒。 */
  function resetText(resetsAt) {
    var at = finite(resetsAt);
    if (at === null) { return ''; }
    var ms = at - Date.now();
    if (ms <= 0) { return 'resets now'; }
    var minutes = Math.round(ms / 60000);
    if (minutes < 60) { return 'resets in ' + minutes + 'm'; }
    var hours = Math.floor(minutes / 60);
    if (hours < 24) { return 'resets in ' + hours + 'h ' + (minutes % 60) + 'm'; }
    return 'resets in ' + Math.floor(hours / 24) + 'd ' + (hours % 24) + 'h';
  }

  // --- DOM helpers --------------------------------------------------------

  function svgEl(tag, attrs) {
    var node = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (var key in attrs) {
        if (Object.prototype.hasOwnProperty.call(attrs, key)) { node.setAttribute(key, attrs[key]); }
      }
    }
    return node;
  }

  function line(text, className) {
    return NS.dom.el('div', 'context-tip-line' + (className ? ' ' + className : ''), text);
  }

  function section(title, extra) {
    var box = NS.dom.el('div', 'context-tip-section');
    var head = NS.dom.el('div', 'context-tip-section-title');
    head.appendChild(NS.dom.el('span', '', title));
    if (extra) { head.appendChild(NS.dom.el('span', 'context-tip-section-extra', extra)); }
    box.appendChild(head);
    return box;
  }

  // --- 大圆环 -------------------------------------------------------------

  function buildRing(pct, outputRatio) {
    var size = 54;
    var half = size / 2;
    var radius = 21;
    var circumference = 2 * Math.PI * radius;
    var root = svgEl('svg', { viewBox: '0 0 ' + size + ' ' + size, width: String(size), height: String(size) });
    root.setAttribute('aria-hidden', 'true');
    root.appendChild(svgEl('circle', {
      class: 'gauge-track', cx: String(half), cy: String(half), r: String(radius),
    }));
    var fill = svgEl('circle', {
      class: 'gauge-fill', cx: String(half), cy: String(half), r: String(radius),
    });
    root.appendChild(fill);
    // [CUSTOM- 输出段节点**总是**在：实时更新只改属性，不能因为"此刻太短"就少一个节点
    // （否则流式期间输出段第一次变长时还得重建整块面板）。
    var output = svgEl('circle', {
      class: 'gauge-output', cx: String(half), cy: String(half), r: String(radius),
    });
    root.appendChild(output);
    applyRing(fill, output, pct, outputRatio);
    return { root: root, fill: fill, output: output };
  }

  /** 两段弧的几何：总弧长按 pct 缩放，输出段从提示段终点接着画。 */
  function applyRing(fill, output, pct, outputRatio) {
    if (!fill) { return; }
    var circumference = 2 * Math.PI * 21;
    var total = circumference * pct;
    var outputLen = total * (outputRatio || 0);
    var promptLen = total - outputLen;
    fill.setAttribute('stroke-dasharray', String(circumference));
    fill.setAttribute('stroke-dashoffset', String(circumference - promptLen));
    if (!output) { return; }
    output.setAttribute('stroke-dasharray', String(outputLen) + ' ' + String(circumference));
    output.setAttribute('stroke-dashoffset', String(-promptLen));
    output.setAttribute('display', outputLen > 0.5 ? 'inline' : 'none');
  }

  /** output / (input + output + cache read + cache write)；无拆分 = 0。 */
  function outputRatioOf(current) {
    var parts = current && current.parts;
    if (!parts) { return 0; }
    var total = (Number(parts.inputTokens) || 0) + (Number(parts.outputTokens) || 0)
      + (Number(parts.cachedReadTokens) || 0) + (Number(parts.cachedWriteTokens) || 0);
    if (!(total > 0)) { return 0; }
    return Math.max(0, Math.min(1, (Number(parts.outputTokens) || 0) / total));
  }

  // --- 增长曲线 -----------------------------------------------------------

  var CURVE_W = 288;
  var CURVE_H = 92;
  var PAD_L = 24;
  var PAD_R = 8;
  var PAD_T = 8;
  var PAD_B = 16;

  function curveX(turn, first, last) {
    if (last <= first) { return PAD_L + (CURVE_W - PAD_L - PAD_R) / 2; }
    return PAD_L + ((turn - first) / (last - first)) * (CURVE_W - PAD_L - PAD_R);
  }

  function curveY(ratio) {
    return PAD_T + (1 - Math.max(0, Math.min(1, ratio))) * (CURVE_H - PAD_T - PAD_B);
  }

  function buildCurve(history, compactions) {
    var root = svgEl('svg', {
      viewBox: '0 0 ' + CURVE_W + ' ' + CURVE_H,
      width: '100%', height: String(CURVE_H), class: 'context-tip-curve',
    });
    root.setAttribute('aria-hidden', 'true');
    // 70% / 90% 参考线：与圆环的 warn / hot 阈值同一口径。
    var guides = [0.7, 0.9];
    for (var g = 0; g < guides.length; g++) {
      root.appendChild(svgEl('line', {
        class: 'context-tip-guide', x1: String(PAD_L), x2: String(CURVE_W - PAD_R),
        y1: String(curveY(guides[g])), y2: String(curveY(guides[g])),
      }));
      var label = svgEl('text', {
        class: 'context-tip-guide-text', x: '2', y: String(curveY(guides[g]) + 3),
      });
      label.textContent = Math.round(guides[g] * 100) + '%';
      root.appendChild(label);
    }
    var zero = svgEl('text', { class: 'context-tip-guide-text', x: '2', y: String(curveY(0)) });
    zero.textContent = '0';
    root.appendChild(zero);

    if (!history || history.length === 0) {
      var empty = svgEl('text', {
        class: 'context-tip-empty-text', x: String(CURVE_W / 2), y: String(CURVE_H / 2 + 4),
      });
      empty.setAttribute('text-anchor', 'middle');
      empty.textContent = 'No turns yet';
      root.appendChild(empty);
      return root;
    }

    var first = history[0].turn;
    var last = history[history.length - 1].turn;
    var points = [];
    for (var i = 0; i < history.length; i++) {
      var sample = history[i];
      var ratio = sample.size > 0 ? sample.used / sample.size : 0;
      points.push({ x: curveX(sample.turn, first, last), y: curveY(ratio) });
    }

    // 面积 + 折线；只有一个点时只画点（一条竖线没有意义）。
    if (points.length > 1) {
      var area = 'M ' + points[0].x + ' ' + (CURVE_H - PAD_B);
      var path = 'M ' + points[0].x + ' ' + points[0].y;
      for (var p = 1; p < points.length; p++) {
        area += ' L ' + points[p].x + ' ' + points[p].y;
        path += ' L ' + points[p].x + ' ' + points[p].y;
      }
      area += ' L ' + points[points.length - 1].x + ' ' + (CURVE_H - PAD_B) + ' Z';
      root.appendChild(svgEl('path', { class: 'context-tip-area', d: area }));
      root.appendChild(svgEl('path', { class: 'context-tip-line-path', d: path }));
    }

    // 压缩标记：在发生压缩的轮次处画一条竖虚线 + 顶部三角。
    if (compactions) {
      for (var c = 0; c < compactions.length; c++) {
        var turn = compactions[c];
        if (turn < first || turn > last) { continue; }
        var x = curveX(turn, first, last);
        root.appendChild(svgEl('line', {
          class: 'context-tip-compact-line', x1: String(x), x2: String(x),
          y1: String(PAD_T), y2: String(CURVE_H - PAD_B),
        }));
        root.appendChild(svgEl('polygon', {
          class: 'context-tip-compact-mark',
          points: (x - 4) + ',' + (PAD_T - 2) + ' ' + (x + 4) + ',' + (PAD_T - 2) + ' ' + x + ',' + (PAD_T + 4),
        }));
      }
    }

    root.appendChild(svgEl('circle', {
      class: 'context-tip-dot', cx: String(points[points.length - 1].x),
      cy: String(points[points.length - 1].y), r: '2.5',
    }));
    var lastLabel = svgEl('text', {
      class: 'context-tip-guide-text', x: String(points[points.length - 1].x),
      y: String(CURVE_H - 4), 'text-anchor': 'middle',
    });
    lastLabel.textContent = 't' + last;
    root.appendChild(lastLabel);
    return root;
  }

  // --- 本轮 token 构成 ----------------------------------------------------

  var TURN_PARTS = [
    { key: 'cachedReadTokens', label: 'Cache read', className: 'part-cache-read' },
    { key: 'cachedWriteTokens', label: 'Cache write', className: 'part-cache-write' },
    { key: 'inputTokens', label: 'Input', className: 'part-input' },
    { key: 'outputTokens', label: 'Output', className: 'part-output' },
  ];

  function buildTurnBox(turn) {
    // "all calls"：这里的数字是本轮每次模型调用的累加（工具循环会重复读缓存），
    // 与圆环的"最近一次调用"不是一个口径，标题上必须写明。
    var box = section('This turn', 'all calls');
    var total = 0;
    for (var i = 0; i < TURN_PARTS.length; i++) {
      var value = finite(turn[TURN_PARTS[i].key]);
      if (value !== null && value > 0) { total += value; }
    }
    if (total <= 0) {
      box.appendChild(line('No token report for the last turn', 'dim'));
      return box;
    }
    var bar = NS.dom.el('div', 'context-tip-bar');
    for (var j = 0; j < TURN_PARTS.length; j++) {
      var amount = finite(turn[TURN_PARTS[j].key]) || 0;
      if (amount <= 0) { continue; }
      var part = NS.dom.el('span', 'context-tip-bar-part ' + TURN_PARTS[j].className);
      part.style.width = ((amount / total) * 100).toFixed(2) + '%';
      bar.appendChild(part);
    }
    box.appendChild(bar);
    var legend = NS.dom.el('div', 'context-tip-legend');
    for (var k = 0; k < TURN_PARTS.length; k++) {
      var partAmount = finite(turn[TURN_PARTS[k].key]) || 0;
      if (partAmount <= 0) { continue; }
      var item = NS.dom.el('span', 'context-tip-legend-item');
      item.appendChild(NS.dom.el('span', 'context-tip-swatch ' + TURN_PARTS[k].className));
      item.appendChild(NS.dom.el('span', '', TURN_PARTS[k].label + ' ' + fmtNumber(partAmount)));
      legend.appendChild(item);
    }
    box.appendChild(legend);
    var cacheRead = finite(turn.cachedReadTokens) || 0;
    var hit = cacheRead / total;
    if (hit > 0) { box.appendChild(line('Cache hit ' + fmtPercent(hit), 'dim')); }
    return box;
  }

  // --- 费用 ---------------------------------------------------------------

  function buildCostBox(current) {
    var sessionCost = finite(current.costAmount);
    var turnCost = current.lastTurn ? finite(current.lastTurn.costAmount) : null;
    var subagentCost = finite(current.subagentCostUsd);
    if (sessionCost === null && turnCost === null && subagentCost === null) { return null; }
    var box = section('Cost');
    var row = NS.dom.el('div', 'context-tip-cost-row');
    if (sessionCost !== null) {
      var totalCell = NS.dom.el('div', 'context-tip-cost-cell');
      totalCell.appendChild(NS.dom.el('div', 'context-tip-cost-value', fmtCost(sessionCost)));
      totalCell.appendChild(NS.dom.el('div', 'context-tip-cost-label', 'this session'));
      row.appendChild(totalCell);
    }
    if (turnCost !== null) {
      var turnCell = NS.dom.el('div', 'context-tip-cost-cell');
      turnCell.appendChild(NS.dom.el('div', 'context-tip-cost-value', '+' + fmtCost(turnCost)));
      turnCell.appendChild(NS.dom.el('div', 'context-tip-cost-label', 'last turn'));
      row.appendChild(turnCell);
    }
    if (subagentCost !== null && subagentCost > 0) {
      var agentCell = NS.dom.el('div', 'context-tip-cost-cell');
      agentCell.appendChild(NS.dom.el('div', 'context-tip-cost-value', fmtCost(subagentCost)));
      agentCell.appendChild(NS.dom.el('div', 'context-tip-cost-label', 'sub-agents'));
      row.appendChild(agentCell);
    }
    box.appendChild(row);
    return box;
  }

  // --- 速率额度 -----------------------------------------------------------

  function buildLimitsBox(limits) {
    if (!limits || limits.length === 0) { return null; }
    var box = section('Plan limits');
    for (var i = 0; i < limits.length; i++) {
      var limit = limits[i];
      var row = NS.dom.el('div', 'context-tip-limit');
      var head = NS.dom.el('div', 'context-tip-limit-head');
      head.appendChild(NS.dom.el('span', 'context-tip-limit-name', limitLabel(limit.type)));
      var ratio = finite(limit.utilization);
      head.appendChild(NS.dom.el('span', 'context-tip-limit-pct', ratio === null ? '—' : fmtPercent(ratio)));
      row.appendChild(head);
      var track = NS.dom.el('div', 'context-tip-limit-track');
      var barFill = NS.dom.el('div', 'context-tip-limit-fill');
      var statusClass = limit.status === 'rejected' ? ' hot'
        : (limit.status === 'allowed_warning' ? ' warn' : '');
      barFill.className += statusClass;
      barFill.style.width = ((ratio === null ? 0 : ratio) * 100).toFixed(1) + '%';
      track.appendChild(barFill);
      row.appendChild(track);
      var reset = resetText(limit.resetsAt);
      if (reset) {
        var resetEl = NS.dom.el('div', 'context-tip-line dim context-tip-reset');
        resetEl.setAttribute('data-resets-at', String(limit.resetsAt));
        resetEl.textContent = reset;
        row.appendChild(resetEl);
      }
      box.appendChild(row);
    }
    return box;
  }

  // --- 组装 ---------------------------------------------------------------

  /**
   * [CUSTOM- 只有**结构**变化才重建面板；used / size / 两段拆分的数值变化走 updateLive。
   *
   * 为什么分开：usage_update 在流式期间每个 delta 都会推一次 meta，全量重建一张含 SVG 的
   * 面板会把主线程拖垮（pitfall #53）。而结构（轮数、曲线点数、压缩标记、额度类型、
   * 有没有拆分）在轮次边界才变，重建频率完全可以接受。
   */
  function structuralSignatureOf(current) {
    if (!current) { return 'none'; }
    var turn = current.lastTurn;
    var parts = [
      current.turns || 0, current.model || '',
      current.costAmount === undefined ? '' : current.costAmount,
      current.subagentCostUsd === undefined ? '' : current.subagentCostUsd,
      current.parts ? 'parts' : '',
      turn ? [turn.inputTokens, turn.outputTokens, turn.cachedReadTokens, turn.cachedWriteTokens,
        turn.costAmount === undefined ? '' : turn.costAmount].join(',') : '',
      (current.history || []).length,
      (current.history && current.history.length > 0
        ? current.history[current.history.length - 1].turn : ''),
      (current.compactions || []).join(','),
      (current.rateLimits || []).map(function (limit) {
        return limit.type + ':' + limit.status + ':' + (limit.utilization === undefined ? '' : limit.utilization);
      }).join(','),
      running ? 'run' : 'idle',
    ];
    return parts.join('|');
  }

  function subTextOf(current) {
    var left = Math.max(0, current.size - current.used);
    var text = fmtNumber(left) + ' left';
    if (typeof current.turns === 'number' && current.turns > 0) { text += ' · ' + current.turns + ' turns'; }
    return text;
  }

  function lastCallTextOf(current) {
    if (!current.parts) { return ''; }
    var promptSum = (Number(current.parts.inputTokens) || 0)
      + (Number(current.parts.cachedReadTokens) || 0)
      + (Number(current.parts.cachedWriteTokens) || 0);
    return 'last call: prompt ' + fmtNumber(promptSum)
      + ' · output ' + fmtNumber(current.parts.outputTokens);
  }

  /** 面板打开时正在画的那几个会变的节点（render 创建，updateLive 原地改）。 */
  var live = null;

  function updateLive() {
    if (!live || !usage) { return; }
    var ratio = usage.size > 0 ? Math.max(0, Math.min(1, usage.used / usage.size)) : 0;
    applyRing(live.fill, live.output, ratio, outputRatioOf(usage));
    live.ringWrap.className = 'context-tip-ring'
      + (ratio > 0.9 ? ' hot' : (ratio > 0.7 ? ' warn' : ''));
    live.ringText.textContent = String(Math.round(ratio * 100));
    live.usedLine.textContent = fmtNumber(usage.used) + ' / ' + fmtNumber(usage.size) + ' tokens';
    live.subLine.textContent = subTextOf(usage);
    if (live.lastCallLine) { live.lastCallLine.textContent = lastCallTextOf(usage); }
  }

  function render() {
    if (!panel || !usage) { return; }
    var current = usage;
    var ratio = current.size > 0 ? Math.max(0, Math.min(1, current.used / current.size)) : 0;
    var percent = Math.round(ratio * 100);
    NS.dom.clear(panel);

    var head = NS.dom.el('div', 'context-tip-head');
    var ringWrap = NS.dom.el('div', 'context-tip-ring'
      + (ratio > 0.9 ? ' hot' : (ratio > 0.7 ? ' warn' : '')));
    var ring = buildRing(ratio, outputRatioOf(current));
    ringWrap.appendChild(ring.root);
    var ringText = NS.dom.el('span', 'context-tip-ring-text', String(percent));
    ringWrap.appendChild(ringText);
    head.appendChild(ringWrap);

    var main = NS.dom.el('div', 'context-tip-head-main');
    var titleRow = NS.dom.el('div', 'context-tip-title-row');
    titleRow.appendChild(NS.dom.el('span', 'context-tip-title', 'Context'));
    if (current.model) {
      titleRow.appendChild(NS.dom.el('span', 'context-tip-model', String(current.model)));
    }
    main.appendChild(titleRow);
    var usedLine = line(fmtNumber(current.used) + ' / ' + fmtNumber(current.size) + ' tokens', 'strong');
    main.appendChild(usedLine);
    var subLine = line(subTextOf(current), 'dim');
    main.appendChild(subLine);
    // [CUSTOM- 圆环双色的文字版：提示段 vs 输出段。它描述**最近一次调用**，
    // 与下面 "This turn (all calls)" 的累计口径不同，所以单独一行、不混进上面。
    var lastCallLine = null;
    if (current.parts) {
      lastCallLine = line(lastCallTextOf(current), 'dim');
      main.appendChild(lastCallLine);
    }
    head.appendChild(main);

    var closeBtn = NS.dom.el('button', 'context-tip-close', '×');
    closeBtn.type = 'button';
    closeBtn.title = 'Close';
    closeBtn.setAttribute('data-context-tip', 'close');
    head.appendChild(closeBtn);
    panel.appendChild(head);

    var compactions = current.compactions || [];
    var growth = section('Context growth', compactions.length > 0
      ? (compactions.length === 1 ? '1 compaction' : compactions.length + ' compactions') : '');
    growth.appendChild(buildCurve(current.history || [], compactions));
    panel.appendChild(growth);

    if (current.lastTurn) { panel.appendChild(buildTurnBox(current.lastTurn)); }
    var costBox = buildCostBox(current);
    if (costBox) { panel.appendChild(costBox); }
    var limitsBox = buildLimitsBox(current.rateLimits);
    if (limitsBox) { panel.appendChild(limitsBox); }

    var actions = NS.dom.el('div', 'context-tip-actions');
    var compact = NS.dom.el('button', 'context-tip-action context-tip-compact', '/compact');
    compact.type = 'button';
    compact.setAttribute('data-context-tip', 'compact');
    compact.title = running
      ? 'Wait for the running turn to finish'
      : 'Ask the agent to compact this conversation';
    compact.disabled = running || !sessionId;
    actions.appendChild(compact);
    var dashboard = NS.dom.el('button', 'context-tip-action context-tip-dashboard', 'Usage dashboard ↗');
    dashboard.type = 'button';
    dashboard.setAttribute('data-context-tip', 'dashboard');
    actions.appendChild(dashboard);
    panel.appendChild(actions);

    live = {
      fill: ring.fill, output: ring.output, ringText: ringText, ringWrap: ringWrap,
      usedLine: usedLine, subLine: subLine, lastCallLine: lastCallLine,
    };
  }

  function refreshIfChanged() {
    var next = structuralSignatureOf(usage);
    if (next === signature) { updateLive(); return; }
    signature = next;
    render();
  }

  function startTick() {
    if (tickTimer !== null || !window.setInterval) { return; }
    tickTimer = window.setInterval(function () {
      if (!open || !panel) { return; }
      var cells = panel.querySelectorAll('.context-tip-reset');
      for (var i = 0; i < cells.length; i++) {
        var at = Number(cells[i].getAttribute('data-resets-at'));
        cells[i].textContent = resetText(at);
      }
    }, 30000);
  }

  function stopTick() {
    if (tickTimer !== null && window.clearInterval) { window.clearInterval(tickTimer); }
    tickTimer = null;
  }

  /**
   * [CUSTOM- 面板贴着**圆环按钮**的上方，而不是对齐整个输入卡（用户 2026-11-12 报）。
   *
   * 量的是两个 rect 的相对位置：定位祖先是 .composer-inner，所以把面板的
   * right / bottom 换算成相对它的像素。元素尚未布局（rect 全 0）时直接跳过，
   * CSS 里的 right:0 / bottom:100% 作为回退。窗口宽度变化要重算。
   */
  function positionTip() {
    if (!open || !panel || !meter) { return; }
    var host = panel.parentNode;
    if (!host || !meter.getBoundingClientRect || !host.getBoundingClientRect) { return; }
    var ring = meter.getBoundingClientRect();
    var box = host.getBoundingClientRect();
    if (!ring.width && !ring.height) { return; }
    var ringRight = ring.left + ring.width;
    var boxRight = box.left + box.width;
    // 面板右缘对齐圆环右缘；clamp 到容器内（左侧至少留 8px）。
    var right = boxRight - ringRight;
    var maxRight = box.width > 352 ? box.width - 344 : 8;
    right = Math.max(8, Math.min(right, maxRight));
    var bottom = box.bottom - ring.top + 6;
    panel.style.right = right + 'px';
    panel.style.bottom = bottom + 'px';
  }

  function openPanel() {
    if (!panel || !usage || !usage.size) { return; }
    open = true;
    panel.hidden = false;
    if (meter) { meter.setAttribute('aria-expanded', 'true'); }
    signature = null;
    refreshIfChanged();
    positionTip();
    startTick();
  }

  function close() {
    if (!open && panel && panel.hidden) { return; }
    open = false;
    if (panel) { panel.hidden = true; }
    if (meter) { meter.setAttribute('aria-expanded', 'false'); }
    stopTick();
  }

  function toggle() {
    if (open) { close(); } else { openPanel(); }
  }

  /** 宿主推来的用量（composer.renderContext 转交）。null / 无窗口 ⇒ 收起并清空。 */
  function setUsage(id, next) {
    var changedSession = (id || null) !== sessionId;
    sessionId = id || null;
    usage = next && next.size ? next : null;
    if (!usage) {
      close();
      if (panel) { NS.dom.clear(panel); }
      signature = null;
      return;
    }
    if (changedSession) { close(); }
    if (open) { refreshIfChanged(); }
    // 圆环由 composer 负责显隐；这里只标"能不能点"。
    if (meter && meter.setAttribute) {
      meter.setAttribute('aria-haspopup', 'dialog');
    }
  }

  function setRunning(value) {
    var next = !!value;
    if (next === running) { return; }
    running = next;
    if (open) { refreshIfChanged(); }
  }

  function init() {
    meter = NS.dom.qs('contextMeter');
    panel = NS.dom.qs('contextTip');
    if (meter) {
      meter.addEventListener('click', function (event) {
        if (event && event.preventDefault) { event.preventDefault(); }
        toggle();
      });
    }
    if (panel) {
      panel.addEventListener('click', function (event) {
        var target = event && event.target;
        var action = target && target.closest ? target.closest('[data-context-tip]') : null;
        if (!action) { return; }
        var kind = action.getAttribute('data-context-tip');
        if (kind === 'close') { close(); return; }
        if (kind === 'compact') {
          if (running || !sessionId) { return; }
          NS.bridge.post({ type: 'sendPrompt', sessionId: sessionId, text: '/compact' });
          close();
          return;
        }
        if (kind === 'dashboard') {
          NS.bridge.post({ type: 'openDashboard' });
          close();
        }
      });
    }
    document.addEventListener('click', function (event) {
      if (!open) { return; }
      var target = event && event.target;
      if (panel && panel.contains(target)) { return; }
      if (meter && meter.contains(target)) { return; }
      close();
    }, false);
    document.addEventListener('keydown', function (event) {
      if (!open || !event || event.key !== 'Escape') { return; }
      if (event.preventDefault) { event.preventDefault(); }
      if (event.stopPropagation) { event.stopPropagation(); }
      close();
    }, true);
    // [CUSTOM- 圆环的位置随面板宽度 / 输入框高度变化，resize 与 ResizeObserver 都要重算
    // （关闭状态直接跳过）。没有 ResizeObserver 的环境只靠 resize。
    window.addEventListener('resize', function () { positionTip(); });
    if (window.ResizeObserver && panel && panel.parentNode) {
      var observer = new window.ResizeObserver(function () { positionTip(); });
      observer.observe(panel.parentNode);
    }
  }

  NS.contextTip = {
    init: init,
    setUsage: setUsage,
    setRunning: setRunning,
    close: close,
    isOpen: function () { return open; }
  };
})(window.__vac = window.__vac || {});
`;
