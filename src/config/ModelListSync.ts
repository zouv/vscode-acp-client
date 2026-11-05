// [CUSTOM- 自定义模型列表写入的串行队列（纯逻辑，禁 import vscode）。
//
// 设置面板的拖拽/上移下移会把连续多次排序写成多条 `setModelList`。宿主必须按到达
// 顺序逐条处理：后一条的 baseline 是前一条成功后的生效层，否则两条并发写会互相把
// 对方的 compare-and-set 基线判成冲突。写失败不得卡住队列，后续提交仍要执行（各自
// 收到自己的成功/失败回执）。
import { customModelSignature } from './CustomModelList';

export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task);
    this.tail = run.then(() => undefined, () => undefined);
    return run;
  }
}

/**
 * [CUSTOM- 模型列表的 compare-and-set 基线：生效层 + 写目标 + 值签名。
 * 只比值不够 —— 同值但新增/删除了 workspace override 也是作用域变化；沿用旧基线写入
 * 会把值静默写到与用户看到的不一致的层。
 */
export function modelListBaseline(
  effective: string,
  writeTarget: string,
  rawValue: unknown,
): string {
  return `${effective}|${writeTarget}|${customModelSignature(rawValue)}`;
}

/**
 * [CUSTOM- 写入前的 CAS 判定。`force`（用户点 Overwrite）**不参与**这里：
 * 用户确认的是"覆盖冲突时看到的那个版本"，确认之后其他面又写入时仍必须重新报冲突，
 * 不能用一次确认静默覆盖更新的数据。
 */
export function modelListBaselineMatches(
  baseline: string,
  effective: string,
  writeTarget: string,
  rawValue: unknown,
): boolean {
  return baseline === modelListBaseline(effective, writeTarget, rawValue);
}
