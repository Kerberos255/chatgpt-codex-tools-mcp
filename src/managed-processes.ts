import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { BoundedOutput, resolveProcessCommand, scrubEnv, type ProcessResult } from "./process-runner.js";

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
  stdout: BoundedOutput;
  stderr: BoundedOutput;
  exitCode: number | null;
  timedOut: boolean;
  running: boolean;
  startedAt: number;
  finishedAt?: number;
  timer: NodeJS.Timeout;
}

const MAX_TRACKED = 128;
const FINISHED_TTL_MS = 10 * 60_000;

export class ManagedProcessStore {
  private readonly processes = new Map<string, ManagedProcessEntry>();

  start(input: {
    command: string;
    args: string[];
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
  }): ManagedProcessSnapshot {
    this.prune();
    if (this.processes.size >= MAX_TRACKED) throw new Error("Too many managed processes. Stop or finish existing processes first.");
    const invocation = resolveProcessCommand(input.command, input.args);
    const id = `proc_${randomUUID()}`;
    const child = spawn(invocation.command, invocation.args, {
      cwd: input.cwd, shell: false, windowsHide: true, env: scrubEnv(process.env),
    });
    const entry: ManagedProcessEntry = {
      id, command: input.command, args: input.args, cwd: input.cwd, child,
      stdout: new BoundedOutput(input.maxOutputBytes), stderr: new BoundedOutput(input.maxOutputBytes),
      exitCode: null, timedOut: false, running: true, startedAt: Date.now(),
      timer: setTimeout(() => {
        entry.timedOut = true;
        child.kill("SIGTERM");
      }, input.timeoutMs),
    };
    child.stdout.on("data", (chunk: Buffer) => entry.stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => entry.stderr.append(chunk));
    child.on("error", error => { entry.stderr.append(error.message); finish(entry, null); });
    child.on("close", exitCode => finish(entry, exitCode));
    this.processes.set(id, entry);
    return snapshot(entry);
  }

  read(id: string): ManagedProcessSnapshot {
    const entry = this.get(id);
    return snapshot(entry);
  }

  stop(id: string): ManagedProcessSnapshot {
    const entry = this.get(id);
    if (entry.running) entry.child.kill("SIGTERM");
    // A successful stop request is not proof of process exit. The 'close' event sets finishedAt.
    return snapshot(entry);
  }

  private get(id: string): ManagedProcessEntry {
    this.prune();
    const entry = this.processes.get(id);
    if (!entry) throw new Error(`Unknown or expired process id: ${id}`);
    return entry;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, entry] of this.processes) {
      if (!entry.running && entry.finishedAt !== undefined && now - entry.finishedAt > FINISHED_TTL_MS) this.processes.delete(id);
    }
    if (this.processes.size >= MAX_TRACKED) {
      for (const [id, entry] of this.processes) {
        if (!entry.running) this.processes.delete(id);
        if (this.processes.size < MAX_TRACKED) break;
      }
    }
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
    id: entry.id, command: entry.command, args: entry.args, cwd: entry.cwd,
    running: entry.running, startedAt: entry.startedAt, finishedAt: entry.finishedAt,
    stdout: entry.stdout.text(), stderr: entry.stderr.text(),
    exitCode: entry.exitCode, timedOut: entry.timedOut,
  };
}
