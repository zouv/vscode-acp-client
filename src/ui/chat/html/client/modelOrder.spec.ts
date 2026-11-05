import { describe, expect, it } from 'vitest';

import { modelOrderClient } from './modelOrder';

function load(): any {
  const win: any = { __vac: {} };
  new Function('window', modelOrderClient)(win);
  return win.__vac.modelOrder;
}

function option(options: any[]): any {
  return { id: 'model', category: 'model', currentValue: 'a', options };
}

describe('composer model order', () => {
  it('puts custom models first in settings order and keeps built-ins stable', () => {
    const order = load();
    const input = option([
      { value: 'builtin-1', name: 'Builtin 1' },
      { value: 'custom-b', name: 'Custom B' },
      { value: 'builtin-2', name: 'Builtin 2' },
      { value: 'custom-a', name: 'Custom A' },
    ]);
    const out = order.orderOption(input, [{ modelId: 'custom-a' }, { modelId: 'custom-b' }]);
    expect(out.options.map((entry: any) => entry.value))
      .toEqual(['custom-a', 'custom-b', 'builtin-1', 'builtin-2']);
    // Input is not mutated.
    expect(input.options.map((entry: any) => entry.value))
      .toEqual(['builtin-1', 'custom-b', 'builtin-2', 'custom-a']);
  });

  it('ignores custom ids the agent does not currently offer', () => {
    const order = load();
    const out = order.orderOption(option([
      { value: 'x', name: 'X' },
      { value: 'y', name: 'Y' },
    ]), [{ modelId: 'missing' }, { modelId: 'y' }]);
    expect(out.options.map((entry: any) => entry.value)).toEqual(['y', 'x']);
  });

  it('only reorders within groups and keeps group order/semantics', () => {
    const order = load();
    const out = order.orderOption(option([
      { name: 'Built-in', options: [{ value: 'b1' }, { value: 'custom-b' }, { value: 'b2' }] },
      { name: 'Custom', options: [{ value: 'custom-d' }, { value: 'custom-c' }] },
    ]), [{ modelId: 'custom-c' }, { modelId: 'custom-b' }, { modelId: 'custom-d' }]);
    expect(out.options.map((entry: any) => entry.name)).toEqual(['Built-in', 'Custom']);
    expect(out.options[0].options.map((entry: any) => entry.value))
      .toEqual(['custom-b', 'b1', 'b2']);
    expect(out.options[1].options.map((entry: any) => entry.value))
      .toEqual(['custom-c', 'custom-d']);
  });

  it('keeps duplicate option ids stable and honours the first custom rank', () => {
    const order = load();
    const out = order.orderOption(option([
      { value: 'dup', name: 'first' },
      { value: 'other' },
      { value: 'dup', name: 'second' },
    ]), [{ modelId: 'other' }, { modelId: 'dup' }, { modelId: 'dup' }]);
    expect(out.options.map((entry: any) => entry.value)).toEqual(['other', 'dup', 'dup']);
    expect(out.options.map((entry: any) => entry.name)).toEqual([undefined, 'first', 'second']);
    // Both duplicates rank equally (rank map keeps the first rank) but remain in original order.
    expect(out.options[1].name).toBe('first');
    expect(out.options[2].name).toBe('second');
  });

  it('ranks user-controlled prototype keys such as __proto__ and constructor', () => {
    const order = load();
    const input = option([
      { value: 'normal', name: 'Normal' },
      { value: '__proto__', name: 'Proto' },
      { value: 'constructor', name: 'Constructor' },
    ]);
    const out = order.orderOption(input, [
      { modelId: 'constructor' },
      { modelId: '__proto__' },
    ]);
    expect(out.options.map((entry: any) => entry.value))
      .toEqual(['constructor', '__proto__', 'normal']);
    // The rank map is prototype-free.
    const ranks = order.rankMap([{ modelId: '__proto__' }]);
    expect(Object.getPrototypeOf(ranks)).toBeNull();
    expect(ranks.__proto__).toBe(0);
  });

  it('does not guess the model option by id: category-less or mode options stay unchanged', () => {
    const order = load();
    // 实际 ACP 形态是 category === 'model'；category 缺失时不猜 id，避免误伤别的 select。
    const noCategory = { id: 'model', options: [{ value: 'a' }, { value: 'b' }] };
    expect(order.orderOption(noCategory, [{ modelId: 'b' }])).toBe(noCategory);
    // 即使 id 恰好叫 model，mode 也绝不能被重排。
    const mode = { id: 'model', category: 'mode', options: [{ value: 'a' }, { value: 'b' }] };
    expect(order.orderOption(mode, [{ modelId: 'b' }])).toBe(mode);
  });

  it('returns the original option when there is no custom order or another category', () => {
    const order = load();
    const input = option([{ value: 'a' }]);
    expect(order.orderOption(input, [])).toBe(input);
    const mode = { category: 'mode', options: [{ value: 'a' }] };
    expect(order.orderOption(mode, [{ modelId: 'a' }])).toBe(mode);
  });
});
