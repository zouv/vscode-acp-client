// [CUSTOM- 自定义模型的纯数据层：类型、归一化与签名。
// 单独成文件是为了让 vitest（禁 import vscode）能测试；`CustomModels.ts` 负责读设置层，
// 再从这里 re-export，调用方仍从 CustomModels 取。
/** A user-defined model alias from `vac.customModels` (settings.json). */
export interface CustomModel {
  /** The model id injected into the agent via `_meta.extraModels` and sent on selection. */
  modelId: string;
  /** Display name; falls back to `modelId` when absent. */
  name?: string;
  /** Optional hover text (currently unused). */
  description?: string;
}

/**
 * Normalise the raw `vac.customModels` value: drop entries without a `modelId`,
 * trim id/name/description, fall `name` back to `modelId`, drop blank descriptions.
 * Trimming matches the settings editor's long-standing behaviour; it also keeps the
 * host's compare-and-set signature and the client's DOM snapshot identical.
 */
export function normalizeCustomModels(raw: unknown): CustomModel[] {
  const out: CustomModel[] = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    if (!item || typeof item !== 'object') { continue; }
    const entry = item as { modelId?: unknown; name?: unknown; description?: unknown };
    const modelId = typeof entry.modelId === 'string' ? entry.modelId.trim() : '';
    if (!modelId) { continue; }
    const name = typeof entry.name === 'string' ? entry.name.trim() : '';
    const description = typeof entry.description === 'string' ? entry.description.trim() : '';
    out.push({
      modelId,
      name: name || modelId,
      description: description || undefined,
    });
  }
  return out;
}

/**
 * [CUSTOM- 一份稳定、可比较的模型列表签名（顺序、重复 id、空行都按归一化后算）。
 * 设置面板的 compare-and-set 用它判断"打开编辑器时的基线"是否仍等于当前生效层。
 */
export function customModelSignature(raw: unknown): string {
  return JSON.stringify(normalizeCustomModels(raw));
}
