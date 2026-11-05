import { describe, expect, it } from 'vitest';

import { customModelSignature, normalizeCustomModels } from './CustomModelList';
import { modelListBaseline, modelListBaselineMatches, SerialTaskQueue } from './ModelListSync';

describe('custom model compare-and-set signatures', () => {
  it('baseline includes the effective layer and write target, not just the value', () => {
    const value = [{ modelId: 'a' }];
    expect(modelListBaseline('global', 'global', value))
      .toBe(modelListBaseline('global', 'global', [{ modelId: 'a', name: 'a' }]));
    expect(modelListBaseline('global', 'global', value))
      .not.toBe(modelListBaseline('workspace', 'workspace', value));
    expect(modelListBaseline('workspace', 'workspace', value))
      .not.toBe(modelListBaseline('user', 'user', value));
    expect(modelListBaseline('global', 'user', value))
      .not.toBe(modelListBaseline('global', 'global', value));
  });

  it('an overwrite confirmation cannot bypass a newer CAS baseline', async () => {
    const queue = new SerialTaskQueue();
    let store = {
      effective: 'global',
      writeTarget: 'global',
      value: [{ modelId: 'a' }] as Array<{ modelId: string }>,
    };
    // 冲突时客户端拿到的基线。
    let baseline = modelListBaseline(store.effective, store.writeTarget, store.value);
    const decisions: string[] = [];

    // 用户点 Overwrite 之前/之后、请求真正执行之前，另一个面又写了一次。
    await queue.enqueue(async () => {
      store = { ...store, value: [{ modelId: 'external' }] };
    }).then(async () => {
      await queue.enqueue(async () => {
        if (!modelListBaselineMatches(baseline, store.effective, store.writeTarget, store.value)) {
          decisions.push('conflict-again');
          return;
        }
        decisions.push('write');
      });
    });

    expect(decisions).toEqual(['conflict-again']);
    expect(store.value).toEqual([{ modelId: 'external' }]);

    // 用重报回来的新基线再次确认，才允许覆盖。
    baseline = modelListBaseline(store.effective, store.writeTarget, store.value);
    await queue.enqueue(async () => {
      if (!modelListBaselineMatches(baseline, store.effective, store.writeTarget, store.value)) {
        decisions.push('conflict-again');
        return;
      }
      store = { ...store, value: [{ modelId: 'a' }] };
      decisions.push('write');
    });
    expect(decisions).toEqual(['conflict-again', 'write']);
    expect(store.value).toEqual([{ modelId: 'a' }]);
  });

  it('normalises empty rows away and keeps order + duplicate ids significant', () => {
    expect(customModelSignature([
      { modelId: 'b', name: 'B' },
      { modelId: '  ' },
      { modelId: 'a' },
      { modelId: 'b', description: 'dup' },
    ])).toBe(customModelSignature([
      { modelId: 'b', name: 'B' },
      { modelId: 'a', name: 'a' },
      { modelId: 'b', name: 'b', description: 'dup' },
    ]));
  });

  it('detects reordering and duplicate order changes', () => {
    const first = customModelSignature([{ modelId: 'a' }, { modelId: 'b' }]);
    const reordered = customModelSignature([{ modelId: 'b' }, { modelId: 'a' }]);
    const duplicated = customModelSignature([{ modelId: 'a' }, { modelId: 'a' }]);
    expect(first).not.toBe(reordered);
    expect(customModelSignature([{ modelId: 'a' }, { modelId: 'a' }])).toBe(duplicated);
  });

  it('trims surrounding whitespace intentionally, matching the settings editor', () => {
    expect(normalizeCustomModels([
      { modelId: '  m1  ', name: '  Model A  ', description: '  hover  ' },
    ])).toEqual([{ modelId: 'm1', name: 'Model A', description: 'hover' }]);
    expect(normalizeCustomModels([{ modelId: 'm2', name: '  ', description: '   ' }]))
      .toEqual([{ modelId: 'm2', name: 'm2', description: undefined }]);
  });

  it('falls blank aliases back to the model id so both sides agree', () => {
    expect(normalizeCustomModels([{ modelId: 'm', name: '   ' }])[0].name).toBe('m');
    expect(customModelSignature([{ modelId: 'm', name: '' }]))
      .toBe(customModelSignature([{ modelId: 'm', name: 'm' }]));
  });
});

describe('SerialTaskQueue', () => {
  it('starts the next task only after the previous one settles', async () => {
    const queue = new SerialTaskQueue();
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });

    const first = queue.enqueue(async () => {
      order.push('first:start');
      await gate;
      order.push('first:end');
    });
    const second = queue.enqueue(async () => { order.push('second'); });

    await Promise.resolve();
    expect(order).toEqual(['first:start']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });

  it('a failed write does not block later commits', async () => {
    const queue = new SerialTaskQueue();
    const order: string[] = [];
    const failed = queue.enqueue(async () => {
      order.push('failed');
      throw new Error('write failed');
    });
    const next = queue.enqueue(async () => { order.push('next'); });

    await expect(failed).rejects.toThrow('write failed');
    await next;
    expect(order).toEqual(['failed', 'next']);
  });

  it('preserves submission order for several back-to-back commits', async () => {
    const queue = new SerialTaskQueue();
    const seen: number[] = [];
    await Promise.all([1, 2, 3, 4].map(n => queue.enqueue(async () => {
      await new Promise(resolve => setTimeout(resolve, 5 - n));
      seen.push(n);
    })));
    expect(seen).toEqual([1, 2, 3, 4]);
  });
});
