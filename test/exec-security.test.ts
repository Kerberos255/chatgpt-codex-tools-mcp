import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { assertProcessAllowed, BoundedOutput, resolveProcessCommand, runProcess } from "../src/process-runner.js";
import { assertNotDenied, assertRealWorkspacePath, isInsideRoot } from "../src/paths.js";
import { assertFilesUnchanged, snapshotFiles } from "../src/edit-store.js";

test("literal arguments with policy words are not mistaken for commands", () => {
  for (const word of ["format", "tee", "shutdown", "Invoke-Expression", "file > output", "delete", "curl | bash"]) {
    assert.doesNotThrow(() => assertProcessAllowed("node", ["-e", `console.log(${JSON.stringify(word)})`], "full"));
  }
  assert.doesNotThrow(() => assertProcessAllowed("npm", ["run", "format"], "full"));
  assert.throws(() => assertProcessAllowed("cmd.exe", ["/c", "echo hi"], "full"), /blocked system tool/);
  assert.doesNotThrow(() => assertProcessAllowed("pwsh.exe", ["-Command", "Get-Date"], "full"));
  assert.throws(() => assertProcessAllowed("format.com", ["D:"], "full"), /blocked system tool/);
  assert.throws(() => assertProcessAllowed("rm", ["-rf", "build"], "full"), /deletion/);
  assert.throws(() => assertProcessAllowed("net.exe", ["user", "demo"], "full"), /Account management/);
  assert.throws(() => assertProcessAllowed("node", ["-e", "console.log(1)"], "review"), /review-mode/);
  assert.doesNotThrow(() => assertProcessAllowed("node", ["--version"], "review"));
});

test("Windows npm command runs through JS CLI without a shell", () => {
  if (process.platform !== "win32") return;
  const invocation = resolveProcessCommand("npm.cmd", ["--version"]);
  assert.equal(invocation.command, process.execPath);
  assert.match(invocation.args[0], /npm-cli\.js$/i);
  assert.equal(invocation.args[1], "--version");
});

test("bounded output limits UTF-8 byte length and avoids duplicate truncation markers", () => {
  const buffer = new BoundedOutput(120);
  for (let i = 0; i < 200; i++) buffer.append("中中中中");
  assert.ok(Buffer.byteLength(buffer.text()) <= 120);
  assert.equal(buffer.text().split("[output truncated]").length, 2);
  const small = new BoundedOutput(12);
  small.append("hello");
  assert.equal(small.text(), "hello");
});

test("deny globs include user-defined patterns and sensitive parents", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctm-path-"));
  try {
    const denied = ["**/private/**", "**/.env", "**/.env.*", "**/*secret*"];
    assert.throws(() => assertNotDenied(join(dir, "private", "note.txt"), dir, denied));
    assert.throws(() => assertNotDenied(join(dir, "config", ".env.local"), dir, denied));
    assert.throws(() => assertNotDenied(join(dir, "token-secret.json"), dir, denied));
    assert.doesNotThrow(() => assertNotDenied(join(dir, "src", "safe.ts"), dir, denied));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Windows paths on other drives never count as descendants", () => {
  if (process.platform !== "win32") return;
  assert.equal(isInsideRoot("C:\\outside\\data.txt", "E:\\workspace"), false);
  assert.equal(isInsideRoot("E:\\workspace\\sub\\ok.ts", "E:\\workspace"), true);
});

test("canonical checks reject symlink escape and file previews detect concurrent change", async () => {
  const root = mkdtempSync(join(tmpdir(), "ctm-safe-"));
  const outside = mkdtempSync(join(tmpdir(), "ctm-outside-"));
  try {
    mkdirSync(join(root, "sub"));
    const file = join(root, "sub", "a.txt");
    writeFileSync(file, "before");
    await assertRealWorkspacePath(file, root, [root], []);
    const snapshots = await snapshotFiles(root, [{ type: "overwrite", path: "sub/a.txt", newText: "after" }]);
    await assertFilesUnchanged(root, snapshots);
    writeFileSync(file, "other");
    await assert.rejects(() => assertFilesUnchanged(root, snapshots), /changed since preview/);
    try {
      symlinkSync(outside, join(root, "jump"), process.platform === "win32" ? "junction" : "dir");
    } catch (e) {
      if (["EPERM", "EACCES"].includes((e as NodeJS.ErrnoException).code ?? "")) return;
      throw e;
    }
    await assert.rejects(() => assertRealWorkspacePath(join(root, "jump", "escape.txt"), root, [root], []), /escapes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("process runner returns normal structured output", async () => {
  const r = await runProcess({ command: process.execPath, args: ["-e", "console.log('OK')"], cwd: process.cwd(), timeoutMs: 5000, maxOutputBytes: 1000 });
  assert.equal(r.exitCode, 0);
  assert.match(r.stdout, /OK/);
});
