import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { getScreenshotAssembly } from "../src/screenshot-assembly-cache.js";
import { POWERSHELL_SCRIPT } from "../src/screenshot-native.js";

test("native screenshot assembly compiles once, loads correctly, and rejects modified DLLs", {
  skip: process.platform !== "win32",
}, async () => {
  const first = await getScreenshotAssembly();
  assert.ok(first, "trusted compilation should succeed on Windows");
  const second = await getScreenshotAssembly();
  assert.equal(second, first, "compilation must be cached for this process");
  const loaded = execFileSync("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-Command",
    "Add-Type -Path $env:CTM_SHOT_ASSEMBLY; [CtmScreenshot].FullName",
  ], {
    windowsHide: true, timeout: 10_000, encoding: "utf8",
    env: { ...process.env, CTM_SHOT_ASSEMBLY: first },
  });
  assert.match(loaded, /CtmScreenshot/);
  assert.match(POWERSHELL_SCRIPT, /Add-Type -Path \$env:CTM_SHOT_ASSEMBLY/);
  // Invalid handle probes the real wrapper without recording any desktop pixels.
  const dir = mkdtempSync(join(tmpdir(), "ctm-cache-wrapper-"));
  try {
    const script = join(dir, "capture.ps1");
    writeFileSync(script, POWERSHELL_SCRIPT);
    const stdout = execFileSync("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script,
    ], {
      windowsHide: true, timeout: 15_000, encoding: "utf8",
      env: { ...process.env, CTM_SHOT_ASSEMBLY: first,
        CTM_SHOT_MODE: "window", CTM_SHOT_MONITOR: "0", CTM_SHOT_WINDOW_HANDLE: "123",
        CTM_SHOT_WINDOW_TITLE: "", CTM_SHOT_CROP: "0", CTM_SHOT_X: "0",
        CTM_SHOT_Y: "0", CTM_SHOT_WIDTH: "0", CTM_SHOT_HEIGHT: "0",
        CTM_SHOT_OUTPUT: join(dir, "should-not-exist.png"),
      },
    });
    const response = JSON.parse(stdout.trim()) as {ok: boolean; error?: {code?: string}};
    assert.equal(response.ok, false);
    assert.ok(["WINDOW_NOT_FOUND", "DESKTOP_UNAVAILABLE"].includes(response.error?.code ?? ""), JSON.stringify(response));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  writeFileSync(first, "changed-by-test");
  assert.equal(await getScreenshotAssembly(), null, "modified assembly must never be reused");
});
