import { spawn, type ChildProcess } from 'node:child_process';

export function terminateTree(child: ChildProcess, signal: 'SIGTERM' | 'SIGKILL'): void {
  if (child.pid === undefined) { return; }
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      .on('error', () => { try { child.kill(signal); } catch { /* already gone */ } });
    return;
  }
  try { process.kill(-child.pid, signal); }
  catch { try { child.kill(signal); } catch { /* already gone */ } }
}
