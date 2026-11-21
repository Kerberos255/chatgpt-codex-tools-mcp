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
