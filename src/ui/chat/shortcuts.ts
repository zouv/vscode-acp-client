// 面板快捷键的纯逻辑：规范串、默认值、脏值消解与重复冲突判定。

export const SHORTCUT_ACTIONS = [
  'scrollTop', 'scrollBottom', 'focusInput', 'previousSession', 'nextSession', 'closeSession', 'restoreClosed',
] as const;

export type ShortcutAction = typeof SHORTCUT_ACTIONS[number];

/** action → canonical accelerator，或 null 表示用户禁用了它。 */
export type ShortcutMap = Record<ShortcutAction, string | null>;

export const DEFAULT_SHORTCUTS: Readonly<Record<ShortcutAction, string>> = Object.freeze({
  scrollTop: 'Alt+KeyA',
  scrollBottom: 'Alt+KeyE',
  focusInput: 'Alt+KeyI',
  previousSession: 'Alt+KeyP',
  nextSession: 'Alt+KeyN',
  closeSession: 'Alt+KeyW',
  restoreClosed: 'Alt+KeyT',
});

export const SHORTCUT_ACTION_LABELS: Readonly<Record<ShortcutAction, string>> = Object.freeze({
  scrollTop: 'Scroll to top',
  scrollBottom: 'Scroll to bottom',
  focusInput: 'Focus the input',
  previousSession: 'Previous session',
  nextSession: 'Next session',
  closeSession: 'Close session',
  restoreClosed: 'Reopen closed session',
});

export function defaultShortcutMap(): ShortcutMap {
  return { ...DEFAULT_SHORTCUTS };
}

export function isShortcutAction(value: unknown): value is ShortcutAction {
  return typeof value === 'string' && (SHORTCUT_ACTIONS as readonly string[]).includes(value);
}

const MODIFIER_ORDER = ['Ctrl', 'Alt', 'Shift', 'Meta'] as const;
type Modifier = typeof MODIFIER_ORDER[number];

const MODIFIER_BY_TOKEN: Readonly<Record<string, Modifier>> = Object.freeze({
  ctrl: 'Ctrl', control: 'Ctrl',
  alt: 'Alt', option: 'Alt',
  shift: 'Shift',
  meta: 'Meta', cmd: 'Meta', command: 'Meta', win: 'Meta', super: 'Meta',
});

const CODE_BY_TOKEN: Readonly<Record<string, string>> = (() => {
  const codes: Record<string, string> = {};
  for (let index = 0; index < 26; index++) {
    const letter = String.fromCharCode(65 + index);
    codes['key' + letter.toLowerCase()] = 'Key' + letter;
  }
  for (let digit = 0; digit <= 9; digit++) {
    codes['digit' + digit] = 'Digit' + digit;
  }
  for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown']) {
    codes[code.toLowerCase()] = code;
  }
  return Object.freeze(codes);
})();

export type ShortcutParse =
  | { ok: true; value: string | null }
  | { ok: false };

/**
 * 解析一个 accelerator。`null` 是合法的「禁用」，非法串返回 `{ ok: false }`。
 * 输出顺序固定为 Ctrl+Alt+Shift+Meta+code，最终键只接受 KeyboardEvent.code 白名单。
 * 必须包含 Ctrl/Alt/Meta 之一：仅 Shift 的绑定会吞掉正常的大写文本输入。
 */
export function canonicalizeShortcut(raw: unknown): ShortcutParse {
  if (raw === null) { return { ok: true, value: null }; }
  if (typeof raw !== 'string') { return { ok: false }; }
  const parts = raw.split('+').map(part => part.trim());
  if (parts.length < 2 || parts.some(part => part.length === 0)) { return { ok: false }; }
  const code = CODE_BY_TOKEN[parts[parts.length - 1].toLowerCase()];
  if (!code) { return { ok: false }; }
  const modifiers = new Set<Modifier>();
  for (const token of parts.slice(0, -1)) {
    const modifier = MODIFIER_BY_TOKEN[token.toLowerCase()];
    if (!modifier || modifiers.has(modifier)) { return { ok: false }; }
    modifiers.add(modifier);
  }
  if (!modifiers.has('Ctrl') && !modifiers.has('Alt') && !modifiers.has('Meta')) {
    return { ok: false };
  }
  const ordered = MODIFIER_ORDER.filter(modifier => modifiers.has(modifier));
  return { ok: true, value: [...ordered, code].join('+') };
}

/**
 * 把旧记录/脏值收敛成一份完整且无重复的映射：
 * · 缺字段 → 默认；
 * · 非法值 → 默认；
 * · null → 保留（禁用）；
 * · 重复 → 先出现的显式绑定获胜，后出现者退回自己的默认，默认也被占用则禁用。
 */
export function normalizeShortcutMap(raw: unknown): ShortcutMap {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  const resolved = {} as ShortcutMap;
  const used = new Set<string>();
  const fallback: ShortcutAction[] = [];
  for (const action of SHORTCUT_ACTIONS) {
    if (!Object.prototype.hasOwnProperty.call(source, action)) {
      fallback.push(action);
      continue;
    }
    const parsed = canonicalizeShortcut(source[action]);
    if (!parsed.ok) {
      fallback.push(action);
      continue;
    }
    if (parsed.value === null) {
      resolved[action] = null;
      continue;
    }
    if (used.has(parsed.value)) {
      fallback.push(action);
      continue;
    }
    used.add(parsed.value);
    resolved[action] = parsed.value;
  }
  for (const action of fallback) {
    const fallbackValue = DEFAULT_SHORTCUTS[action];
    if (used.has(fallbackValue)) {
      resolved[action] = null;
    } else {
      resolved[action] = fallbackValue;
      used.add(fallbackValue);
    }
  }
  return resolved;
}

export type ShortcutSettingResult =
  | { ok: true; shortcuts: ShortcutMap }
  | { ok: false; reason: 'invalid' }
  | { ok: false; reason: 'duplicate'; conflictAction: ShortcutAction; binding: string };

/** 设置面板的一次写入：`'default'` 重置为默认，`null` 禁用，其余按 accelerator 校验。 */
export function applyShortcutSetting(
  current: unknown,
  action: ShortcutAction,
  raw: unknown,
): ShortcutSettingResult {
  const shortcuts = normalizeShortcutMap(current);
  let binding: string | null;
  if (raw === 'default') {
    binding = DEFAULT_SHORTCUTS[action];
  } else {
    const parsed = canonicalizeShortcut(raw);
    if (!parsed.ok) { return { ok: false, reason: 'invalid' }; }
    binding = parsed.value;
  }
  if (binding !== null) {
    const conflictAction = SHORTCUT_ACTIONS.find(
      other => other !== action && shortcuts[other] === binding,
    );
    if (conflictAction) {
      return { ok: false, reason: 'duplicate', conflictAction, binding };
    }
  }
  return { ok: true, shortcuts: { ...shortcuts, [action]: binding } };
}
