import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

export type ScreenshotMode = "desktop" | "monitor" | "window" | "region";

export interface ScreenshotOptions {
  mode: ScreenshotMode;
  monitor?: number;
  windowTitle?: string;
  windowHandle?: number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  savePath?: string;
}

export interface ScreenshotResult {
  data: string;
  mimeType: "image/png";
  width: number;
  height: number;
  left: number;
  top: number;
  windowTitle?: string;
  savedPath?: string;
}

const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CtmWin32 {
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("user32.dll", SetLastError=true)] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll", SetLastError=true)] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll", SetLastError=true)] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint flags);
  [DllImport("gdi32.dll", SetLastError=true)] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll", SetLastError=true)] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int nWidth, int nHeight);
  [DllImport("gdi32.dll", SetLastError=true)] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll", SetLastError=true)] public static extern bool BitBlt(IntPtr hdcDest, int xDest, int yDest, int width, int height, IntPtr hdcSrc, int xSrc, int ySrc, int rop);
  [DllImport("gdi32.dll", SetLastError=true)] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll", SetLastError=true)] public static extern bool DeleteDC(IntPtr hdc);
}
"@

$mode = $env:CTM_SHOT_MODE
$left = 0
$top = 0
$width = 0
$height = 0
$matchedTitle = $null
$windowHandle = [IntPtr]::Zero

switch ($mode) {
  "desktop" {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $left = $bounds.Left; $top = $bounds.Top; $width = $bounds.Width; $height = $bounds.Height
  }
  "monitor" {
    $screens = [System.Windows.Forms.Screen]::AllScreens
    $index = [int]$env:CTM_SHOT_MONITOR
    if ($index -lt 0 -or $index -ge $screens.Count) { throw "Monitor index out of range: $index (count=$($screens.Count))" }
    $bounds = $screens[$index].Bounds
    $left = $bounds.Left; $top = $bounds.Top; $width = $bounds.Width; $height = $bounds.Height
  }
  "window" {
    $handle = [IntPtr]::Zero
    if ($env:CTM_SHOT_WINDOW_HANDLE) {
      $handle = [IntPtr]([int64]$env:CTM_SHOT_WINDOW_HANDLE)
    } else {
      $needle = $env:CTM_SHOT_WINDOW_TITLE
      if (-not $needle) { throw "windowTitle or windowHandle is required for window mode." }
      $proc = Get-Process | Where-Object {
        $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -and $_.MainWindowTitle.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0
      } | Select-Object -First 1
      if (-not $proc) { throw "No visible window matched title: $needle" }
      $handle = [IntPtr]$proc.MainWindowHandle
      $matchedTitle = $proc.MainWindowTitle
    }
    $rect = New-Object CtmWin32+RECT
    if (-not [CtmWin32]::GetWindowRect($handle, [ref]$rect)) { throw "GetWindowRect failed." }
    $left = $rect.Left; $top = $rect.Top; $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
    $windowHandle = $handle
  }
  "region" {
    $left = [int]$env:CTM_SHOT_X
    $top = [int]$env:CTM_SHOT_Y
    $width = [int]$env:CTM_SHOT_WIDTH
    $height = [int]$env:CTM_SHOT_HEIGHT
  }
  default { throw "Unsupported screenshot mode: $mode" }
}

if ($width -le 0 -or $height -le 0) { throw "Screenshot bounds are empty: $width x $height." }
if (([int64]$width * [int64]$height) -gt 50000000) { throw "Screenshot region is too large." }

$screenDc = [CtmWin32]::GetDC([IntPtr]::Zero)
if ($screenDc -eq [IntPtr]::Zero) { throw "GetDC failed." }
$memoryDc = [CtmWin32]::CreateCompatibleDC($screenDc)
if ($memoryDc -eq [IntPtr]::Zero) { [CtmWin32]::ReleaseDC([IntPtr]::Zero, $screenDc) | Out-Null; throw "CreateCompatibleDC failed." }
$bitmapHandle = [CtmWin32]::CreateCompatibleBitmap($screenDc, $width, $height)
if ($bitmapHandle -eq [IntPtr]::Zero) {
  [CtmWin32]::DeleteDC($memoryDc) | Out-Null
  [CtmWin32]::ReleaseDC([IntPtr]::Zero, $screenDc) | Out-Null
  throw "CreateCompatibleBitmap failed."
}
$oldObject = [CtmWin32]::SelectObject($memoryDc, $bitmapHandle)
try {
  if ($mode -eq "window") {
    $pwRenderFullContent = 2
    if (-not [CtmWin32]::PrintWindow($windowHandle, $memoryDc, $pwRenderFullContent)) {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "PrintWindow failed with Win32 error $code."
    }
  } else {
    $srcCopyCaptureBlt = 0x40CC0020
    if (-not [CtmWin32]::BitBlt($memoryDc, 0, 0, $width, $height, $screenDc, $left, $top, $srcCopyCaptureBlt)) {
      $code = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
      throw "Screen capture is unavailable on the current Windows desktop (Win32 error $code). Unlock or activate the interactive desktop and retry."
    }
  }
  $bitmap = [System.Drawing.Image]::FromHbitmap($bitmapHandle)
  try {
    $bitmap.Save($env:CTM_SHOT_OUTPUT, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $bitmap.Dispose()
  }
} finally {
  if ($oldObject -ne [IntPtr]::Zero) { [CtmWin32]::SelectObject($memoryDc, $oldObject) | Out-Null }
  [CtmWin32]::DeleteObject($bitmapHandle) | Out-Null
  [CtmWin32]::DeleteDC($memoryDc) | Out-Null
  [CtmWin32]::ReleaseDC([IntPtr]::Zero, $screenDc) | Out-Null
}

[pscustomobject]@{
  width = $width
  height = $height
  left = $left
  top = $top
  windowTitle = $matchedTitle
} | ConvertTo-Json -Compress
`;

export async function captureScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
  if (process.platform !== "win32") {
    throw new Error("screenshot is currently supported on Windows only.");
  }
  if (options.mode === "window" && !options.windowHandle && !options.windowTitle) {
    throw new Error("windowTitle or windowHandle is required for window mode.");
  }
  if (options.mode === "region") {
    if (options.x === undefined || options.y === undefined || options.width === undefined || options.height === undefined) {
      throw new Error("x, y, width, and height are required for region mode.");
    }
    if (options.width <= 0 || options.height <= 0) throw new Error("width and height must be positive.");
  }

  const tempPath = join(tmpdir(), `ctm-screenshot-${randomUUID()}.png`);
  const env = {
    ...process.env,
    CTM_SHOT_MODE: options.mode,
    CTM_SHOT_MONITOR: String(options.monitor ?? 0),
    CTM_SHOT_WINDOW_TITLE: options.windowTitle ?? "",
    CTM_SHOT_WINDOW_HANDLE: options.windowHandle ? String(options.windowHandle) : "",
    CTM_SHOT_X: String(options.x ?? 0),
    CTM_SHOT_Y: String(options.y ?? 0),
    CTM_SHOT_WIDTH: String(options.width ?? 0),
    CTM_SHOT_HEIGHT: String(options.height ?? 0),
    CTM_SHOT_OUTPUT: tempPath,
  };

  try {
    const encoded = Buffer.from(POWERSHELL_SCRIPT, "utf16le").toString("base64");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { env, timeout: 20_000, maxBuffer: 1024 * 1024, windowsHide: true },
    );
    const metadata = JSON.parse(stdout.trim()) as {
      width: number;
      height: number;
      left: number;
      top: number;
      windowTitle?: string | null;
    };
    const image = await readFile(tempPath);
    if (image.byteLength > MAX_SCREENSHOT_BYTES) {
      throw new Error(`Screenshot PNG is too large (${image.byteLength} bytes, max ${MAX_SCREENSHOT_BYTES}). Capture a smaller region.`);
    }
    if (options.savePath) {
      await mkdir(dirname(options.savePath), { recursive: true });
      await writeFile(options.savePath, image);
    }
    return {
      data: image.toString("base64"),
      mimeType: "image/png",
      width: metadata.width,
      height: metadata.height,
      left: metadata.left,
      top: metadata.top,
      windowTitle: metadata.windowTitle ?? undefined,
      savedPath: options.savePath,
    };
  } finally {
    await rm(tempPath, { force: true }).catch(() => undefined);
  }
}
