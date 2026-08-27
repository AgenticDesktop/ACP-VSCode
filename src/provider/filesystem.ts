import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { AcpJsonRpcError } from "../acp/agentConnection";
import { ACP_ERROR_CODES } from "../acp/types";
import type { FileReadHandler, FileWriteHandler } from "../acp/types";
import { isPathInsideWorkspace, sliceReadRange } from "./pathLogic";

export interface WorkspaceFileHandlers {
  fileReadHandler: FileReadHandler;
  fileWriteHandler: FileWriteHandler;
}

const IS_WINDOWS = process.platform === "win32";

/**
 * Validates an agent-supplied path: it must be absolute and located inside one
 * of the current workspace folders. Returns the normalized fs path.
 */
function assertWithinWorkspace(rawPath: string, log: vscode.LogOutputChannel): string {
  const fail = (): AcpJsonRpcError =>
    new AcpJsonRpcError(ACP_ERROR_CODES.CUSTOM, `path outside workspace: ${rawPath}`);

  if (!path.isAbsolute(rawPath)) {
    log.warn(`[acp:fs] rejecting non-absolute path: ${rawPath}`);
    throw fail();
  }

  const fsPath = vscode.Uri.file(rawPath).fsPath;
  const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
  if (!isPathInsideWorkspace(fsPath, roots, IS_WINDOWS)) {
    log.warn(`[acp:fs] rejecting path outside workspace folders: ${rawPath}`);
    throw fail();
  }
  return fsPath;
}

/**
 * Workspace-scoped implementations of the ACP client fs capabilities
 * (`fs/read_text_file` / `fs/write_text_file`). The injected handlers follow
 * the harness-internal contract: read resolves with the file content string,
 * write resolves when the file has been written.
 */
export function createWorkspaceFileHandlers(log: vscode.LogOutputChannel): WorkspaceFileHandlers {
  const fileReadHandler: FileReadHandler = async (params): Promise<string> => {
    const fsPath = assertWithinWorkspace(params.path, log);
    try {
      const content = await fs.promises.readFile(fsPath, "utf8");
      return sliceReadRange(content, params.line, params.limit);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AcpJsonRpcError(ACP_ERROR_CODES.CUSTOM, `file not found: ${fsPath}`);
      }
      throw error;
    }
  };

  const fileWriteHandler: FileWriteHandler = async (params): Promise<void> => {
    const fsPath = assertWithinWorkspace(params.path, log);
    await fs.promises.writeFile(fsPath, params.content, "utf8");
  };

  return { fileReadHandler, fileWriteHandler };
}
