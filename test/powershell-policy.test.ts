import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertProcessAllowed, resolveProcessCommand } from "../src/process-runner.js";
import { assertPowerShellScriptSafe } from "../src/powershell-policy.js";

test("PowerShell ordinary inspection and development commands work in full mode", () => {
  for (const script of [
    "Get-Date -Format yyyy-MM-dd",
    "Get-Process | Select-Object -First 3",
    "Get-ChildItem -File | Where-Object Name -like '*.ts'",
    "$PSVersionTable.PSVersion.ToString()",
    "Write-Output 'format; Remove-Item -Recurse -Force; shutdown'",
    'Write-Output "Invoke-Expression is blocked for code, not for quotations"',
    "# Clear-Disk\nGet-Location",
    "Get-Content './format.txt' | Select-Object -First 2",
    "Write-Output \"& 'Clear-Disk'\"",
    "& 'Get-Date'",
    "Format-Table -AutoSize",
    "Write-Output \"Value $(Get-Date -Format yyyy)\"",
    "Remove-Item -LiteralPath './build.tmp'",
    "Remove-Item -Path './build' -Recurse -Force -WhatIf",
  ]) {
    assert.doesNotThrow(() => assertProcessAllowed("pwsh.exe", ["-NoProfile", "-Command", script], "full"), script);
    assert.doesNotThrow(() => assertProcessAllowed("powershell.exe", ["-NoProfile", "-Command", script], "full"), script);
  }
  assert.doesNotThrow(() => assertProcessAllowed("pwsh", ["-Version"], "review"));
  assert.throws(() => assertProcessAllowed("pwsh.exe", ["-Command", "Get-Date"], "review"), /full access mode/);
  const actual = resolveProcessCommand("pwsh.exe", ["-Command", "Get-Date"]);
  assert.deepEqual(actual.args, ["-NoProfile", "-NonInteractive", "-Command", "Get-Date"]);
});

test("PowerShell destructive operations are blocked, including aliases and interpolation", () => {
  for (const script of [
    "Clear-Disk -Number 0",
    "& 'Clear-Disk' -Number 0",
    "& \"Remove-Item\" -Recurse -Force ./folder",
    "Cl`ear-Disk -Number 0",
    "Format-Volume -DriveLetter D",
    "Restart-Computer -Force",
    "Stop-Computer",
    "Invoke-Expression $payload",
    "iex $payload",
    "Remove-Item -Recurse -Force ./folder",
    "rm -r -fo ./folder",
    "cmd.exe /c shutdown /s",
    "if ($true) { Clear-Disk -Number 0 }",
    'Write-Output "Value $(Remove-Item -Recurse -Force ./test)"',
    "Get-Process | ForEach-Object { Invoke-Expression $script }",
  ]) {
    assert.throws(() => assertPowerShellScriptSafe(script), /high risk|deletion/, script);
  }
  assert.throws(() => assertProcessAllowed("pwsh.exe", ["-NoProfile"], "full"), /explicit -Command or -File/);
  assert.throws(() => assertProcessAllowed("pwsh.exe", ["-Command", "-"], "full"), /standard input|opaque|explicit/i);
});

test("PowerShell encoded commands are decoded and checked", () => {
  const good = Buffer.from("Write-Output 'Hello'", "utf16le").toString("base64");
  const bad = Buffer.from("Clear-Disk -Number 0", "utf16le").toString("base64");
  assert.doesNotThrow(() => assertProcessAllowed("pwsh.exe", ["-EncodedCommand", good], "full"));
  assert.throws(() => assertProcessAllowed("pwsh.exe", ["-EncodedCommand", bad], "full"), /high risk/);
  assert.throws(() => assertProcessAllowed("pwsh.exe", ["-EncodedCommand", "abc"], "full"), /malformed|UTF-16LE/);
});

test("PowerShell -File checks only scripts in allowed workspaces and scans their code", () => {
  const dir = mkdtempSync(join(tmpdir(), "ctm-pwsh-"));
  const outside = mkdtempSync(join(tmpdir(), "ctm-elsewhere-"));
  try {
    mkdirSync(join(dir, "scripts"));
    writeFileSync(join(dir, "scripts", "safe.ps1"), 'Get-Date\nWrite-Output "format"');
    writeFileSync(join(dir, "scripts", "danger.ps1"), 'Clear-Disk -Number 0');
    writeFileSync(join(outside, "outside.ps1"), 'Get-Date');
    const context = { cwd: dir, allowedRoots: [dir], denyGlobs: ["**/private/**"] };
    assert.doesNotThrow(() => assertProcessAllowed("pwsh.exe", ["-File", "./scripts/safe.ps1"], "full", context));
    assert.throws(() => assertProcessAllowed("pwsh.exe", ["-File", "./scripts/danger.ps1"], "full", context), /high risk/);
    assert.throws(() => assertProcessAllowed("pwsh.exe", ["-File", join(outside, "outside.ps1")], "full", context), /allowed roots/);
    try {
      symlinkSync(outside, join(dir, "scripts", "jump"), process.platform === "win32" ? "junction" : "dir");
      assert.throws(() => assertProcessAllowed("pwsh.exe", ["-File", "./scripts/jump/outside.ps1"], "full", context), /allowed roots/);
    } catch (error) {
      if (!["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("PowerShell executes a reviewed workspace .ps1 script", async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "ctm-pwsh-exec-"));
  try {
    const scriptPath = join(root, "inspect.ps1");
    writeFileSync(scriptPath, "Write-Output 'CTM_PS_FILE_OK'\nGet-Date -Format yyyy");
    const args = ["-NoProfile", "-File", scriptPath];
    assert.doesNotThrow(() => assertProcessAllowed("pwsh.exe", args, "full", {
      cwd: root, allowedRoots: [root], denyGlobs: [],
    }));
    const { runProcess } = await import("../src/process-runner.js");
    const result = await runProcess({
      command: "pwsh.exe", args, cwd: root, timeoutMs: 15_000, maxOutputBytes: 1000,
    });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /CTM_PS_FILE_OK/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("PowerShell 7 actually runs harmless commands with no profile", async () => {
  if (process.platform !== "win32") return;
  const { runProcess } = await import("../src/process-runner.js");
  const result = await runProcess({
    command: "pwsh.exe", args: ["-Command", "Write-Output 'CTM_PWSH_OK'"],
    cwd: process.cwd(), timeoutMs: 15_000, maxOutputBytes: 1000,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  assert.match(result.stdout, /CTM_PWSH_OK/);
});
