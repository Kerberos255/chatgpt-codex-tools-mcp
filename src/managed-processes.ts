import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { scrubEnv, type ProcessResult } from "./process-runner.js";

export interface ManagedProcessSnapshot extends ProcessResult {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  running: boolean;
  startedAt: number;
  finishedAt?: number;
}

interface ManagedProcessEntry {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  child: ChildProcessWithoutNullStreams;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  maxOutputBytes: number;
  timer: NodeJS.Timeout;
}

export class ManagedProcessStore {
  private readonly processes = new Map<string, ManagedProcessEntry>();

  start(input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
  }): ManagedProcessSnapshot {
    const id = `proc_${randomUUID()}`;
    const child = spawn(input.command, input.args, {
      cwd: input.cwd,
      shell: false,
      windowsHide: true,
      env: scrubEnv(process.env),
    });

    const entry: ManagedProcessEntry = {
      id,
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      child,
      stdout: "",
      stderr: "",
      exitCode: null,
      timedOut: false,
      running: true,
      startedAt: Date.now(),
      maxOutputBytes: input.maxOutputBytes,
      timer: setTimeout(() => {
        entry.timedOut = true;
        child.kill("SIGTERM");
      }, input.timeoutMs),
    };

    child.stdout.on("data", (chunk: Buffer) => {
      entry.stdout = appendCapped(entry.stdout, chunk.toString("utf8"), entry.maxOutputBytes);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      entry.stderr = appendCapped(entry.stderr, chunk.toString("utf8"), entry.maxOutputBytes);
    });
    child.on("error", (error) => {
      entry.stderr = appendCapped(entry.stderr, error.message, entry.maxOutputBytes);
      finish(entry, null);
    });
    child.on("close", (exitCode) => finish(entry, exitCode));

    this.processes.set(id, entry);
    return snapshot(entry);
  }

  read(id: string): ManagedProcessSnapshot {
    const entry = this.get(id);
    return snapshot(entry);
  }

  stop(id: string): ManagedProcessSnapshot {
    const entry = this.get(id);
    if (entry.running) {
      entry.child.kill("SIGTERM");
      finish(entry, entry.exitCode);
    }
    return snapshot(entry);
  }

  private get(id: string): ManagedProcessEntry {
    const entry = this.processes.get(id);
    if (!entry) throw new Error(`Unknown process id: ${id}`);
    return entry;
  }
}

function finish(entry: ManagedProcessEntry, exitCode: number | null): void {
  if (!entry.running) return;
  entry.running = false;
  entry.exitCode = exitCode;
  entry.finishedAt = Date.now();
  clearTimeout(entry.timer);
}

function snapshot(entry: ManagedProcessEntry): ManagedProcessSnapshot {
  return {
    id: entry.id,
    command: entry.command,
    args: entry.args,
    cwd: entry.cwd,
    running: entry.running,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    stdout: entry.stdout,
    stderr: entry.stderr,
    exitCode: entry.exitCode,
    timedOut: entry.timedOut,
  };
}

function appendCapped(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  if (Buffer.byteLength(combined, "utf8") <= maxBytes) return combined;
  return combined.slice(0, maxBytes) + "\n[output truncated]\n";
}
