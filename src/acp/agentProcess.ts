import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { AgentProcessConfig, AcpLogFn } from "./types";

const WINDOWS_CMD_SCRIPT = /\.(cmd|bat)$/i;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Resolves a bare command name to an executable file on Windows.
 *
 * Node's `spawn` without `shell: true` cannot execute `.cmd`/`.bat`
 * launchers (CVE-2024-27980 hardening) and its PATH lookup also misses
 * command shims that the extension host's inherited PATH may not even
 * contain (e.g. `%APPDATA%\npm` is often missing from GUI-launched VS
 * Code). Mirroring the editor's own process launcher, we probe well-known
 * executable extensions across the PATH and return the first hit; cmd
 * scripts are later routed through the shell.
 */
function resolveWindowsCommand(command: string): string {
  if (isAbsolute(command)) {
    return command;
  }
  const pathDirs = [
    ...(process.env.PATH ?? "").split(";"),
    // GUI-launched VS Code frequently lacks the user npm shim directory.
    join(process.env.APPDATA ?? "", "npm"),
  ].filter((dir) => dir.length > 0);

  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((ext) => ext.trim().toLowerCase())
    .filter((ext) => ext.length > 0);

  // Prefer real executables over cmd shims when both exist.
  const candidates: string[] = [];
  for (const ext of extensions) {
    candidates.push(`${command}${ext}`);
  }
  candidates.push(command);

  for (const dir of pathDirs) {
    for (const candidate of candidates) {
      const full = join(dir, candidate);
      if (existsSync(full)) {
        return full;
      }
    }
  }
  return command;
}

/**
 * Quotes a single argument for a `cmd.exe` command line (used only when the
 * agent must be launched through the shell on Windows).
 */
function quoteForWindowsShell(arg: string): string {
  if (arg !== "" && !/[\s"^&|<>()%]/.test(arg)) {
    return arg;
  }
  return `"${arg.replace(/"/g, '""')}"`;
}

/**
 * Spawns an ACP agent process with stdio pipes for the ndjson protocol.
 *
 * Windows compatibility:
 * - Bare commands (no path separator) and `.exe` paths are spawned directly
 *   with `shell: false` + `windowsHide: true`, so stdout stays a clean
 *   ndjson channel.
 * - `.cmd` / `.bat` launchers cannot be spawned directly on Windows (Node
 *   rejects them without a shell since the CVE-2024-27980 hardening), so
 *   they are routed through the shell with quoted arguments.
 * - Failures (synchronous spawn errors) throw an Error containing the
 *   command for diagnosis; asynchronous spawn errors (e.g. ENOENT for a
 *   command not on PATH) are logged with the command, and the caller learns
 *   about them through the child's `error`/`exit` events.
 *
 * Process output forwarding:
 * - stdout is the protocol channel; a `data` listener only *observes* chunks
 *   for trace logging (Node broadcasts `data` to all listeners, so the
 *   stream adapter still receives every chunk).
 * - stderr carries agent diagnostics only — it is logged and never parsed
 *   as protocol data.
 */
export function spawnAgentProcess(config: AgentProcessConfig, log: AcpLogFn): ChildProcess {
  const isWindows = process.platform === "win32";
  // Resolve bare Windows commands (npm shims etc.) to a full path first:
  // the extension host's PATH often lacks %APPDATA%\npm, and Node's spawn
  // cannot execute .cmd shims directly anyway.
  const resolved = isWindows ? resolveWindowsCommand(config.command) : config.command;
  if (resolved !== config.command) {
    log("debug", `Resolved agent command "${config.command}" -> "${resolved}"`);
  }

  const command = resolved;
  const args = config.args ?? [];
  const needsShell = isWindows && WINDOWS_CMD_SCRIPT.test(command);

  let child: ChildProcess;
  try {
    child = spawn(command, needsShell ? args.map(quoteForWindowsShell) : args, {
      cwd: config.cwd,
      env: config.env ? { ...process.env, ...config.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: needsShell,
      windowsHide: true,
    });
  } catch (error) {
    throw new Error(
      `Failed to spawn ACP agent process "${command}" (args: ${JSON.stringify(args)}): ${errorMessage(error)}`,
    );
  }

  child.stdout?.on("data", (chunk: Buffer) => {
    log("trace", `[agent:${command} stdout] ${chunk.toString().trimEnd()}`);
  });

  child.stderr?.on("data", (chunk: Buffer) => {
    log("debug", `[agent:${command} stderr] ${chunk.toString().trimEnd()}`);
  });

  child.once("error", (error) => {
    const code = (error as NodeJS.ErrnoException).code ?? "UNKNOWN";
    log(
      "error",
      `Agent process "${command}" failed: [${code}] ${error.message}`,
    );
  });

  return child;
}
