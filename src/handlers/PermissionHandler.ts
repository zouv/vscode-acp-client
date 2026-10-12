import * as vscode from 'vscode';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

import { log } from '../utils/Logger';
import type { PermissionBridge } from './PermissionBridge';

const CANCELLED: RequestPermissionResponse = { outcome: { outcome: 'cancelled' } };

export class PermissionHandler {
  constructor(private readonly bridge?: PermissionBridge) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const autoApprove = vscode.workspace.getConfiguration('vac').get<string>('autoApprovePermissions', 'ask');
    log(`requestPermission: ${params.toolCall?.title || 'Permission Request'} (autoApprove=${autoApprove})`);

    if (autoApprove === 'allowAll') {
      const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always');
      if (allow) { return { outcome: { outcome: 'selected', optionId: allow.optionId } }; }
    }

    if (this.bridge) {
      return this.bridge.request(params, (p, label) => this.quickPick(p, label));
    }
    return this.quickPick(params, '');
  }

  /** Dialog fallback for when no panel can render the prompt. */
  private async quickPick(params: RequestPermissionRequest, label: string): Promise<RequestPermissionResponse> {
    const title = params.toolCall?.title || 'Permission Request';
    const items = params.options.map(option => ({
      label: `${option.kind.startsWith('allow') ? '$(check)' : '$(x)'} ${option.name}`,
      description: option.kind,
      optionId: option.optionId,
    }));

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: label ? `${label} — ${title}` : title,
      title: 'Agent Permission Request',
      ignoreFocusOut: true,
    });
    if (!picked) {
      log('Permission cancelled by user');
      return CANCELLED;
    }
    log(`Permission selected: ${picked.optionId}`);
    return { outcome: { outcome: 'selected', optionId: picked.optionId } };
  }
}
