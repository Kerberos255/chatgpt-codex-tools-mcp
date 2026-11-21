import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, mkdtemp, writeFile, rm, unlink } from "node:fs/promises";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { NATIVE_SCREENSHOT_SOURCE } from "./screenshot-native.js";

const execFileAsync = promisify(execFile);
interface TrustedAssembly { path: string; sha256: string }
let assemblyPromise: Promise<TrustedAssembly | null> | undefined;

const COMPILER = [
  "$ErrorActionPreference = 'Stop'",
  "Add-Type -AssemblyName System.Windows.Forms",
  "Add-Type -AssemblyName System.Drawing",
  "Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'",
  NATIVE_SCREENSHOT_SOURCE,
  "'@ -OutputAssembly $env:CTM_SHOT_COMPILE_OUTPUT",
].join("\n");

async function buildAssembly(): Promise<TrustedAssembly | null> {
  if (process.platform !== "win32") return null;
  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "ctm-shot-assembly-"));
    const scriptPath = join(dir, "compile.ps1");
    const path = join(dir, "capture.dll");
    await writeFile(scriptPath, COMPILER, { flag: "wx", mode: 0o600 });
    try {
      await execFileAsync("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath,
      ], {
        windowsHide: true,
        timeout: 20_000,
        maxBuffer: 256 * 1024,
        env: { ...process.env, CTM_SHOT_COMPILE_OUTPUT: path },
      });
    } finally {
      await unlink(scriptPath).catch(() => {});
    }
    const bytes = await readFile(path);
    if (bytes.byteLength < 512 || bytes.byteLength > 4 * 1024 * 1024) throw new Error("Invalid assembly size");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const cleanDir = dir;
    process.once("exit", () => { try { rmSync(cleanDir, { recursive: true, force: true }); } catch { /* best effort */ } });
    return { path, sha256 };
  } catch {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    return null;
  }
}

/** Never reuse on-disk assemblies from an earlier process. On failure, fall back to inline Add-Type. */
export async function getScreenshotAssembly(): Promise<string | null> {
  assemblyPromise ??= buildAssembly();
  const assembly = await assemblyPromise;
  if (!assembly) return null;
  try {
    const bytes = await readFile(assembly.path);
    const digest = createHash("sha256").update(bytes).digest("hex");
    if (digest === assembly.sha256) return assembly.path;
  } catch { /* Deleted or replaced by another process. */ }
  assemblyPromise = Promise.resolve(null);
  return null;
}
