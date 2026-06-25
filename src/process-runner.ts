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

const reviewAllowlist = [
  /^\s*(git\s+(status|diff|log|show|branch|rev-parse|ls-files)\b|pwd\b|ls\b|dir\b|find\b|rg\b|grep\b|tree\b|node\s+--version\b|npm\s+(test|run\s+[\w:-]+)\b|pnpm\s+(test|run\s+[\w:-]+)\b|yarn\s+(test|run\s+[\w:-]+)\b|pytest\b|python\s+--version\b|python3\s+--version\b)/i,
];

const confirmedShellAllowlist = [
  /^\s*git\s+init\b/i,
  /^\s*git\s+add\b/i,
  /^\s*git\s+commit\b/i,
  /^\s*git\s+branch\s+-M\b/i,
  /^\s*git\s+remote\s+(add|set-url|remove|-v)\b/i,
  /^\s*git\s+tag\b/i,
  /^\s*git\s+push\b/i,
  /^\s*gh\s+repo\s+(create|view)\b/i,
];

export type ShellApprovalMode = "direct" | "confirmed";

export function assertCommandAllowed(command: string, accessMode: AccessMode, approvalMode: ShellApprovalMode = "direct"): void {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("Empty shell command.");

  for (const pattern of blockedPatterns) {
    if (pattern.test(trimmed)) throw new Error("Shell command matches a blocked policy pattern.");
  }

  if (accessMode !== "review") return;

  if (reviewAllowlist.some((pattern) => pattern.test(trimmed))) return;

  if (approvalMode === "confirmed" && confirmedShellAllowlist.some((pattern) => pattern.test(trimmed))) return;

  throw new Error(
    approvalMode === "confirmed"
      ? "Shell command is not in the review-mode direct or confirmed allowlist."
      : "Shell command is not in the review-mode allowlist. Use shell preview/confirm for approved write/publish commands.",
  );
}

export async function runCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      windowsHide: true,
      env: scrubEnv(process.env),
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, input.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = appendCapped(stdout, chunk.toString("utf8"), input.maxOutputBytes);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = appendCapped(stderr, chunk.toString("utf8"), input.maxOutputBytes);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode, timedOut });
    });
  });
}

function appendCapped(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return combined.slice(0, maxBytes) + "\n[output truncated]\n";
}

function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (/token|secret|password|api[_-]?key/i.test(key)) continue;
    clean[key] = value;
  }
  return clean;
}
