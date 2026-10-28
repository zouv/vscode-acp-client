// 新 Chat 面板（Claude Code 优先）与面板路由层：新增文件。
// 「贴底」滚动策略。旧面板无条件 `scrollTop = scrollHeight`，用户往上翻看历史会被反复拽回底部；
// 这里只在用户本来就贴着底部时才自动滚动，否则显示「回到最新」按钮。
// 每个会话各自记住自己的滚动位置。
export const scrollClient = `
(function (NS) {
  'use strict';

  var PIN_THRESHOLD = 32;
  var pinned = true;
  var container = null;
  var jumpBtn = null;
  var offsets = {};
  // [CUSTOM-
  // 合帧：follow() 只置脏位，真正的布局读取与 scrollTop 写入发生在 rAF 回调里。
  // 逐条 chunk 直接读写 scrollHeight 会在一次回复里触发上百次强制重排。
  var followPending = false;
  // 滚动记忆的「再对齐」状态：切回一个会话时先按记录恢复位置，随后 markdown 回填
  // 会改变高度、把位置冲掉，所以要在收到渲染结果后再对齐一次。
  // 只在**用户自己滚动**时放弃（expectedTop 用来区分程序写入与用户滚动）。
  var restoreTarget = null;
  var expectedTop = 0;

  // [CUSTOM- 内层滚动卡片：焦点门控 + 自动追尾（2026-10-28）。
  //
  // 问题：卡片内部自带纵向滚动条（.diff-body / .tool-seg-out / .thought-body /
  // 自动展开的 .tool-body）。滚轮一进卡片就被它吃掉，整块面板的滚动因此中断。
  //
  // 两条规则：
  // · **焦点门控**：滚轮默认滚整个面板；只有用户**点进**某张卡片、让它的内层滚动区
  //   拿到 scroll-active 环之后，这张卡片才吃滚轮。点面板空白或别的卡片即交还。
  // · **自动追尾**：正在流式的卡片（推理的 .thought-spin / 工具的 tc-in_progress /
  //   子 agent 的 running）内容长高时，贴着自身底部的内层滚动区继续跟到最后一行；
  //   用户自己滚上去了就不再抢（innerPinned 记着这件事）。
  var ACTIVE_CLASS = 'scroll-active';
  // 卡片里可能带纵向滚动条的已知容器：点标题栏（落点不在任何滚动区里）时按它找焦点面。
  // 新增这类容器要加进来；点内容本身仍经祖先链找到，不受这张表限制。
  var INNER_SCROLL_SELECTOR = '.thought-body, .tool-body, .tool-seg-out, .diff-body, .elic-preview';
  var activeScroller = null;
  var activeCard = null;
  var innerPinned = (typeof WeakMap === 'function') ? new WeakMap() : null;
  var tailQueue = [];
  var tailPending = false;
  // [CUSTOM- Tail（地址栏那颗按钮，2026-10-28）：开着就**无视 pinned** 一律跟到最后一条。
  // 用户用滚轮 / 拖动滚动条改变了阅读进度（非程序写入的 scroll 事件）⇒ 就地关掉并通知
  // client/tail.ts（状态与按钮在那边，这里只持有运行时的旗标）。
  var tail = false;
  // 上一次"被门控吞掉滚轮"的卡片 —— 只在换卡片时记一条日志。滚动热路径上每 700ms 记一条
  // 会把日志桥的共享配额（10s/30 条）吃掉，反而埋掉 pinned/unpinned 那些关键信号。
  var lastGateCard = null;

  function classNameOf(node) {
    var name = (node && node.className) ? String(node.className) : '';
    var at = name.indexOf(' ');
    return (at >= 0 ? name.slice(0, at) : name) || '?';
  }

  /** 这个元素**自己**能不能纵向滚（overflow 允许 + 内容真的超出）。 */
  function isVertScrollable(node) {
    if (!node || node === container || node.nodeType !== 1) { return false; }
    if (!window.getComputedStyle) { return false; }
    var cs = window.getComputedStyle(node);
    if (!cs || (cs.overflowY !== 'auto' && cs.overflowY !== 'scroll')) { return false; }
    return node.scrollHeight > node.clientHeight + 1;
  }

  /** 从 node 往上找最近的纵向滚动容器（不越过 #messages）。 */
  function nearestVertScroller(node) {
    var current = node;
    while (current && current !== container) {
      if (isVertScrollable(current)) { return current; }
      current = current.parentNode;
    }
    return null;
  }

  /** node 所属的顶层记录节点（#messages 的直系子节点）。 */
  function topCardOf(node) {
    var current = node;
    while (current && current.parentNode && current.parentNode !== container) { current = current.parentNode; }
    return (current && current.parentNode === container) ? current : null;
  }

  /** 卡片里第一块纵向滚动区（落点在标题栏这类"不在滚动区里"的地方时用）。 */
  function firstInnerScroller(card) {
    if (!card || !card.querySelectorAll) { return null; }
    var list = card.querySelectorAll(INNER_SCROLL_SELECTOR);
    for (var i = 0; i < list.length; i++) {
      if (isVertScrollable(list[i])) { return list[i]; }
    }
    return null;
  }

  function setActive(next, card) {
    if (next && !card) { card = topCardOf(next); }
    if (next === activeScroller) { if (card) { activeCard = card; } return; }
    if (activeScroller && activeScroller.classList) { activeScroller.classList.remove(ACTIVE_CLASS); }
    activeScroller = next;
    activeCard = next ? (card || topCardOf(next)) : null;
    if (activeScroller && activeScroller.classList) { activeScroller.classList.add(ACTIVE_CLASS); }
    lastGateCard = null;
    logScrollState('focus:' + (activeScroller ? classNameOf(activeScroller) : 'panel'), true);
  }

  /** 卡片重建（工具输出每个 chunk 都会重建 body）后，把焦点环挂到新容器上。 */
  function reclaimActive() {
    if (!activeCard || !activeScroller) { return; }
    var attached = document.contains ? document.contains(activeScroller) : !!activeScroller.parentNode;
    if (attached) { return; }
    if (document.contains && !document.contains(activeCard)) { activeScroller = null; activeCard = null; return; }
    activeScroller = firstInnerScroller(activeCard);
    if (activeScroller && activeScroller.classList) { activeScroller.classList.add(ACTIVE_CLASS); }
  }

  function wheelDelta(event) {
    var delta = event.deltaY || 0;
    if (event.deltaMode === 1) { delta = delta * 16; }
    else if (event.deltaMode === 2) { delta = delta * (container ? container.clientHeight : 400); }
    return delta;
  }

  /**
   * 滚内层容器。**到边界就停，绝不把余量交给面板**。
   *
   * 这是用户明确要的语义（2026-10-28）：「鼠标在卡片区域内 ⇒ 只滚卡片；移出区域 ⇒ 才滚面板」。
   * 早先那版把滚到头的余量交给面板，手感上就是"卡片和面板一起滚"——聚焦卡片之后面板必须原地不动。
   */
  function scrollInner(node, delta) {
    var max = node.scrollHeight - node.clientHeight;
    var next = node.scrollTop + delta;
    if (next < 0) { next = 0; }
    if (next > max) { next = max; }
    node.scrollTop = next;
  }

  /** 这张卡片现在还在长内容吗？（流式推理 / 运行中的工具 / 运行中的子 agent） */
  function isLiveCard(card) {
    if (!card || !card.querySelector) { return false; }
    if (card.querySelector('.thought-spin')) { return true; }
    if (card.querySelector('.tool-status.tc-in_progress')) { return true; }
    if (card.querySelector('.subagent-state[data-state="running"]')) { return true; }
    return false;
  }

  function pushTailCandidate(node) {
    if (tailQueue.indexOf(node) < 0) { tailQueue.push(node); }
  }

  /** 把变化点自己与祖先里所有纵向滚动容器都记进本批候选。 */
  function noteTailCandidate(node) {
    var current = node;
    while (current && current !== container) {
      if (current.nodeType === 1 && isVertScrollable(current)) { pushTailCandidate(current); }
      current = current.parentNode;
    }
  }

  /** 新增子树里的滚动容器（工具 body 重建时新容器是 addedNode，不在祖先链上）。 */
  function noteAddedNodes(added) {
    if (!added) { return; }
    for (var i = 0; i < added.length; i++) {
      var node = added[i];
      if (!node || node.nodeType !== 1) { continue; }
      if (isVertScrollable(node)) { pushTailCandidate(node); }
      if (!node.querySelectorAll) { continue; }
      var inner = node.querySelectorAll(INNER_SCROLL_SELECTOR);
      for (var j = 0; j < inner.length; j++) {
        if (isVertScrollable(inner[j])) { pushTailCandidate(inner[j]); }
      }
    }
  }

  function flushTails() {
    tailPending = false;
    var list = tailQueue;
    tailQueue = [];
    if (!container) { return; }
    for (var i = 0; i < list.length; i++) {
      var node = list[i];
      if (!node.parentNode || !isVertScrollable(node)) { continue; }
      // 用户在这个容器里自己滚上去了：不再抢（与面板的 pinned 同一条判据）。
      if (innerPinned && innerPinned.get(node) === false) { continue; }
      // 只追**还在流式**的卡片。历史回放 / 已完成的卡片不追，否则一打开旧会话，
      // 每个长输出卡都会停在自己的末尾而不是开头。
      if (!isLiveCard(topCardOf(node))) { continue; }
      if (node.scrollTop >= node.scrollHeight - node.clientHeight - 1) { continue; }
      node.scrollTop = node.scrollHeight;
      if (innerPinned) { innerPinned.set(node, true); }
    }
  }

  function init(messagesEl, jumpButton) {
    container = messagesEl;
    jumpBtn = jumpButton;
    // [CUSTOM- 滚动事件的**来源**要分得清：用户拖的 vs 我们自己写的
    // （程序写 scrollTop 也会派发 scroll）。分开记，读的时候才不会把"我们跟到底了"
    // 看成"用户自己滚到底了"。判据沿用 restore 那套记账（写完之后回读一次）。
    container.addEventListener('scroll', function () {
      var fromProgram = lastProgrammaticTop >= 0
        && Math.abs(container.scrollTop - lastProgrammaticTop) <= 2;
      // [CUSTOM- 用户自己改了阅读进度（滚轮 / 拖滚动条）⇒ Tail 就地关掉。
      // 程序写入（follow / restore / Jump）不算 —— 否则 Tail 会在第一次跟随时把自己关掉。
      if (!fromProgram) { cancelTail('scroll'); }
      logScrollState(fromProgram ? 'scroll-after-program' : 'user-scroll');
      onScroll();
    });
    // [CUSTOM- 滚轮单独留一条：用户报的"点 Jump 正常、滚轮一碰又错乱"里，真正要看的是
    // **滚轮之后**的几何（scroll 事件可能不派发：夹紧、焦点切换、内容在写入之后才长高）。
    // 每次滚轮在下一帧采样一次，deltaY 一起记 —— 用来区分"他往上滚了一格"与"位置没动"。
    var wheelPending = false;
    var lastWheelDelta = 0;
    container.addEventListener('wheel', function (event) {
      lastWheelDelta = Math.round((event && event.deltaY) || 0);
      if (wheelPending) { return; }
      wheelPending = true;
      var run = function () {
        wheelPending = false;
        if (!container) { return; }
        logScrollState('wheel dy=' + lastWheelDelta, false);
      };
      if (NS.dom && NS.dom.schedule) { NS.dom.schedule(run); } else { run(); }
    }, { passive: true });
    // [CUSTOM- 点进卡片 = 这张卡片的内层滚动区拿到滚轮（两条规则见文件上方 State 区）。
    // 点面板空白 / 输入卡 / 标签栏都算"交还"，滚轮回到整个面板。
    if (document.addEventListener) { document.addEventListener('pointerdown', function (event) {
      if (!container) { return; }
      var target = event && event.target;
      if (!target || !container.contains || !container.contains(target) || target === container) {
        setActive(null);
        return;
      }
      var card = topCardOf(target);
      if (!card) { setActive(null); return; }
      setActive(nearestVertScroller(target) || firstInnerScroller(card), card);
    }, true); }
    // [CUSTOM- 滚轮门控（capture + 非 passive）——按**指针位置**分流，两边互不牵连：
    // · 指针落在**已聚焦卡片**里 ⇒ 只滚这张卡的内层滚动区（到边界就停，面板原地不动）；
    // · 指针落在**未聚焦卡片**里、且那里确实有内层滚动区 ⇒ preventDefault 后滚面板 ——
    //   这正是"卡片里的滚动条打断整块面板滚动"的病灶；
    // · 指针离开卡片（面板空白 / 别的卡片 / 浮层）⇒ 走浏览器默认，滚的是面板；
    // · 横向滚动（Shift+滚轮 / 触控板横滑）与 Ctrl/Cmd+滚轮（IDE 缩放）一律放行。
    if (document.addEventListener) { document.addEventListener('wheel', function (event) {
      if (!container || !event || !container.contains) { return; }
      var target = event.target;
      if (!target || !container.contains(target)) { return; }
      if (event.ctrlKey || event.metaKey) { return; }
      if (!event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) { return; }
      if (event.cancelable === false) { return; }
      var card = topCardOf(target);
      if (!card) { return; }
      var delta = wheelDelta(event);
      if (!delta) { return; }
      var focused = !!(activeCard && card === activeCard);
      // 聚焦卡片的滚动目标是"它自己的滚动区"；滚动区被重建（工具 body 每个 chunk 都会重建）
      // 或内容缩到装不下时，退回落点所在的那一个。两者都没有 ⇒ 交回默认（面板自己滚）。
      var own = focused && activeScroller
        && (document.contains ? document.contains(activeScroller) : !!activeScroller.parentNode)
        && isVertScrollable(activeScroller);
      var scroller = own ? activeScroller : nearestVertScroller(target);
      if (!scroller) { return; }
      event.preventDefault();
      if (focused) { scrollInner(scroller, delta); } else { writeTop(container.scrollTop + delta); }
      if (card !== lastGateCard) {
        lastGateCard = card;
        logScrollState((focused ? 'wheel-card:' : 'wheel-gate:') + classNameOf(scroller), false);
      }
    }, { passive: false, capture: true }); }
    // [CUSTOM- 用户在内层容器里自己滚开 ⇒ 不再追尾（判据与面板的 pinned 相同）。
    if (document.addEventListener) { document.addEventListener('scroll', function (event) {
      var target = event && event.target;
      if (!target || !container || !container.contains || target === container) { return; }
      if (!innerPinned || !container.contains(target)) { return; }
      if (target.nodeType !== 1 || !isVertScrollable(target)) { return; }
      var innerMax = target.scrollHeight - target.clientHeight;
      innerPinned.set(target, target.scrollTop >= innerMax - PIN_THRESHOLD);
    }, true); }
    // [CUSTOM- 自动追尾的观察器。写入者在消息任务里同步改 DOM，这里只收"变了哪一块"，
    // 真正的布局读取与 scrollTop 写入推迟到下一帧（NS.dom.schedule），与 follow() 同一套读写分离。
    if (window.MutationObserver) {
      var tailObserver = new window.MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var changed = records[i].target;
          if (changed && changed.nodeType === 3) { changed = changed.parentNode; }
          if (changed) { noteTailCandidate(changed); }
          noteAddedNodes(records[i].addedNodes);
        }
        reclaimActive();
        if (tailQueue.length === 0 || tailPending) { return; }
        tailPending = true;
        if (NS.dom && NS.dom.schedule) { NS.dom.schedule(flushTails); } else { flushTails(); }
      });
      tailObserver.observe(container, { childList: true, subtree: true, characterData: true });
    }
    // [CUSTOM- 「我拖了滚动条，但它没动」——2026-10-05 那次真机日志里，面板停在
    // st=43 而 max=19604，**没有任何一次程序写接近过 43**（80 次程序写全在贴底跟到底），
    // 所以问题不在"我们把他拽回去"，而在**手势没作用到 #messages 上**。
    // 这一条就为它而加：**文档级**记下每次按下落在哪一类控件上（粗粒度标签），节流后不会刷屏。
    // 有了它，"他拖的到底是哪个条"就不必再猜 —— 而#messages 与右侧大纲栏两个滚动条只隔一条边。
    // 桩 DOM 的 document 只有滚动那套测试需要的那几个方法（没有 addEventListener）⇒ 判空跳过。
    if (document.addEventListener) { document.addEventListener('pointerdown', function (event) {
      var label = pressLabel(event);
      // 只记**有意义**的那几类：点滚动条（拖了没动就是它）、点大纲栏（会触发 jumpTo）、
      // 以及落在面板外。点记录/点输入框（打字）太频繁，记了只会把这套诊断自己的配额吃光。
      if (label === 'messages-bar' || label === 'outline' || label === 'outside') {
        logScrollState('press@' + label, false);
      }
    }, true); }
    // [CUSTOM- 文档不渲染的时段既没有 scroll 事件、观测器也可能哑火（见 composer.ts
    // watchHeight 的 210 段），pin 与留白会烂在旧值上：2026-10-09 的日志里 view 面就抓到
    // pin=1 却停在 st=418/6781 卡了五分钟（192 那句"某个量在说谎"的现场）。重新可见 /
    // 尺寸变化时自己重算一遍 —— reflow() 在贴底时顺手把视口带回（含新长出来的留白），
    // 没贴底时只刷新 pin/Jump，绝不抢视口。
    if (document.addEventListener) {
      document.addEventListener('visibilitychange', function () {
        if (document.visibilityState && document.visibilityState !== 'visible') { return; }
        reflow();
      });
    }
    if (window.addEventListener) { window.addEventListener('resize', reflow); }
    jumpBtn.addEventListener('click', function () {
      pinned = true;
      hideJump();
      restoreTarget = null;
      // [CUSTOM- 这里原来是直写 scrollTop（绕过 writeTop）⇒ 它引发的 scroll 事件
      // 会被**误标**成 user-scroll（"用户自己滚的"）。读日志时那会把"我们把人送到人工位置"看成
      // 他的操作，这一格必须走同一个出口。
      writeTop(container.scrollHeight);
    });
    // [CUSTOM- 位置记忆跨面板开关存活（每个文档各存各的：
    // 侧边栏与编辑区的视口本来就不一样，共用一份反而会互相干扰）。
    if (NS.boot && NS.boot.recallUi) {
      var ui = NS.boot.recallUi();
      if (ui && ui.scroll) { offsets = ui.scroll; }
    }
  }

  function onScroll() {
    recompute();
    // 用户接管了视口：放弃待恢复的位置，不要跟他抢。
    if (restoreTarget !== null && container && Math.abs(container.scrollTop - expectedTop) > 2) {
      restoreTarget = null;
    }
  }

  /**
   * [CUSTOM- 「滚动条到底了、面板却不在底部」的**自检**。
   *
   * 用户报过两次（2026-10-03 的 176、2026-10-05 的这次），而 176 那条链在预览档里是健康的
   * （#elicbottomstuckprobe：atMax / pinned / distance 三者自洽），说明还有另一条路。既然它
   * **可复现但当时读不到数字**，就把数字打出来：宿主日志是落盘的（~/.claude/vac-client.log），
   * 下次它一出现，一行日志就能定案，不需要用户做任何事。
   *
   * 只在**状态翻转**时打（pinned 变一次算一次），不做逐帧上报 —— 173 立过规矩：诊断通道自己
   * 有配额，噪声先到会把有用的信号挤掉（pitfalls #42）。
   *
   * 判据里那四个量是"一张必须自洽的账"：
   * distance = scrollHeight − padBottom − scrollTop − clientHeight
   * pinned   = distance < 32
   * 所以 atMax（scrollTop 到顶）时 distance 必然是 −padBottom < 0 ⇒ 必然 pinned。**出现
   * "atMax 却不 pinned"，或者 "刚跟过底 distance 仍 ≥ 32"，就说明某个量在说谎** ——
   * scrollTop 被夹住了、padBottom 读不到、或者内容是在写入之后才长出来的。
   */
  /** 这份文档是哪个面（侧边栏还是编辑区）—— 两个面各有自己的 #messages。 */
  function surfaceId() {
    var cls = (document.body && document.body.className) || '';
    if (cls.indexOf('surface-editor') >= 0) { return 'editor'; }
    if (cls.indexOf('surface-view') >= 0) { return 'view'; }
    return cls || 'unknown';
  }

  /**
   * [CUSTOM- 一次按下落在哪一类控件上（粗粒度，够定位就行）。
   *
   * -bar 后缀 = 落在**滚动条那条带子上**（offsetX 超出该元素的 clientWidth；Chromium 上
   * 点滚动条的事件确实以元素本身为 target）。这一格就是"他拖的是不是这个条"的判据。
   */
  function pressLabel(event) {
    var target = event && event.target;
    if (!target || !target.closest || !container) { return 'other'; }
    if (target.closest('.outline-sidebar')) { return 'outline'; }
    if (target.closest('#composer')) { return 'composer'; }
    if (container.contains(target)) {
      // 「落在滚动条那条带子上」两种判据并用：offsetX > clientWidth 是 Chromium 上点自身滚动条
      // 的特征；再用 clientX 与容器的右边界比一次 —— 合成事件（预览探针）没有 offsetX，但能给
      // clientX，于是这一格**在探针里也验得了**（不能验的判据等于没写）。
      var byOffset = typeof target.offsetX === 'number' && target.clientWidth
        && target.offsetX > target.clientWidth;
      var byClient = false;
      if (!byOffset && typeof event.clientX === 'number' && target.getBoundingClientRect) {
        var rect = target.getBoundingClientRect();
        byClient = rect.width > 0 && event.clientX > rect.left + target.clientWidth;
      }
      return (byOffset || byClient) ? 'messages-bar' : 'messages';
    }
    return 'outside';
  }

  /** 读 body 上的 CSS 变量。桩 DOM 的 body 没有 style（滚动那套测试就是这么搭的），判空返回 '-'。 */
  function bodyVar(name) {
    var style = document.body && document.body.style;
    return (style && style.getPropertyValue) ? (style.getPropertyValue(name) || '-') : '-';
  }

  // [CUSTOM- 诊断自身的账：序号 + 节流 + 被压掉的条数。
  //
  // 三件事都不能省：①**序号**让"日志里少了一条"与"这件事没发生"区分开（174/#42 的教训）；
  // ②**节流**（同一个原因 500ms 一条）让流式期间的密集事件不会把日志桥的配额（10s/30 条，
  // 见 boot.ts 的 installLogBridge）烧光；③**sup=** 报出这期间压掉了多少条 —— 被节流掉的是
  // 噪声还是关键那一条，读日志的人必须能看出来。
  var diagSeq = 0;
  var diagSuppressed = 0;
  var diagLastAt = 0;
  var lastScrollHeight = -1;
  // [CUSTOM- 我们最后一次**程序**写下的 scrollTop（写完之后回读的夹紧值）。
  // 滚动事件分不清来源，用它来分（见 init 里的监听器）。
  var lastProgrammaticTop = -1;

  /** 所有程序写 scrollTop 的唯一入口：顺手记下"这是我们写的"，并回读真实落点（可能被夹住）。 */
  function writeTop(value) {
    if (!container) { return; }
    container.scrollTop = value;
    lastProgrammaticTop = container.scrollTop;
  }

  /**
   * [CUSTOM- 三个几何写入方（输入卡 / 表单抽屉 / 权限抽屉）的**变化点**。
   *
   * 它们改的都是 #messages 的 padding-bottom —— 本 bug 的第一嫌疑（176 就是这条链）。只在
   * **数值真的变了**时报（同一高度被反复写很常见，那不是事件），且强制打（不受 700ms 节流），
   * 因为每一个都是"可能把视口顶掉一次"的瞬间。
   */
  var geometryVars = {};
  function noteGeometry(what, value) {
    var text = typeof value === 'number' ? value + 'px' : String(value);
    if (geometryVars[what] === text) { return; }
    var from = geometryVars[what] === undefined ? '(init)' : geometryVars[what];
    geometryVars[what] = text;
    logScrollState('geom:' + what + ' ' + from + '->' + text, true);
  }
  // 自带一层**总量上限**：日志桥是 10s/30 条全客户端共享（boot.ts），这套诊断不能把它吃光，
  // 否则"日志里没有"又会被读成"没发生"（173/#42）。最多占 12 条/10s，其余计入 sup=。
  var DIAG_WINDOW_MS = 10000;
  var DIAG_MAX_PER_WINDOW = 12;
  var diagWindowStart = 0;
  var diagInWindow = 0;

  /**
   * [CUSTOM- 这一条**现在会被记下来吗**？（只看节流与配额：不改序号、不写日志。）
   *
   * 抽出来是给热路径用的：诊断里有些量要**读几何**，而"反正不会记"的那些调用不该付这个代价 ——
   * 'follow()' 在"用户没贴底"那一格里只为诊断读 'scrollHeight'，而它每条记录都被调一次
   * （大会话回放里一个批次 139 条 ⇒ 139 次强制重排）。注意它会顺手把窗口计数归零
   * （与 'logScrollState' 开头同一动作、同一语义）。
   */
  function diagAllows(force) {
    if (!container) { return false; }
    var now = Date.now();
    if (now - diagWindowStart >= DIAG_WINDOW_MS) { diagWindowStart = now; diagInWindow = 0; }
    return !(diagInWindow >= DIAG_MAX_PER_WINDOW || (!force && now - diagLastAt < 700));
  }

  function logScrollState(reason, force) {
    if (!container) { return; }
    if (!diagAllows(force)) {
      // 同一个原因连续来很多次（流式里每次 append 都会走一遍 follow）时只记一次，其余计数。
      diagSuppressed++;
      return;
    }
    diagSeq++;
    diagInWindow++;
    diagLastAt = Date.now();
    var pad = 0;
    if (window.getComputedStyle) { pad = parseFloat(window.getComputedStyle(container).paddingBottom) || 0; }
    var max = container.scrollHeight - container.clientHeight;
    var distance = container.scrollHeight - pad - container.scrollTop - container.clientHeight;
    var composer = NS.dom && NS.dom.qs ? NS.dom.qs('composer') : null;
    var last = container.lastElementChild;
    var lastRect = last && last.getBoundingClientRect ? last.getBoundingClientRect() : null;
    var composerRect = composer && composer.getBoundingClientRect ? composer.getBoundingClientRect() : null;
    // [CUSTOM- 这次报障的**直接观测量**：滚动条已在末尾、末条记录的底边却还在输入卡底下。
    // cov=1 就是用户看到的那个画面；gap 是被盖住的像素（负数 = 尾巴在卡片上方，健康）。
    // 有了它，下次不用再从 st/max/pad/last 里推——「日志里 cov 全是 0」即可排除这条链。
    var atMax = container.scrollTop >= max - PIN_THRESHOLD;
    var visible = !!(lastRect && composerRect && composerRect.height > 0);
    var covered = !!(atMax && visible && lastRect.bottom > composerRect.top + 1);
    var gap = visible ? Math.round(lastRect.bottom - composerRect.top) : 0;
    // 字段名压到最短：整行必须**远小于** 400 字符，否则会被日志桥从尾巴上截掉
    // （被截掉的恰好是 last/comp 这两个"谁盖住了谁"的关键量）。
    console.warn('[vac] scroll#' + diagSeq + ' ' + reason
      + ' st=' + Math.round(container.scrollTop) + '/' + Math.round(max)
      + ' atmax=' + (container.scrollTop >= max - 1 ? 1 : 0)
      + ' pad=' + Math.round(pad)
      + ' dist=' + Math.round(distance)
      + ' pin=' + (pinned ? 1 : 0)
      + ' jump=' + (jumpBtn ? (jumpBtn.hidden ? 0 : 1) : '?')
      + ' sh=' + Math.round(container.scrollHeight) + ' ch=' + Math.round(container.clientHeight)
      + ' cov=' + (covered ? 1 : 0) + ' gap=' + gap
      + ' cv=' + bodyVar('--vac-composer-h')
      + ' ev=' + bodyVar('--vac-elic-h')
      + ' pv=' + bodyVar('--vac-perm-h')
      + ' last=' + (lastRect ? Math.round(lastRect.bottom) : '-')
      + ' comp=' + (composerRect ? Math.round(composerRect.top) : '-')
      + ' kind=' + (last ? String(last.getAttribute('data-kind') || 'x') : '-')
      + ' sf=' + surfaceId()
      + (diagSuppressed > 0 ? ' sup=' + diagSuppressed : ''));
    diagSuppressed = 0;
  }

  /** 重算「是否贴底」与 Jump 按钮。scroll 事件之外的路径也要能调（见 reflow）。 */
  function recompute() {
    if (!container) { return; }
    // [CUSTOM- distance 用**内容末尾**算（减掉底部那段留白）：留白是给悬浮的输入卡
    // 让位的，它不是内容。这样"内容末尾进入视口"与"判定为到底"就是同一件事 —— 不会出现
    // "Jump 还说没到底、下面却已经是空白"的灰色地带（140~143 被反复报的就是那个区间：
    // 留白 108px 进了可视区，而 32px 的阈值说"还没到底"）。
    // 留白本身是一贯存在的（见 styles.ts 的 .messages），所以这里不需要任何切类/位置补偿。
    var pad = 0;
    if (window.getComputedStyle) {
      pad = parseFloat(window.getComputedStyle(container).paddingBottom) || 0;
    }
    var distance = container.scrollHeight - pad - container.scrollTop - container.clientHeight;
    var wasPinned = pinned;
    pinned = distance < PIN_THRESHOLD;
    // [CUSTOM- 贴底状态翻转 = 一次"视口归属"的交接，正是这个 bug 唯一会留下痕迹的地方。
    if (wasPinned !== pinned) { logScrollState(pinned ? 'pinned' : 'unpinned'); }
    if (pinned) { hideJump(); } else { showJump(); }
    healIfTailCovered(distance);
  }

  // [CUSTOM- 「到底了、尾巴却还压在输入卡后面」的**按结果自愈**（pitfalls #25/#26：
  // 判据用用户看得见的量，别信代理量）。
  //
  // 代理量是 --vac-composer-h：唯一写者是 composer.ts 的 ResizeObserver，而观测器在「文档没在
  // 渲染」的时段不可靠 —— 2026-10-09 的真机实验里，display:none 循环只收到过初始回调，hide 与
  // 恢复都不报（pitfalls #62）。变量停在 0 时留白只剩 24px：内容末尾停在离面板底 24px 处，
  // 被 ~80px 高的输入卡压住，而且**滚无可滚**（滚动条已触底）—— 用户 2026-10-09 截图报的就是它。
  //
  // 判据取"末条记录的底边 vs 输入卡的顶边"（同一坐标系的两个 rect）：这是"尾巴是否被压住"的
  // 直接观测量，与留白变量为什么失真无关 —— 失真的原因（观测器哑火 / 相位切换 / 隐藏时段）
  // 全部涵盖。两个前置（缺一不可，别放宽）：
  // · **真在滚动范围末尾**（st ≥ max−1）：只有这里才是"触底了却还看不全"的病态格。
  // ⚠️ 2026-10-09 用户报的"滚轮滚不上去、被自动拉回去"就是这条判据放宽到 distance<32 的
  // 后果 —— 从底部上滚一格时尾巴刚离开卡片上方，而 st 还在阈值内 ⇒ 误判成被压住 ⇒
  // 自愈 reflow 又把视口拉回底部，滚轮被吃光。at-max 门槛把修复面收窄到真正的病灶
  // （当初的截图正是 st=max 且被压住）。
  // · 贴底态（distance < PIN_THRESHOLD）：上翻看历史时内容从输入卡下面穿过是常态。
  var healing = false;
  // [CUSTOM- 自愈**为什么没出手**也要留痕：以前的判据不满足时直接 return，日志里只剩
  // "没有 tail-covered-heal"，读日志的人分不清"没发生"与"被某个门槛挡住"（pitfalls #42）。
  // 只在原因**变化**时记一行，滚动热路径上不多读一次几何。
  var lastHealSkip = null;
  function noteHealSkip(reason) {
    if (lastHealSkip === reason) { return; }
    lastHealSkip = reason;
    logScrollState('heal-skip:' + reason, true);
  }
  function healIfTailCovered(distance) {
    if (healing || distance >= PIN_THRESHOLD) { noteHealSkip('unpinned'); return; }
    if (!container || !container.lastElementChild) { noteHealSkip('no-tail'); return; }
    var max = container.scrollHeight - container.clientHeight;
    // [CUSTOM- at-max 门槛 1px → 32px（PIN_THRESHOLD）：滚轮滚到底时浏览器常落在
    // max−N 而非精确 max，1px 容差太紧、自愈根本不触发，尾巴就一直压着（用户 2026-10-10：
    // "滚动条到底了、Jump 能恢复、滚轮又坏"）。32px 覆盖"滚轮差一格"，仍挡住"往上翻一大段"——
    // #210 教训 2 的"滚轮被吃光"是 160px 宽窗（distance<32 覆盖 pad+32），32px 远窄于它。
    if (container.scrollTop < max - PIN_THRESHOLD) { noteHealSkip('not-atmax'); return; }
    if (!NS.dom || !NS.dom.qs || !NS.composer || !NS.composer.refreshHeight) { noteHealSkip('no-api'); return; }
    var composer = NS.dom.qs('composer');
    if (!composer || !composer.getBoundingClientRect) { noteHealSkip('no-composer'); return; }
    var last = container.lastElementChild;
    if (!last.getBoundingClientRect) { noteHealSkip('no-rect'); return; }
    var compRect = composer.getBoundingClientRect();
    // 卡片没显示（相位断开时 display:none ⇒ rect 全 0）：此刻没有可压的内容，不关它的事。
    if (compRect.height <= 0) { noteHealSkip('composer-hidden'); return; }
    // [CUSTOM- 变量已是正确值（composer 实高 ≈ --vac-composer-h）⇒ 尾巴被盖不是
    // 「变量失真」，而是视口本身太矮（composer 几乎占满整个视图区）。这时自愈重测毫无用处，只会
    // 反复触发：2026-10-10 日志里 104 次 tail-covered-heal 全在这类状态里打转，还伴随 composer
    // 高度 1px 的震荡。只有变量真的失真（实高比变量高出 ≥2px；2px 容差吸收亚像素取整）才值得
    // 重测 —— 那才是 210 要修的病灶格。
    var composerVar = parseFloat(bodyVar('--vac-composer-h')) || 0;
    if (Math.abs(compRect.height - composerVar) < 2) { noteHealSkip('var-ok'); return; }
    var lastRect = last.getBoundingClientRect();
    if (lastRect.bottom <= compRect.top + 1) { noteHealSkip('clear'); return; }
    // 被压住：先记一笔（记的是**修复前**的现场），再让唯一的写者重测+重写。
    // 重写会触发 reflowNow → reflow → recompute —— healing 闸门保证这条链只尝试一次，
    // 不会"判据不满足 → 修复 → 仍不满足 → 再修复"地打转。
    logScrollState('tail-covered-heal', true);
    healing = true;
    lastHealSkip = null;
    try { NS.composer.refreshHeight(); } finally { healing = false; }
  }

  /**
   * [CUSTOM- 几何变了之后的**再判定**。
   *
   * 为什么需要它：pinned 与 Jump 按钮原先只在 scroll 事件里更新，而**内容高度或底部留白**
   * （输入卡 / 表单抽屉 / 权限抽屉的高度都进 #messages 的 padding-bottom）变化时，浏览器
   * **不会**派发 scroll 事件 —— 于是视口停在旧判定上：
   * · 本来贴底的人，抽屉/输入卡长高后内容被挤到浮层后面，而他看到的 Jump 状态还是旧的，
   * 滚动条也已经在头（残留是"没到底"的错觉，实际滚不动）—— 用户 2026-10-03 报的就是这个；
   * · 反过来，内容被压缩到不再需要滚动时，Jump 还挂在屏幕上。
   * 所以三个写高度的模块（composer / elicitationView / permissionDrawer）改完变量就喊一声。
   *
   * 贴底时**顺手跟到底**（含刚长出来的那段留白）：这正是「贴着底部」该有的样子，
   * 也是用户明确要过的语义（"消息区的触底判断保持在输入框上面"）。上翻看历史的人不受影响 ——
   * keepBottom 取的是变化**之前**的 pinned。
   */
  function reflow() {
    if (!container) { return; }
    var keepBottom = pinned;
    recompute();
    if (keepBottom) {
      // [CUSTOM- 原来这里直写 scrollTop（绕过 writeTop）⇒ 它引发的 scroll 事件会被
      // **误标**成 user-scroll —— 读日志时会把"我们跟到底"看成"用户自己滚到底"（192 立的规矩：
      // 程序写必须走同一个出口）。这里只是换出口，行为不变。
      writeTop(container.scrollHeight);
      recompute();
      // [CUSTOM- 刚"跟到底"却又判成没到底 ⇒ 这次跟随**没到位**：要么 scrollTop
      // 被夹在一个更小的 max 上（内容还没落地就写），要么留白在写入之后又长了一截。
      // 这正是"滚动条到底了、面板却不在底部"最可能的机械成因，所以让它自己喊出来。
      if (!pinned) { logScrollState('follow-fell-short'); }
    }
  }

  function showJump() { if (jumpBtn) { jumpBtn.hidden = false; } }
  function hideJump() { if (jumpBtn) { jumpBtn.hidden = true; } }

  /** Scroll to the bottom, but only when the user has not scrolled away. */
  function follow() {
    if (!container || followPending) { return; }
    // [CUSTOM- Tail 关掉 ⇒ **绝不自动滚**（"别动我的视口"）。开着时仍要求贴底 ——
    // 用户一滚动 Tail 就被取消，所以"tail 开 + 不贴底"只会出现在程序把视口放到中间的那一瞬间。
    if (!pinned || !tail) {
      // [CUSTOM- 用户在往上翻：**不跟是对的**（不该抢他的视口）。但"面板没到底"
      // 的正当来源就是这里，而本 bug 的嫌疑正是"他其实在底部、我们却判成不在" —— 所以每次
      // append 记一笔（有节流 + 序号，流式期间不会刷屏）。内容是否同时长高也一并记下。
      // [CUSTOM- 但**只在它真会被记下来的时候读几何** —— 'scrollHeight' 是一次
      // 强制重排，而这条链是"每条记录一次"（见 diagAllows）。代价是 'grew' 与 'skip' 的基准
      // （lastScrollHeight）只跟着被记下来的那些调用走：两者都只是**日志里的一个词**，不影响
      // 任何行为，判据宁可粗一点也不该在热路径上读几何。
      if (!diagAllows(false)) { return; }
      var height = container.scrollHeight;
      var grew = lastScrollHeight >= 0 && height > lastScrollHeight + 40;
      lastScrollHeight = height;
      logScrollState(grew ? 'grew-unpinned' : 'skip-unpinned');
      return;
    }
    followPending = true;
    NS.dom.schedule(function () {
      followPending = false;
      if (!container) { return; }
      if (!pinned || !tail) { logScrollState('unpinned-before-frame'); return; }
      var height = container.scrollHeight;
      lastScrollHeight = height;
      var max = height - container.clientHeight;
      writeTop(height);
      // 写完立刻读回：被夹住（内容还没落地 / max 变了）会在这里显形 —— 这正是"滚动条到底了、
      // 面板却不在底部"最可能的机械成因。读的是刚写过的那个值，不额外触发重排。
      if (container.scrollTop < max - 1) { logScrollState('clamped-short', true); }
    });
  }

  /** Unconditional jump — used when switching sessions or after a replay. */
  function toBottom() {
    if (!container) { return; }
    pinned = true;
    hideJump();
    restoreTarget = null;
    writeTop(container.scrollHeight);
    logScrollState('toBottom', true);
  }

  /**
   * [CUSTOM- Jump to a specific node (conversation outline).
   *
   * pinned = false is set *before* writing scrollTop: the scroll event that
   * follows recomputes it from the real distance to the bottom, so a jump near
   * the end re-pins correctly. Without this, an append landing between the
   * click and the scroll event would yank the viewport back down — the exact
   * "I jumped up and it dragged me back" complaint the outline exists to fix.
   *
   * [CUSTOM- 'clearance' lands the node that many pixels BELOW the scrollport
   * top instead of exactly on it. The pinned-question bar takes a message over as soon as its
   * top reaches that edge, so landing exactly on it would hand the message straight back to
   * the bar and the click would look like it did nothing — the caller passes the bar's own
   * inset. Default 0 keeps every existing caller exact.
   */
  function jumpTo(node, clearance) {
    if (!container || !node) { return; }
    var top = node.offsetTop - container.offsetTop - (clearance || 0);
    if (top < 0) { top = 0; }
    // [CUSTOM- 跳到某条记录 = 用户主动离开底部 ⇒ 取消 Tail（和"滚动改了阅读进度"同一语义）。
    cancelTail('scroll');
    pinned = false;
    showJump();
    writeTop(top);
    onScroll();
    logScrollState('jumpTo', true);
  }

  /** True while the view sticks to the bottom (diagnostics/tests). */
  function isPinned() { return pinned; }

  /**
   * [CUSTOM- Tail 的运行时开关（2026-10-28）。'immediate' 才是"用户点了按钮 ⇒ 立刻到底"；
   * 换会话时由 tail.setFocus 用 false 调进来，位置交给 restore（它可能记着用户读到的中间位置）。
   */
  function setTail(on, immediate) {
    tail = on === true;
    if (!tail || !container) { return; }
    restoreTarget = null;
    if (immediate === true) { writeTop(container.scrollHeight); }
  }

  function isTail() { return tail; }

  /** 关掉 Tail 并通知状态机（'scroll' = 用户自己改了阅读进度；'restore' = 恢复到了中间位置）。 */
  function cancelTail(kind) {
    if (!tail) { return; }
    tail = false;
    if (!NS.tail) { return; }
    if (kind === 'restore') {
      if (NS.tail.cancelFromRestore) { NS.tail.cancelFromRestore(); }
    } else if (NS.tail.cancelFromScroll) {
      NS.tail.cancelFromScroll();
    }
  }



  // [CUSTOM- 位置记忆：连「是否贴底」一起记。
  // 只记 top 的话，一个本来贴底的会话切回来会停在半空；只记 pinned 又会丢掉阅读位置。
  function remember(sessionId) {
    if (!container || !sessionId) { return; }
    offsets[sessionId] = { top: container.scrollTop, pinned: pinned };
    persistSoon();
  }

  function restore(sessionId) {
    if (!container) { return; }
    // 切会话 = 换了一批卡片：上一张卡片的焦点环不能跟过来。
    setActive(null);
    var saved = sessionId ? offsets[sessionId] : undefined;
    if (saved === undefined) {
      toBottom();
      return;
    }
    if (saved.pinned) {
      toBottom();
      return;
    }
    // [CUSTOM- 恢复到一个用户自己选的中间位置 ⇒ Tail 必须关掉（它不该把人拽回底部）。
    // 只改这个会话那一条记录，不动默认值 —— 这不是"用户拨了开关"。
    cancelTail('restore');
    pinned = false;
    showJump();
    restoreTarget = saved.top;
    writeTop(saved.top);
    expectedTop = container.scrollTop;
    logScrollState('restore:' + saved.top, true);
  }

  /**
   * Re-apply the restored position after content height changed (markdown
   * arriving for a hydrated session grows the transcript and would otherwise
   * leave the viewport somewhere else). No-op once the user has scrolled.
   */
  function reassert() {
    if (!container || restoreTarget === null) { return; }
    writeTop(restoreTarget);
    expectedTop = container.scrollTop;
  }

  function forget(sessionId) {
    if (!sessionId) { return; }
    delete offsets[sessionId];
    persistSoon();
  }

  // 位置记忆落盘（webview 本地 state，跨面板关闭/重开存活）。防抖：切会话时
  // remember 会被连着调用几次，没必要每次都写。
  var persistTimer = null;
  function persistSoon() {
    if (persistTimer) { return; }
    persistTimer = window.setTimeout(function () {
      persistTimer = null;
      if (NS.boot && NS.boot.persistUi) { NS.boot.persistUi({ scroll: offsets }); }
    }, 300);
  }

  NS.scroll = {
    init: init,
    follow: follow,
    toBottom: toBottom,
    jumpTo: jumpTo,
    isPinned: isPinned,
    // [CUSTOM- 几何写入方（输入卡 / 表单抽屉 / 权限抽屉）改完高度后喊一声。
    // 这三个变量都进 #messages 的 padding-bottom，是这个 bug 的第一嫌疑：它们变了而视口判定
    // 没跟着重算，就会表现成"到底了却看不全"（176 修过一次）。同一条诊断、同一个节流。
    noteGeometry: noteGeometry,
    // [CUSTOM- 几何（内容高度 / 底部留白）变化后由写入方调用，见 reflow。
    reflowNow: reflow,
    remember: remember,
    restore: restore,
    reassert: reassert,
    forget: forget,
    // [CUSTOM- Tail（地址栏按钮）：状态在 client/tail.ts，这里只执行。
    setTail: setTail,
    isTail: isTail
  };
})(window.__vac = window.__vac || {});
`;
