import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProcess } from "../src/process-runner.js";

test("timeout terminates a Windows subprocess and its grandchild", {
  skip: process.platform !== "win32",
}, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "ctm-killtree-"));
  const script = [
    "const { spawn } = require('node:child_process');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "console.log('grandchild=' + child.pid);",
    "setInterval(() => {}, 1000);",
  ].join(" ");
  try {
    const result = await runProcess({
      command: process.execPath, args: ["-e", script], cwd,
      timeoutMs: 500, maxOutputBytes: 4000,
    });
    assert.equal(result.timedOut, true);
    const match = /grandchild=(\d+)/.exec(result.stdout);
    assert.ok(match, "parent must report descendant PID before timeout");
    const pid = Number(match[1]);
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "grandchild must be gone");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("read-only output limit stops a verbose process without waiting for timeout", async () => {
  const started = Date.now();
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('Z'.repeat(100000)); setInterval(() => {}, 1000)"],
    cwd: process.cwd(), timeoutMs: 8000, maxOutputBytes: 512,
    terminateOnOutputLimit: true,
  });
  assert.equal(result.outputLimitReached, true);
  assert.equal(result.timedOut, false);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 512);
  assert.match(result.stdout, /\[output truncated\]/);
  assert.ok(Date.now() - started < 5000, "should stop well before the command timeout");
});

test("normal exec remains bounded but never stops solely because of output", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('Z'.repeat(100000)); setTimeout(() => process.exit(0), 150)"],
    cwd: process.cwd(), timeoutMs: 6000, maxOutputBytes: 512,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.outputLimitReached, false);
  assert.equal(result.timedOut, false);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 512);
});
