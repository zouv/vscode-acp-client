// [CUSTOM- 模型选择器顺序（设置面板的拖拽排序 → 输入卡菜单）。
//
// 设置面板只重排 `vac.customModels`；agent 的内置模型顺序、分组结构都不归它管。
// 因此这里只做「稳定的局部重排」：
// · 只作用于 `category === 'model'` 的 select 选项；
// · agent 内置模型（不在设置列表里）保持 agent 原顺序、排在前面；
// · 自定义模型按设置列表顺序排在它们后面（适配器也是把 extraModels 追加在内置模型之后）；
// · 分组条目（`entry.options`）不被摊平或跨组搬动，只在组内重排 —— 分组语义不破；
// · 设置里有、agent 当前候选里没有的 id 直接忽略（不凭空造菜单项）。
export const modelOrderClient = `
(function (NS) {
  'use strict';

  /** modelId → 首次出现的序号（重复 id 以第一次为准）。 */
  function rankMap(customModels) {
    // 无原型对象：modelId 是用户可控字符串（__proto__ / constructor 等），
    // 普通对象会让特殊键走原型访问而不是自有属性，导致排序失效或被原型污染。
    var ranks = Object.create(null);
    var list = Object.prototype.toString.call(customModels) === '[object Array]' ? customModels : [];
    for (var i = 0; i < list.length; i++) {
      var entry = list[i];
      if (!entry || typeof entry.modelId !== 'string') { continue; }
      var id = entry.modelId.trim();
      if (!id || Object.prototype.hasOwnProperty.call(ranks, id)) { continue; }
      ranks[id] = i;
    }
    return ranks;
  }

  function hasRanks(ranks) {
    for (var key in ranks) {
      if (Object.prototype.hasOwnProperty.call(ranks, key)) { return true; }
    }
    return false;
  }

  /** 未配置的（agent 内置）返回 -1：它们保持原顺序并排在有 rank 的自定义模型前面。 */
  function rankOf(ranks, value) {
    var key = String(value);
    return Object.prototype.hasOwnProperty.call(ranks, key) ? ranks[key] : -1;
  }

  function isGroup(entry) {
    return !!entry && Object.prototype.toString.call(entry.options) === '[object Array]';
  }

  /** 稳定排序：内置模型保持原相对顺序在前，自定义模型按 rank 排在后面。 */
  function sortEntries(entries, ranks) {
    var indexed = [];
    for (var i = 0; i < entries.length; i++) { indexed.push({ entry: entries[i], index: i }); }
    indexed.sort(function (a, b) {
      var ra = isGroup(a.entry) ? Number.MAX_SAFE_INTEGER : rankOf(ranks, a.entry && a.entry.value);
      var rb = isGroup(b.entry) ? Number.MAX_SAFE_INTEGER : rankOf(ranks, b.entry && b.entry.value);
      if (ra !== rb) { return ra - rb; }
      return a.index - b.index;
    });
    var out = [];
    for (var j = 0; j < indexed.length; j++) { out.push(indexed[j].entry); }
    return out;
  }

  /** 顶层平铺项按 rank 重排，分组条目留在原来的槽位。 */
  function reorderFlatSlots(entries, ranks) {
    var flat = [];
    for (var i = 0; i < entries.length; i++) {
      if (!isGroup(entries[i])) { flat.push(entries[i]); }
    }
    var ordered = sortEntries(flat, ranks);
    var out = [];
    var next = 0;
    for (var j = 0; j < entries.length; j++) {
      out.push(isGroup(entries[j]) ? entries[j] : ordered[next++]);
    }
    return out;
  }

  function orderEntries(entries, ranks) {
    if (!hasRanks(ranks)) { return entries; }
    var anyGroup = false;
    for (var i = 0; i < entries.length; i++) {
      if (isGroup(entries[i])) { anyGroup = true; break; }
    }
    if (!anyGroup) { return sortEntries(entries, ranks); }
    var out = [];
    for (var j = 0; j < entries.length; j++) {
      var entry = entries[j];
      if (isGroup(entry)) {
        var copy = {};
        for (var key in entry) {
          if (Object.prototype.hasOwnProperty.call(entry, key)) { copy[key] = entry[key]; }
        }
        copy.options = sortEntries(entry.options, ranks);
        out.push(copy);
      } else {
        out.push(entry);
      }
    }
    return reorderFlatSlots(out, ranks);
  }

  /**
   * 返回一个重排后的 select 选项（浅拷贝；输入对象不变）。
   * 非 model 选项、没有候选、或没有自定义顺序时原样返回。
   */
  function orderOption(option, customModels) {
    if (!option || option.category !== 'model') { return option; }
    if (Object.prototype.toString.call(option.options) !== '[object Array]') { return option; }
    var ranks = rankMap(customModels);
    if (!hasRanks(ranks)) { return option; }
    var copy = {};
    for (var key in option) {
      if (Object.prototype.hasOwnProperty.call(option, key)) { copy[key] = option[key]; }
    }
    copy.options = orderEntries(option.options, ranks);
    return copy;
  }

  NS.modelOrder = {
    rankMap: rankMap,
    orderEntries: orderEntries,
    orderOption: orderOption
  };
})(window.__vac = window.__vac || {});
`;
