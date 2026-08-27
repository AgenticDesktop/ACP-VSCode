import * as path from "node:path";

/**
 * Pure helpers for the workspace-scoped fs handlers (path containment and
 * read ranges). Extracted from {@link "./filesystem"} so they can be
 * unit-tested in plain Node without VS Code. All comparisons follow the
 * semantics selected by `isWindows`, independent of the host platform.
 */

function comparable(fsPath: string, isWindows: boolean): string {
  const cased = isWindows ? fsPath.toLowerCase() : fsPath;
  // Windows accepts both separators; normalize to backslashes so mixed
  // input still matches.
  return isWindows ? cased.replace(/\//g, "\\") : cased;
}

function isWithinRoot(candidate: string, root: string, sep: string): boolean {
  if (candidate === root) {
    return true;
  }
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

/**
 * Whether `candidatePath` is an absolute path located inside (or equal to)
 * one of `workspaceRoots`. Windows semantics (`isWindows === true`) compare
 * case-insensitively and treat `/` and `\` as equivalent separators;
 * POSIX semantics compare case-sensitively. Sibling directories that merely
 * share a name prefix (e.g. `D:\ws-x` vs `D:\ws`) never count as inside.
 */
export function isPathInsideWorkspace(
  candidatePath: string,
  workspaceRoots: readonly string[],
  isWindows: boolean,
): boolean {
  const isAbsolute = isWindows
    ? path.win32.isAbsolute(candidatePath)
    : path.posix.isAbsolute(candidatePath);
  if (!isAbsolute) {
    return false;
  }
  const sep = isWindows ? "\\" : "/";
  const candidate = comparable(candidatePath, isWindows);
  return workspaceRoots.some((root) =>
    isWithinRoot(candidate, comparable(root, isWindows), sep),
  );
}

/**
 * Applies the ACP `fs/read_text_file` range parameters to file content:
 * `line` is the 1-based line number to start reading from, `limit` the
 * maximum number of lines to return. Line terminators (`\n` and `\r\n`)
 * are preserved as-is; without a range the content is returned unchanged.
 */
export function sliceReadRange(content: string, line?: number, limit?: number): string {
  const startLine = line !== undefined && line > 1 ? line : 1;
  const maxLines = limit !== undefined && limit >= 0 ? limit : undefined;
  if (startLine === 1 && maxLines === undefined) {
    return content;
  }
  // Split after every newline so each line keeps its terminator (including \r\n).
  const lines = content.split(/(?<=\n)/);
  return lines
    .slice(startLine - 1, maxLines !== undefined ? startLine - 1 + maxLines : undefined)
    .join("");
}
