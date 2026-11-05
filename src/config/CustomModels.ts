// 自定义模型（vac.customModels）：类型、归一化与读取。
// 从 ChatPanelHost 迁来（原  的 normalizeCustomModels）：SessionManager（core）
// 也要读同一份配置，在会话创建时经 ACP `_meta.extraModels` 注入 agent，让 agent 把自定义模型
// 列入其 `model` 配置项（配套桥接层的做法）。
// name/description 供客户端显示名映射用（composer.optionLabel），不在 _meta.extraModels 里。
import { resolveSetting } from './SettingScope';
import type { SettingSource } from './GlobalSettings';
import { normalizeCustomModels } from './CustomModelList';
import type { CustomModel } from './CustomModelList';

export { customModelSignature, normalizeCustomModels } from './CustomModelList';
export type { CustomModel } from './CustomModelList';

export interface CustomModelsResolution {
  models: CustomModel[];
  source: SettingSource;
}

/** Read the effective custom models (workspace > user > global > built-in default). */
export function readCustomModels(): CustomModel[] {
  return resolveCustomModels().models;
}

/** Same read, plus the layer information the settings panel renders. */
export function resolveCustomModels(): CustomModelsResolution {
  const source = resolveSetting('vac.customModels', 'global');
  const entry = source.layers.find(layer => layer.layer === source.effective);
  return { models: normalizeCustomModels(entry?.value), source };
}
