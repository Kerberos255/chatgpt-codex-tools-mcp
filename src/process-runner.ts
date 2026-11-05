import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { assertPowerShellAllowed, type PowerShellPolicyContext } from "./powershell-policy.js";
import type { AccessMode } from "./config.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const shells = new Set(["bash", "bash.exe", "sh", "sh.exe", "cmd", "cmd.exe"]);
const powerShellExecutables = new Set(["powershell", "powershell.exe", "pwsh", "pwsh.exe"]);
const blockedSystemTools = new Set(["format", "format.com", "diskpart", "diskpart.exe", "reg", "reg.exe", "sc", "sc.exe", "shutdown", "shutdown.exe", "reboot", "reboot.exe"]);
const readGit = new Set(["status", "diff", "log", "show", "rev-parse", "ls-files", "--version"]);
const packageRun = new Set(["test", "run"]);

function executableName(command: string): string {
  return command.trim().split(/[\\/]/).pop()?.toLowerCase() ?? "";
}

/** Check executable and argv as separate fields. argv contains literal strings, not shell syntax. */
export function assertProcessAllowed(
  command: string, args: string[], accessMode: AccessMode, context: PowerShellPolicyContext = {},
): void {
  const exe = executableName(command);
  if (!exe) throw new Error("Empty process command.");
  if (powerShellExecutables.has(exe)) {
    if (accessMode === "review") {
      if (args.length === 1 && ["-version", "-v", "-help", "-?"].includes(args[0].toLowerCase())) return;
      throw new Error("PowerShell commands require full access mode; review mode only allows -Version or -Help.");
    }
    assertPowerShellAllowed(args, context);
    return;
  }
  if (shells.has(exe) || blockedSystemTools.has(exe)) {
    throw new Error("Process command launches a shell or blocked system tool. Use structured tools instead.");
  }
  if (exe === "net" || exe === "net.exe") {
    if (args[0]?.toLowerCase() === "user") throw new Error("Account management via net user is blocked.");
  }
  if (exe === "rm" || exe === "rm.exe") {
    if (args.some(arg => /^-[a-z]*r[a-z]*f[a-z]*$/i.test(arg) || /^-[a-z]*f[a-z]*r[a-z]*$/i.test(arg)) ||
        (args.includes("-r") || args.includes("-R")) && args.includes("-f")) {
      throw new Error("Recursive forced deletion is blocked.");
    }
  }
  if (exe === "del" || exe === "del.exe") {
    if (args.some(arg => /^\/[sq]/i.test(arg))) throw new Error("Recursive or quiet deletion is blocked.");
  }
  if (accessMode !== "review") return;
  if (exe === "git" || exe === "git.exe") {
    if (readGit.has(args[0]?.toLowerCase() ?? "")) return;
  }
  if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(exe)) {
    if (packageRun.has(args[0]?.toLowerCase() ?? "")) return;
  }
  if (["node", "node.exe", "python", "python.exe", "python3", "python3.exe", "py", "py.exe"].includes(exe)) {
    if (args.length === 1 && ["--version", "-v", "-V"].includes(args[0])) return;
  }
  if (["pytest", "pytest.exe", "rg", "rg.exe", "grep", "grep.exe", "where", "where.exe"].includes(exe)) return;
  throw new Error("Process command is not in the review-mode allowlist.");
}

export function resolveProcessCommand(command: string, args: string[]): { command: string; args: string[] } {
  const name = executableName(command).replace(/\.cmd$/i, "");
  if (powerShellExecutables.has(executableName(command))) {
    // Do not run user profiles and do not enter an interactive shell.
    return { command, args: ["-NoProfile", "-NonInteractive", ...args] };
  }
  if (process.platform !== "win32" || !["npm", "pnpm", "yarn"].includes(name)) return { command, args };
  // Node cannot spawn .cmd wrappers with shell:false on Windows. Launch the manager's
  // real JavaScript entry point directly, preserving the no-shell boundary.
  const entry = name === "npm" ? ["npm", "bin", "npm-cli.js"]
    : name === "pnpm" ? ["pnpm", "bin", "pnpm.cjs"] : ["yarn", "bin", "yarn.js"];
  const path = process.env.Path ?? process.env.PATH ?? "";
  const dirs = [dirname(process.execPath), ...path.split(delimiter).filter(Boolean)];
  if (command.includes("\\") || command.includes("/")) dirs.unshift(dirname(command));
  for (const dir of new Set(dirs)) {
    const target = join(dir, "node_modules", ...entry);
    if (existsSync(target)) return { command: process.execPath, args: [target, ...args] };
  }
  throw new Error(`Cannot locate the ${name} Node CLI; install it alongside Node or use its explicit JavaScript entrypoint.`);
}

/** Byte-bounded accumulation: O(output limit) memory and no repeated full-string copies. */
export class BoundedOutput {
  private chunks: Buffer[] = [];
  private count = 0;
  private truncated = false;
  constructor(private readonly maxBytes: number) {}

  append(chunk: Buffer | string): void {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    const remaining = Math.max(0, this.maxBytes - this.count);
    if (bytes.byteLength > remaining) this.truncated = true;
    if (remaining > 0) {
      const part = bytes.subarray(0, remaining);
      this.chunks.push(part);
      this.count += part.byteLength;
    }
  }
  text(): string {
    const marker = "\n[output truncated]\n";
    const allowance = Math.max(0, this.maxBytes - (this.truncated ? Buffer.byteLength(marker) : 0));
    let value = Buffer.concat(this.chunks, this.count).subarray(0, allowance).toString("utf8");
    // An incomplete trailing UTF-8 sequence may decode to a 3-byte replacement character.
    while (Buffer.byteLength(value, "utf8") > allowance) value = value.slice(0, -1);
    if (!this.truncated || this.maxBytes < Buffer.byteLength(marker)) return value;
    return value + marker;
  }
}

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/token|secret|password|api[_-]?key/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}

export async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ProcessResult> {
  const invocation = resolveProcessCommand(input.command, input.args);
  return new Promise(resolve => {
    const stdout = new BoundedOutput(input.maxOutputBytes);
    const stderr = new BoundedOutput(input.maxOutputBytes);
    const child = spawn(invocation.command, invocation.args, {
      cwd: input.cwd, shell: false, windowsHide: true, env: scrubEnv(process.env),
    });
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);
    function finish(exitCode: number | null): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode, timedOut });
    }
    child.stdout?.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr?.on("data", (chunk: Buffer) => stderr.append(chunk));
    child.on("error", error => { stderr.append(error.message); finish(null); });
    child.on("close", exitCode => finish(exitCode));
  });
}
