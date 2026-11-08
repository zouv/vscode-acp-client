import * as vscode from 'vscode';
import { isAbsolute } from 'node:path';
import type {
  ReadTextFileRequest,
  ReadTextFileResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from '@agentclientprotocol/sdk';

import { log, logError } from '../utils/Logger';
import { sliceLines } from './FileSlice';

const sameFile = process.platform === 'win32'
  ? (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
  : (a: string, b: string) => a === b;

/** ACP paths MUST be absolute; a relative one would silently resolve against the host's cwd. */
function fileUri(path: string): vscode.Uri {
  if (!isAbsolute(path)) { throw new Error(`Path must be absolute: ${path}`); }
  return vscode.Uri.file(path);
}

/**
 * The open editor buffer of this file on disk. Only `file:` documents: a `git:` (SCM diff)
 * or other virtual document shares the fsPath but holds different (e.g. HEAD) content.
 */
function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  return vscode.workspace.textDocuments.find(doc => doc.uri.scheme === 'file' && sameFile(doc.uri.fsPath, uri.fsPath));
}

/** Reads prefer unsaved editor buffers; writes open the result so the user sees the change. */
export class FileSystemHandler {
  async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
    log(`readTextFile: ${params.path}`);
    try {
      const uri = fileUri(params.path);
      const open = openDocument(uri);
      const content = open
        ? open.getText()
        : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf-8');
      return { content: sliceLines(content, params.line, params.limit) };
    } catch (e) {
      logError(`readTextFile failed: ${params.path}`, e);
      throw e;
    }
  }

  async writeTextFile(params: WriteTextFileRequest): Promise<WriteTextFileResponse> {
    log(`writeTextFile: ${params.path}`);
    try {
      const uri = fileUri(params.path);
      let doc = openDocument(uri);
      if (doc) {
        if (doc.isDirty) { throw new Error('File has unsaved editor changes; save or revert before retrying.'); }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), params.content);
        if (!await vscode.workspace.applyEdit(edit)) { throw new Error('Editor rejected the file edit.'); }
        if (!await doc.save()) { throw new Error('Could not save the edited document.'); }
      } else {
        await vscode.workspace.fs.writeFile(uri, Buffer.from(params.content, 'utf-8'));
        doc = await vscode.workspace.openTextDocument(uri);
      }
      await vscode.window.showTextDocument(doc, { preview: true, preserveFocus: true });
      return {};
    } catch (e) {
      logError(`writeTextFile failed: ${params.path}`, e);
      throw e;
    }
  }
}
