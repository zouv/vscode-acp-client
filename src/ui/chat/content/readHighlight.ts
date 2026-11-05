export const MAX_READ_HIGHLIGHT_LENGTH = 100_000;
const READ_LINE = /^([ \t]*\d+\t)([\s\S]*)$/;

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, string>> = Object.freeze({
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  py: 'python', pyi: 'python', pyw: 'python',
  json: 'json', jsonc: 'json', json5: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  cs: 'csharp', java: 'java', go: 'go', rs: 'rust', sql: 'sql',
  yml: 'yaml', yaml: 'yaml',
  xml: 'xml', html: 'xml', htm: 'xml', svg: 'xml',
  css: 'css', scss: 'scss', less: 'less',
  c: 'c', h: 'cpp', hh: 'cpp', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp',
  kt: 'kotlin', kts: 'kotlin', rb: 'ruby', php: 'php', swift: 'swift',
  lua: 'lua', r: 'r', md: 'markdown', markdown: 'markdown',
  ini: 'ini', diff: 'diff', patch: 'diff', graphql: 'graphql', gql: 'graphql',
  pl: 'perl', pm: 'perl', vb: 'vbnet', vbs: 'vbnet', wasm: 'wasm',
});

export function readLanguageFromPath(path: unknown): string | undefined {
  if (typeof path !== 'string') { return undefined; }
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) { return undefined; }
  const extension = name.slice(dot + 1).toLowerCase();
  return Object.prototype.hasOwnProperty.call(LANGUAGE_BY_EXTENSION, extension)
    ? LANGUAGE_BY_EXTENSION[extension]
    : undefined;
}

function hasTrustedToolText(content: readonly unknown[], text: string): boolean {
  for (const raw of content) {
    if (!raw || typeof raw !== 'object') { continue; }
    const item = raw as { type?: unknown; content?: unknown };
    if (item.type !== 'content' || !item.content || typeof item.content !== 'object') { continue; }
    const block = item.content as { type?: unknown; text?: unknown };
    if (block.type === 'text' && typeof block.text === 'string' && block.text === text) { return true; }
  }
  return false;
}

/** Language inferred only from host-owned Read kind, single location and content. */
export function readLanguageForToolText(
  kind: unknown,
  locations: ReadonlyArray<{ path?: unknown }> | undefined,
  content: readonly unknown[] | undefined,
  text: unknown,
): string | undefined {
  if (kind !== 'read' || !Array.isArray(locations) || locations.length !== 1) { return undefined; }
  if (typeof text !== 'string' || !Array.isArray(content) || !hasTrustedToolText(content, text)) {
    return undefined;
  }
  return readLanguageFromPath(locations[0]?.path);
}

const OPEN_FENCE = /^( {0,3})(`{3,})([ \t]*)$/;

/**
 * Body of a whole-text single unlabelled fence, matching marked's closing rule:
 * up to 3 leading spaces, the exact opening run, then `~`/backtick padding and spaces.
 */
export function unlabelledFenceBody(text: unknown): string | undefined {
  if (typeof text !== 'string') { return undefined; }
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const open = OPEN_FENCE.exec(lines[0]);
  if (!open) { return undefined; }
  const closeLine = new RegExp('^ {0,3}' + open[2] + '[~`]* *$');
  let closeAt = -1;
  for (let i = 1; i < lines.length; i++) {
    if (closeLine.test(lines[i])) { closeAt = i; break; }
  }
  if (closeAt < 0 || lines.slice(closeAt + 1).join('\n').trim() !== '') { return undefined; }
  const indent = open[1];
  const body = lines.slice(1, closeAt);
  if (!indent) { return body.join('\n'); }
  return body.map(line => {
    const leading = /^\s+/.exec(line)?.[0] ?? '';
    return leading.length >= indent.length ? line.slice(indent.length) : line;
  }).join('\n');
}

/** Strict `line<TAB>` prefixes, separated from the code they label. */
export function stripReadLineNumbers(body: unknown): { code: string; prefixes: string[] } | undefined {
  if (typeof body !== 'string' || body.length === 0) { return undefined; }
  const lines = body.replace(/\r\n?/g, '\n').split('\n');
  const prefixes: string[] = [];
  const code: string[] = [];
  for (const line of lines) {
    const match = READ_LINE.exec(line);
    if (!match) { return undefined; }
    prefixes.push(match[1]);
    code.push(match[2]);
  }
  return { code: code.join('\n'), prefixes };
}
