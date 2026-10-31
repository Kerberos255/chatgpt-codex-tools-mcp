import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { POWERSHELL_SCRIPT } from "./screenshot-native.js";

const execFileAsync = promisify(execFile);
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_PIXELS = 50_000_000;
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
export interface ScreenshotMetadata {
  width: number;
  height: number;
  left: number;
  top: number;
  windowTitle?: string;
  method: "PrintWindow" | "BitBlt";
  dpiMode: "per-monitor-v2" | "system-aware";
}
export interface ScreenshotResult extends ScreenshotMetadata {
  data: string;
  mimeType: "image/png";
  savedPath?: string;
}
export class ScreenshotError extends Error {
  constructor(public readonly code: string, message: string) { super(`[${code}] ${message}`); this.name="ScreenshotError"; }
}
function invalid(message: string): never { throw new ScreenshotError("INVALID_REQUEST",message); }
export function validateScreenshot(options: ScreenshotOptions): boolean {
  if (!["desktop","monitor","window","region"].includes(options.mode)) invalid("Unsupported screenshot mode.");
  for (const key of ["x","y","width","height","monitor","windowHandle"] as const) {
    const value=options[key];
    if (value!==undefined && (!Number.isSafeInteger(value) || key!=="windowHandle" && (value < -2147483648 || value > 2147483647))) invalid(`${key} must be an integer in range.`);
  }
  if (options.monitor!==undefined && options.monitor<0) invalid("monitor must be non-negative.");
  if (options.windowHandle!==undefined && options.windowHandle<=0) invalid("windowHandle must be positive.");
  if (options.windowTitle!==undefined && (!options.windowTitle.trim() || options.windowTitle.length>2048)) invalid("windowTitle must be non-empty and at most 2048 characters.");
  const crop=[options.x,options.y,options.width,options.height].some(value=>value!==undefined);
  if (options.mode==="window" && !options.windowHandle && !options.windowTitle) invalid("windowTitle or windowHandle is required for window mode.");
  if (options.mode==="region" && [options.x,options.y,options.width,options.height].some(value=>value===undefined)) invalid("x, y, width, and height are required for region mode.");
  if (crop && options.mode!=="region" && options.mode!=="window") invalid("Crop coordinates are supported only for window and region modes.");
  if (crop && (options.width===undefined || options.height===undefined)) invalid("Both width and height are required for a crop.");
  if (options.mode==="window" && crop && ((options.x??0)<0 || (options.y??0)<0)) invalid("Window crop coordinates must be non-negative offsets from the window.");
  if (options.width!==undefined && (options.width<=0 || options.width>20000) || options.height!==undefined && (options.height<=0 || options.height>20000) ||
      options.width!==undefined && options.height!==undefined && options.width*options.height>MAX_PIXELS) invalid("Capture dimensions must be positive and at most 50 million pixels.");
  return options.mode==="window" && crop;
}

// Never expose child_process's error message: it includes the encoded command.
export function screenshotProcessError(error: unknown): ScreenshotError {
  const value=error as {code?: unknown;killed?: unknown};
  if (value?.code==="ENOENT") return new ScreenshotError("CAPTURE_RUNTIME_MISSING","Windows PowerShell could not be started.");
  if (value?.killed || value?.code==="ETIMEDOUT") return new ScreenshotError("CAPTURE_TIMEOUT","Windows screenshot timed out.");
  return new ScreenshotError("CAPTURE_PROCESS_FAILED","Windows screenshot process failed before returning a result.");
}
const FAILURE_MESSAGES: Record<string,string> = {
  DESKTOP_UNAVAILABLE:"The current input desktop is inaccessible or differs from this process's desktop; capture was not attempted.",
  CAPTURE_FAILED:"Windows capture failed.",
  WINDOW_NOT_FOUND:"No matching window exists in this process's session.",
  AMBIGUOUS_WINDOW:"Several windows matched; specify windowHandle.",
  WINDOW_UNAVAILABLE:"The selected window is hidden or minimized.",
  INVALID_BOUNDS:"The requested physical-pixel capture bounds are invalid or outside the selected surface.",
  INVALID_REQUEST:"The screenshot request is invalid.",
  DPI_UNAVAILABLE:"Physical-pixel DPI awareness could not be enabled.",
  CAPTURE_INITIALIZATION_FAILED:"Windows screenshot initialization failed.",
};
export function parseScreenshotResponse(stdout: string): ScreenshotMetadata {
  let result: any;
  try { result=JSON.parse(stdout.trim()); } catch { throw new ScreenshotError("INVALID_CAPTURE_RESULT","Windows screenshot returned an invalid result."); }
  if (result?.ok!==true) {
    const failure=result?.error;
    const code=Object.hasOwn(FAILURE_MESSAGES,failure?.code??"")?failure.code:"INVALID_CAPTURE_RESULT";
    const stage=["OpenInputDesktop","PrintWindow","BitBlt","GetDC","GetWindowRect","dpi","bounds","crop","window","region","monitor","mode","initialization"].includes(failure?.stage)?failure.stage:undefined;
    const win32=Number.isSafeInteger(failure?.win32Error)&&failure.win32Error>=0?failure.win32Error:undefined;
    const desktop=failure?.diagnostics;
    const desktopName=(value: unknown)=>typeof value==="string" && /^[\w .-]{1,64}$/u.test(value)?value:undefined;
    const details=[stage?`stage=${stage}`:null,win32!==undefined?`Win32=${win32}`:null,
      desktopName(desktop?.inputDesktop)?`inputDesktop=${desktopName(desktop.inputDesktop)}`:null,
      desktopName(desktop?.threadDesktop)?`threadDesktop=${desktopName(desktop.threadDesktop)}`:null,
      Number.isSafeInteger(desktop?.session)?`session=${desktop.session}`:null].filter(Boolean).join(", ");
    throw new ScreenshotError(code,(FAILURE_MESSAGES[code]??"Windows screenshot returned an invalid result.")+(details?` (${details})`:""));
  }
  const m=result.metadata;
  if (!m || ![m.width,m.height,m.left,m.top].every(Number.isSafeInteger) || m.width<=0 || m.height<=0 ||
      m.width>20000 || m.height>20000 || m.width*m.height>MAX_PIXELS || !["PrintWindow","BitBlt"].includes(m.method) ||
      !["per-monitor-v2","system-aware"].includes(m.dpiMode)) throw new ScreenshotError("INVALID_CAPTURE_RESULT","Windows screenshot returned invalid geometry or capture metadata.");
  return {width:m.width,height:m.height,left:m.left,top:m.top,method:m.method,dpiMode:m.dpiMode,
    ...(typeof m.windowTitle==="string" ? {windowTitle:m.windowTitle.slice(0,2048)} : {})};
}
export function validateScreenshotPNG(image: Buffer, metadata: ScreenshotMetadata): void {
  if (image.byteLength>MAX_SCREENSHOT_BYTES) throw new ScreenshotError("CAPTURE_TOO_LARGE","Screenshot PNG exceeds 16 MiB; capture a smaller area.");
  if (image.byteLength<33 || !image.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
      image.toString("ascii",12,16)!=="IHDR" || image.readUInt32BE(16)!==metadata.width || image.readUInt32BE(20)!==metadata.height)
    throw new ScreenshotError("INVALID_CAPTURE_RESULT","Screenshot PNG dimensions do not match the physical-pixel capture metadata.");
}
export async function captureScreenshot(options: ScreenshotOptions): Promise<ScreenshotResult> {
  const crop=validateScreenshot(options);
  if (process.platform!=="win32") throw new ScreenshotError("UNSUPPORTED_PLATFORM","screenshot is currently supported on Windows only.");
  const temporary=await mkdtemp(join(tmpdir(),"ctm-screenshot-"));
  const tempPath=join(temporary,`${randomUUID()}.png`),scriptPath=join(temporary,"capture.ps1");
  const env={...process.env,CTM_SHOT_MODE:options.mode,CTM_SHOT_MONITOR:String(options.monitor??0),
    CTM_SHOT_WINDOW_TITLE:options.windowTitle??"",CTM_SHOT_WINDOW_HANDLE:String(options.windowHandle??0),
    CTM_SHOT_CROP:crop?"1":"0",CTM_SHOT_X:String(options.x??0),CTM_SHOT_Y:String(options.y??0),
    CTM_SHOT_WIDTH:String(options.width??0),CTM_SHOT_HEIGHT:String(options.height??0),CTM_SHOT_OUTPUT:tempPath};
  try {
    let stdout: string;
    await writeFile(scriptPath,POWERSHELL_SCRIPT,{flag:"wx",mode:0o600});
    try {
      ({stdout}=await execFileAsync("powershell.exe",["-NoProfile","-NonInteractive","-ExecutionPolicy","Bypass","-File",scriptPath],
        {env,timeout:20_000,maxBuffer:1024*1024,windowsHide:true}));
    } catch (error) { throw screenshotProcessError(error); }
    const metadata=parseScreenshotResponse(stdout);
    let image: Buffer;
    try { image=await readFile(tempPath); } catch { throw new ScreenshotError("INVALID_CAPTURE_RESULT","Windows screenshot did not produce a readable PNG."); }
    validateScreenshotPNG(image,metadata);
    if (options.savePath) { await mkdir(dirname(options.savePath),{recursive:true}); await writeFile(options.savePath,image); }
    return {...metadata,data:image.toString("base64"),mimeType:"image/png",savedPath:options.savePath};
  } finally { await rm(temporary,{force:true,recursive:true}).catch(()=>undefined); }
}
