import * as vscode from 'vscode';
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import { log, logError } from '../utils/Logger';

const sameFile = process.platform === 'win32'
  ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  : (a: string, b: string) => a === b;

/** Reads prefer unsaved editor buffers; writes open the result so the user sees the change. */
export class FileSystemHandler {
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    log(`readTextFile: ${params.path}`);
    try {
      const uri = vscode.Uri.file(params.path);
      const open = vscode.workspace.textDocuments.find(doc => sameFile(doc.uri.fsPath, uri.fsPath));
      let content = open
        ? open.getText()
        : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');

      const hasLine = params.line !== undefined && params.line !== null;
      const hasLimit = params.limit !== undefined && params.limit !== null;
      if (hasLine || hasLimit) {
        const lines = content.split('\n');
        const start = Math.max(0, (params.line ?? 1) - 1);
        content = lines.slice(start, params.limit ? start + params.limit : undefined).join('\n');
      }
      return { content };
    } catch (e) {
      logError(`readTextFile failed: ${params.path}`, e);
      throw e;
    }
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    log(`writeTextFile: ${params.path}`);
    try {
      const uri = vscode.Uri.file(params.path);
      await vscode.workspace.fs.writeFile(uri, Buffer.from(params.content, 'utf-8'));
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      return {};
    } catch (e) {
      logError(`writeTextFile failed: ${params.path}`, e);
      throw e;
    }
  }
}
