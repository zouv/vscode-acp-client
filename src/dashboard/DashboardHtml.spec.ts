import { describe, expect, it } from 'vitest';
import { DASHBOARD_COMMANDS, renderDashboardHtml } from './DashboardHtml';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';

const OPTS = { cspSource: 'vscode-webview://abc', nonce: 'NONCE123' };

describe('renderDashboardHtml', () => {
  it('embeds a strict CSP with the nonce and no remote sources', () => {
    const html = renderDashboardHtml(OPTS);
    expect(html).toContain('http-equiv="Content-Security-Policy"');
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-NONCE123'");
    expect(html).toContain('style-src vscode-webview://abc');
    expect(html).not.toContain('https://');
  });

  it('tags the client script with exactly the given nonce', () => {
    const html = renderDashboardHtml(OPTS);
    expect(html.match(/<script nonce="NONCE123">/g)).toHaveLength(1);
    expect(html).not.toContain('${');
  });

  it('only uses VS Code theme variables for colour', () => {
    const html = renderDashboardHtml(OPTS);
    const styles = html.slice(html.indexOf('<style>'), html.indexOf('</style>'));
    expect(styles).not.toMatch(/\b(rgb|rgba|hsl)\(/);
    expect(styles).toContain('var(--vscode-foreground)');
  });

  it('renders the four quick actions as whitelisted command ids', () => {
    const html = renderDashboardHtml(OPTS);
    for (const id of DASHBOARD_COMMANDS) {
      expect(html).toContain('data-command="' + id + '"');
    }
    expect(html).toContain("{ type: 'openSession', agentName: row.getAttribute('data-agent'), sessionId: row.getAttribute('data-session') }");
  });

  it('lets the webview request a refresh on load', () => {
    const html = renderDashboardHtml(OPTS);
    expect(html).toContain("acquireVsCodeApi()");
    expect(html).toContain("{ type: 'refresh' }");
    expect(html).toContain("ev.data");
  });

  it('produces a syntactically valid client script', () => {
    const html = renderDashboardHtml(OPTS);
    const body = html.slice(html.lastIndexOf('<script nonce=') + '<script nonce="NONCE123">'.length, html.lastIndexOf('</script>'));
    const file = path.join(os.tmpdir(), 'vac-dashboard-client-' + process.pid + '.js');
    fs.writeFileSync(file, body);
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    } finally {
      fs.rmSync(file, { force: true });
    }
  });
});
