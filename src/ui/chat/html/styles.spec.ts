import { describe, expect, it } from 'vitest';
import { styles } from './styles';

/**
 * VS Code's webview default stylesheet paints every <code> with
 * --vscode-textPreformat-background. A <code> inside a <pre> is still inline,
 * so that background is painted once per line box: line-numbered Read output
 * grew a black chip on every line. The panel styles must reset it on <pre>.
 */
function rule(pattern: string): string {
  const match = styles().match(new RegExp(pattern + '\\s*\\{([^}]*)\\}'));
  return match ? match[1] : '';
}

describe('markdown code block colours', () => {
  it('resets the webview default <code> background inside <pre>', () => {
    const block = rule('\\.bubble pre code,\\s*\\.md pre code');
    expect(block).toMatch(/background:\s*transparent/);
    expect(block).toMatch(/color:\s*inherit/);
    expect(block).toMatch(/padding:\s*0/);
    expect(block).toMatch(/border-radius:\s*0/);
  });

  it('keeps the code-block background on <pre> itself', () => {
    const block = rule('\\.bubble pre,\\s*\\.md pre');
    expect(block).toMatch(/background:\s*var\(--vscode-textCodeBlock-background\)/);
    expect(block).toMatch(/overflow-x:\s*auto/);
  });

  it('keeps inline code (outside <pre>) visibly distinct', () => {
    const block = rule('\\.bubble :not\\(pre\\) > code,\\s*\\.md :not\\(pre\\) > code');
    expect(block).toMatch(/background:\s*var\(--vscode-textCodeBlock-background\)/);
  });

  it('styles additional language tokens with theme-aware fallbacks', () => {
    const css = styles();
    expect(css).toMatch(/\.hljs-property\s*\{[^}]*--vscode-symbolIcon-propertyForeground/);
    expect(css).toMatch(/\.hljs-params\s*\{[^}]*--vscode-symbolIcon-variableForeground/);
    expect(css).toMatch(/\.hljs-meta\s*\{[^}]*--vscode-symbolIcon-keywordForeground/);
    expect(css).toMatch(/\.hljs-strong\s*\{\s*font-weight:\s*600/);
    expect(css).toMatch(/\.hljs-emphasis\s*\{\s*font-style:\s*italic/);
  });

  it('resets pre-wrap on tool markdown hosts', () => {
    expect(styles()).toMatch(/\.tool-text\.md\s*\{\s*white-space:\s*normal;/);
  });
});
