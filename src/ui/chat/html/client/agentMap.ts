// [CUSTOM- Agent map（2026-11-09）：底栏 "N Agents" 徽标 + 子 agent 树面板。
//
// 全部状态来自宿主下发的 `agentMap` 快照；本模块只渲染、不推断。
// 面板**关闭时不渲染也不量布局**；只有面板打开时才起 1s 的 elapsed 计时器。
export const agentMapClient = `
(function (NS) {
  'use strict';

  var btn = null;
  var panel = null;
  var closeBtn = null;
  var subtitle = null;
  var list = null;
  var detail = null;
  var focusId = null;
  var snapshot = null;
  var open = false;
  var selectedId = null;
  var elapsedCells = [];
  var tickTimer = null;

  function countOf(nodes) {
    var total = 0;
    for (var i = 0; i < nodes.length; i++) {
      total += 1 + countOf(nodes[i].children || []);
    }
    return total;
  }

  function stateLabel(state) {
    if (state === 'requires_action') { return 'Needs input'; }
    if (state === 'running') { return 'Running'; }
    if (state === 'idle') { return 'Idle'; }
    if (state === 'failed') { return 'Failed'; }
    if (state === 'cancelled') { return 'Cancelled'; }
    return 'Unknown';
  }

  function isRunning(state) {
    return state === 'running' || state === 'requires_action';
  }

  function fmtNumber(value) {
    if (typeof value !== 'number' || !isFinite(value)) { return ''; }
    if (value < 1000) { return String(Math.round(value)); }
    if (value < 1000000) { return (value / 1000).toFixed(value < 10000 ? 1 : 0) + 'k'; }
    return (value / 1000000).toFixed(1) + 'M';
  }

  function fmtCost(amount) {
    if (typeof amount !== 'number' || !isFinite(amount)) { return ''; }
    return '$' + (amount < 0.01 ? amount.toFixed(4) : amount.toFixed(2));
  }

  function elapsedMs(node) {
    if (isRunning(node.state) && typeof node.startedAt === 'number') {
      return Math.max(0, Date.now() - node.startedAt);
    }
    if (typeof node.durationMs === 'number') { return node.durationMs; }
    if (typeof node.startedAt === 'number' && typeof node.endedAt === 'number') {
      return Math.max(0, node.endedAt - node.startedAt);
    }
    return null;
  }

  function elapsedText(node) {
    var ms = elapsedMs(node);
    return ms === null ? '—' : NS.dom.duration(ms);
  }

  function tokenText(node) {
    if (typeof node.totalTokens === 'number') { return fmtNumber(node.totalTokens) + ' tok'; }
    if (typeof node.contextUsed === 'number' && typeof node.contextSize === 'number') {
      return fmtNumber(node.contextUsed) + '/' + fmtNumber(node.contextSize);
    }
    return '—';
  }

  function displayName(node) {
    if (node.title) { return node.title; }
    if (node.description) { return node.description; }
    return String(node.agentId || '').slice(0, 8);
  }

  function renderBadge() {
    if (!btn) { return; }
    var total = snapshot ? countOf(snapshot.agents || []) : 0;
    btn.hidden = !focusId || total === 0;
    if (btn.hidden) { return; }
    var running = typeof snapshot.running === 'number' ? snapshot.running : 0;
    btn.textContent = running + ' Agents';
    btn.title = running === 1 ? '1 agent running' : running + ' agents running';
    btn.className = 'agent-map-btn' + (open ? ' open' : '');
  }

  function stopTick() {
    if (tickTimer !== null && window.clearInterval) { window.clearInterval(tickTimer); }
    tickTimer = null;
  }

  function startTick() {
    if (tickTimer !== null || !window.setInterval) { return; }
    tickTimer = window.setInterval(function () {
      for (var i = 0; i < elapsedCells.length; i++) {
        var cell = elapsedCells[i];
        var ms = elapsedMs(cell.node);
        cell.el.textContent = ms === null ? '—' : NS.dom.duration(ms);
      }
    }, 1000);
  }

  function field(label, value) {
    var row = NS.dom.el('div', 'agent-map-field');
    row.appendChild(NS.dom.el('span', 'agent-map-field-label', label));
    row.appendChild(NS.dom.el('span', 'agent-map-field-value', value));
    return row;
  }

  function findNode(list, id) {
    for (var i = 0; i < list.length; i++) {
      if (list[i].agentId === id) { return list[i]; }
      var found = findNode(list[i].children || [], id);
      if (found) { return found; }
    }
    return null;
  }

  function renderDetail() {
    if (!detail) { return; }
    NS.dom.clear(detail);
    var node = snapshot && selectedId ? findNode(snapshot.agents || [], selectedId) : null;
    if (!node) { detail.hidden = true; return; }
    detail.hidden = false;
    detail.appendChild(field('State', stateLabel(node.state)));
    detail.appendChild(field('Duration', elapsedText(node)));
    if (node.model) { detail.appendChild(field('Model', node.model)); }
    var tokens = tokenText(node);
    detail.appendChild(field('Tokens', tokens));
    if (typeof node.toolUses === 'number') { detail.appendChild(field('Tool calls', fmtNumber(node.toolUses))); }
    var cost = fmtCost(node.costUsd);
    if (cost) { detail.appendChild(field('Cost', cost)); }
    if (node.description) { detail.appendChild(field('Description', node.description)); }
    if (node.summary) { detail.appendChild(field('Summary', node.summary)); }
    if (node.lastToolName) { detail.appendChild(field('Last tool', node.lastToolName)); }
    if (node.error) { detail.appendChild(field('Error', node.error)); }
    if (isRunning(node.state) && node.canCancel) {
      var stop = NS.dom.el('button', 'agent-map-stop', 'Stop');
      stop.type = 'button';
      stop.setAttribute('data-agent-id', node.agentId);
      detail.appendChild(stop);
    }
  }

  function appendRows(nodes, depth, out) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      var row = NS.dom.el('div', 'agent-map-row state-' + node.state
        + (node.agentId === selectedId ? ' selected' : ''));
      row.setAttribute('data-agent-id', node.agentId);
      if (depth > 0) { row.style.paddingLeft = (depth * 14) + 'px'; }
      row.appendChild(NS.dom.el('span', 'agent-map-dot'));
      row.appendChild(NS.dom.el('span', 'agent-map-name', displayName(node)));
      var time = NS.dom.el('span', 'agent-map-time', elapsedText(node));
      row.appendChild(time);
      row.appendChild(NS.dom.el('span', 'agent-map-tokens', tokenText(node)));
      // [CUSTOM- 只有 running 的 elapsed 会变：历史行不参与 1s 重写。
      if (isRunning(node.state) && typeof node.startedAt === 'number') {
        elapsedCells.push({ node: node, el: time });
      }
      out.push(row);
      appendRows(node.children || [], depth + 1, out);
    }
  }

  function renderPanel() {
    if (!panel || !list) { return; }
    var agents = snapshot ? (snapshot.agents || []) : [];
    var total = countOf(agents);
    if (total === 0) { closePanel(); return; }
    if (subtitle) { subtitle.textContent = total + ' agents · click an agent for details'; }
    NS.dom.clear(list);
    elapsedCells = [];
    var rows = [];
    appendRows(agents, 0, rows);
    for (var i = 0; i < rows.length; i++) { list.appendChild(rows[i]); }
    if (selectedId && !findNode(agents, selectedId)) { selectedId = null; }
    renderDetail();
  }

  function openPanel() {
    if (!panel) { return; }
    var total = snapshot ? countOf(snapshot.agents || []) : 0;
    if (total === 0) { return; }
    open = true;
    panel.hidden = false;
    renderBadge();
    renderPanel();
    startTick();
  }

  function closePanel() {
    open = false;
    if (panel) { panel.hidden = true; }
    stopTick();
    renderBadge();
  }

  function togglePanel() {
    if (open) { closePanel(); } else { openPanel(); }
  }

  function setFocus(sessionId) {
    if (sessionId === focusId) { return; }
    focusId = sessionId || null;
    snapshot = null;
    selectedId = null;
    closePanel();
    renderBadge();
    if (focusId) { NS.bridge.post({ type: 'requestAgentMap', sessionId: focusId }); }
  }

  function setSnapshot(message) {
    if (!message || message.sessionId !== focusId) { return; }
    snapshot = { running: typeof message.running === 'number' ? message.running : 0, agents: message.agents || [] };
    if (selectedId && !findNode(snapshot.agents, selectedId)) { selectedId = null; }
    renderBadge();
    if (open) { renderPanel(); }
  }

  function choose(agentId) {
    selectedId = agentId;
    renderPanel();
  }

  function stopAgent(agentId) {
    if (!focusId || !agentId) { return; }
    NS.bridge.post({ type: 'stopAgent', sessionId: focusId, agentId: agentId });
  }

  function init() {
    btn = NS.dom.qs('agentMapBtn');
    panel = NS.dom.qs('agentMapPanel');
    closeBtn = NS.dom.qs('agentMapClose');
    subtitle = NS.dom.qs('agentMapSubtitle');
    list = NS.dom.qs('agentMapList');
    detail = NS.dom.qs('agentMapDetail');
    if (btn) {
      btn.addEventListener('click', function (event) {
        if (event && event.preventDefault) { event.preventDefault(); }
        togglePanel();
      });
    }
    if (closeBtn) {
      closeBtn.addEventListener('click', function (event) {
        if (event && event.stopPropagation) { event.stopPropagation(); }
        closePanel();
      });
    }
    if (panel) {
      panel.addEventListener('click', function (event) {
        var target = event && event.target;
        var stop = target && target.closest ? target.closest('.agent-map-stop') : null;
        if (stop) {
          if (event.stopPropagation) { event.stopPropagation(); }
          stop.disabled = true;
          stopAgent(stop.getAttribute('data-agent-id'));
          return;
        }
        var row = target && target.closest ? target.closest('.agent-map-row') : null;
        if (row) {
          if (event.stopPropagation) { event.stopPropagation(); }
          choose(row.getAttribute('data-agent-id'));
        }
      });
    }
    document.addEventListener('click', function (event) {
      if (!open) { return; }
      var target = event && event.target;
      if (panel && panel.contains(target)) { return; }
      if (btn && btn.contains(target)) { return; }
      closePanel();
    }, false);
    document.addEventListener('keydown', function (event) {
      if (!open || !event || event.key !== 'Escape') { return; }
      if (event.preventDefault) { event.preventDefault(); }
      if (event.stopPropagation) { event.stopPropagation(); }
      closePanel();
    }, true);
  }

  NS.agentMap = {
    init: init,
    setFocus: setFocus,
    setSnapshot: setSnapshot,
    open: openPanel,
    close: closePanel,
    isOpen: function () { return open; }
  };
})(window.__vac = window.__vac || {});
`;
