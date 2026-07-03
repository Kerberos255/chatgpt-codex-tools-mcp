import { spawn } from "node:child_process";
import type { AccessMode } from "./config.js";

export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const blockedPatterns = [
  /\brm\s+(-[^\s]*r[^\s]*f|-[^\s]*f[^\s]*r)\b/i,
  /\bdel\s+\/[sq]\b/i,
  /\bformat\b/i,
  /\breg\s+delete\b/i,
  /\bnet\s+user\b/i,
  /\bsc\s+delete\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\biex\b/i,
  /\binvoke-expression\b/i,
  /\b(curl|wget|irm|iwr|invoke-webrequest)\b[\s\S]*(\|\s*(sh|bash|pwsh|powershell|iex|invoke-expression))/i,
  />\s*[^&]/,
  />>\s*[^&]/,
  /\btee\b/i,
  /\bsed\s+-i\b/i,
  /\bperl\s+-i\b/i,
];

const blockedProcessCommands = new Set([
  "bash",
  "bash.exe",
  "cmd",
  "cmd.exe",
  "format",
  "format.com",
  "powershell",
  "powershell.exe",
  "pwsh",
  "pwsh.exe",
  "reboot",
  "reboot.exe",
  "reg",
  "reg.exe",
  "sc",
  "sc.exe",
  "sh",
  "sh.exe",
  "shutdown",
  "shutdown.exe",
]);

const gitReadSubcommands = new Set([
  "status",
  "diff",
  "log",
  "show",
  "branch",
  "rev-parse",
  "ls-files",
  "--version",
]);

const packageManagerRunSubcommands = new Set(["test", "run"]);

export function assertProcessAllowed(command: string, args: string[], accessMode: AccessMode): void {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("Empty process command.");

  const executable = trimmed.split(/[\\/]/).pop()?.toLowerCase() ?? trimmed.toLowerCase();
  if (blockedProcessCommands.has(executable)) {
    throw new Error("Process command launches a shell or blocked system tool. Use structured tools instead.");
  }

  const joined = [trimmed, ...args].join(" ");
  for (const pattern of blockedPatterns) {
    if (pattern.test(joined)) throw new Error("Process arguments match a blocked policy pattern.");
  }

  if (accessMode !== "review") return;
  if (isReviewProcessAllowed(executable, args)) return;

  throw new Error("Process command is not in the review-mode allowlist.");
}

function isReviewProcessAllowed(executable: string, args: string[]): boolean {
  const firstArg = args[0]?.toLowerCase();

  if (executable === "git" || executable === "git.exe") {
    return firstArg ? gitReadSubcommands.has(firstArg) : false;
  }

  if (["npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd"].includes(executable)) {
    return firstArg ? packageManagerRunSubcommands.has(firstArg) : false;
  }

  if (["node", "node.exe", "python", "python.exe", "python3", "python3.exe", "py", "py.exe"].includes(executable)) {
    return args.length === 1 && ["--version", "-v", "-V"].includes(args[0]);
  }

  return [
    "pytest",
    "pytest.exe",
    "rg",
    "rg.exe",
    "grep",
    "grep.exe",
    "where",
    "where.exe",
  ].includes(executable);
}

export async function runProcess(input: {
  command: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      env: scrubEnv(process.env),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timer: NodeJS.Timeout;

    const finish = (result: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"), input.maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"), input.maxOutputBytes);
    });
    child.on("error", (error) => {
      finish({
        stdout,
        stderr: appendCapped(stderr, error.message, input.maxOutputBytes),
        exitCode: null,
        timedOut,
      });
    });
    child.on("close", (exitCode) => {
      finish({ stdout, stderr, exitCode, timedOut });
    });
  });
}

function appendCapped(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return combined.slice(0, maxBytes) + "\n[output truncated]\n";
}

export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/token|secret|password|api[_-]?key/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}
