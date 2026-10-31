// Shared by the trusted screenshot wrapper and native Windows fixture tests.
// This code never switches desktops, changes privileges or bypasses capture protection.
export const NATIVE_SCREENSHOT_SOURCE = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;
using System.Windows.Forms;

public sealed class CtmDesktopInfo {
  public string inputDesktop;
  public string threadDesktop;
  public int session;
  public uint consoleSession;
  public int desktopError;
}
public sealed class CtmCaptureException : Exception {
  public string code;
  public string stage;
  public int win32Error;
  public CtmDesktopInfo diagnostics;
  public CtmCaptureException(string code, string stage, string message, int error, CtmDesktopInfo info) : base(message) {
    this.code=code; this.stage=stage; this.win32Error=error; this.diagnostics=info;
  }
}
public sealed class CtmShotMetadata {
  public int width;
  public int height;
  public int left;
  public int top;
  public string windowTitle;
  public string method;
  public string dpiMode;
}
public static class CtmScreenshot {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr parameter);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetProcessDPIAware();
  [DllImport("user32.dll", SetLastError=true)] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", SetLastError=true)] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool ProcessIdToSessionId(uint pid, out uint session);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int capacity);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr GetDC(IntPtr hwnd);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr hwnd, IntPtr dc);
  [DllImport("user32.dll", SetLastError=true)] static extern bool PrintWindow(IntPtr hwnd, IntPtr dc, uint flags);
  [DllImport("gdi32.dll", SetLastError=true)] static extern bool BitBlt(IntPtr dest, int x, int y, int width, int height, IntPtr src, int sx, int sy, uint operation);
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  [DllImport("kernel32.dll")] static extern uint WTSGetActiveConsoleSessionId();
  [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle, int index, StringBuilder value, int capacity, out int needed);

  static string DesktopName(IntPtr handle) {
    if (handle==IntPtr.Zero) return null;
    int needed; var value=new StringBuilder(256);
    return GetUserObjectInformation(handle,2,value,value.Capacity*2,out needed) ? value.ToString() : null;
  }
  public static CtmDesktopInfo DesktopInfo() {
    var info=new CtmDesktopInfo { session=Process.GetCurrentProcess().SessionId, consoleSession=WTSGetActiveConsoleSessionId() };
    info.threadDesktop=DesktopName(GetThreadDesktop(GetCurrentThreadId()));
    IntPtr input=OpenInputDesktop(0,false,0x0001);
    if (input==IntPtr.Zero) info.desktopError=Marshal.GetLastWin32Error();
    else { try { info.inputDesktop=DesktopName(input); } finally { CloseDesktop(input); } }
    return info;
  }
  public static void CheckDesktop(CtmDesktopInfo info) {
    if (info.desktopError!=0 || String.IsNullOrEmpty(info.inputDesktop))
      throw new CtmCaptureException("DESKTOP_UNAVAILABLE","OpenInputDesktop","The current input desktop could not be inspected; capture was not attempted.",info.desktopError,info);
    if (!String.Equals(info.inputDesktop,info.threadDesktop,StringComparison.OrdinalIgnoreCase))
      throw new CtmCaptureException("DESKTOP_UNAVAILABLE","OpenInputDesktop","The input desktop differs from this process's desktop; capture was not attempted.",0,info);
    // A remote session may legitimately differ from the console session. That is not a lock signal.
  }
  public static CtmCaptureException CaptureFailure(string method, int error, CtmDesktopInfo info) {
    return new CtmCaptureException("CAPTURE_FAILED",method,method+" failed (Win32 error "+error+"). Desktop accessibility and capture failure are separate conditions.",error,info);
  }
  static void Bounds(int width, int height) {
    if (width<=0 || height<=0 || width>20000 || height>20000 || (long)width*height>50000000)
      throw new CtmCaptureException("INVALID_BOUNDS","bounds","Capture dimensions must be positive and at most 50 million pixels.",0,null);
  }
  public static Rectangle WindowCrop(int fullWidth, int fullHeight, bool crop, int x, int y, int width, int height) {
    Bounds(fullWidth,fullHeight);
    if (!crop) return new Rectangle(0,0,fullWidth,fullHeight);
    Bounds(width,height);
    if (x<0 || y<0 || (long)x+width>fullWidth || (long)y+height>fullHeight)
      throw new CtmCaptureException("INVALID_BOUNDS","crop","Window crop must fit inside the selected window in physical pixels.",0,null);
    return new Rectangle(x,y,width,height);
  }
  static bool SameSession(IntPtr hwnd, int session) {
    uint pid, owner; GetWindowThreadProcessId(hwnd,out pid);
    return pid!=0 && ProcessIdToSessionId(pid,out owner) && owner==(uint)session;
  }
  static string Title(IntPtr hwnd) {
    var value=new StringBuilder(2048); GetWindowText(hwnd,value,value.Capacity); return value.ToString();
  }
  static IntPtr FindWindow(long handle, string title, CtmDesktopInfo info) {
    IntPtr selected=new IntPtr(handle);
    if (handle==0) {
      var matches=new List<IntPtr>();
      EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
        if (IsWindowVisible(hwnd) && SameSession(hwnd,info.session) && Title(hwnd).IndexOf(title,StringComparison.OrdinalIgnoreCase)>=0) matches.Add(hwnd);
        return true;
      },IntPtr.Zero);
      if (matches.Count!=1)
        throw new CtmCaptureException(matches.Count==0?"WINDOW_NOT_FOUND":"AMBIGUOUS_WINDOW","window",matches.Count==0?"No visible window in this session matched the requested title.":"Several windows matched; specify windowHandle to select one.",0,info);
      selected=matches[0];
    }
    if (!IsWindow(selected) || !SameSession(selected,info.session))
      throw new CtmCaptureException("WINDOW_NOT_FOUND","window","The requested window does not exist in this process's session.",0,info);
    if (!IsWindowVisible(selected) || IsIconic(selected))
      throw new CtmCaptureException("WINDOW_UNAVAILABLE","window","The requested window is hidden or minimized; window capture was not attempted.",0,info);
    return selected;
  }
  public static CtmShotMetadata Capture(string mode, int monitor, long handle, string title, bool crop, int x, int y, int width, int height, string output) {
    IntPtr previous=IntPtr.Zero;
    string dpiMode="per-monitor-v2";
    try {
      try {
        previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previous==IntPtr.Zero) throw new CtmCaptureException("DPI_UNAVAILABLE","dpi","Could not enable physical-pixel DPI awareness.",Marshal.GetLastWin32Error(),null);
      } catch (EntryPointNotFoundException) {
        if (!SetProcessDPIAware()) throw new CtmCaptureException("DPI_UNAVAILABLE","dpi","Could not enable DPI awareness on this Windows version.",Marshal.GetLastWin32Error(),null);
        dpiMode="system-aware";
      }
      var info=DesktopInfo(); CheckDesktop(info);
      Rectangle bounds; IntPtr window=IntPtr.Zero; string matchedTitle=null;
      Rectangle selection=Rectangle.Empty;
      if (mode=="window") {
        if (handle==0 && String.IsNullOrWhiteSpace(title)) throw new CtmCaptureException("INVALID_REQUEST","window","windowTitle or windowHandle is required.",0,info);
        window=FindWindow(handle,title,info); RECT rect;
        if (!GetWindowRect(window,out rect)) throw CaptureFailure("GetWindowRect",Marshal.GetLastWin32Error(),info);
        bounds=Rectangle.FromLTRB(rect.Left,rect.Top,rect.Right,rect.Bottom);
        selection=WindowCrop(bounds.Width,bounds.Height,crop,x,y,width,height);
        matchedTitle=Title(window);
      } else {
        if (mode=="desktop") bounds=SystemInformation.VirtualScreen;
        else if (mode=="monitor") {
          var screens=Screen.AllScreens;
          if (monitor<0 || monitor>=screens.Length) throw new CtmCaptureException("INVALID_BOUNDS","monitor","Monitor index is out of range.",0,info);
          bounds=screens[monitor].Bounds;
        } else if (mode=="region") {
          Bounds(width,height); bounds=new Rectangle(x,y,width,height);
          var desktop=SystemInformation.VirtualScreen;
          if (x<desktop.Left || y<desktop.Top || (long)x+width>desktop.Right || (long)y+height>desktop.Bottom)
            throw new CtmCaptureException("INVALID_BOUNDS","region","Screen region must fit inside the virtual desktop in physical pixels.",0,info);
        } else throw new CtmCaptureException("INVALID_REQUEST","mode","Unsupported capture mode.",0,info);
      }
      Bounds(bounds.Width,bounds.Height);
      using (var bitmap=new Bitmap(bounds.Width,bounds.Height,PixelFormat.Format24bppRgb)) {
        using (var graphics=Graphics.FromImage(bitmap)) {
          IntPtr dc=graphics.GetHdc();
          try {
            if (window!=IntPtr.Zero) {
              // Window capture has no dependency on the screen DC and never falls back to the whole desktop.
              if (!PrintWindow(window,dc,2)) throw CaptureFailure("PrintWindow",Marshal.GetLastWin32Error(),info);
            } else {
              IntPtr screen=GetDC(IntPtr.Zero);
              if (screen==IntPtr.Zero) throw CaptureFailure("GetDC",Marshal.GetLastWin32Error(),info);
              try {
                if (!BitBlt(dc,0,0,bounds.Width,bounds.Height,screen,bounds.Left,bounds.Top,0x40CC0020))
                  throw CaptureFailure("BitBlt",Marshal.GetLastWin32Error(),info);
              } finally { ReleaseDC(IntPtr.Zero,screen); }
            }
          } finally { graphics.ReleaseHdc(dc); }
        }
        if (crop && window!=IntPtr.Zero) {
          using (var clipped=bitmap.Clone(selection,PixelFormat.Format24bppRgb)) clipped.Save(output,ImageFormat.Png);
        } else bitmap.Save(output,ImageFormat.Png);
      }
      return new CtmShotMetadata {
        width=window!=IntPtr.Zero?selection.Width:bounds.Width,height=window!=IntPtr.Zero?selection.Height:bounds.Height,
        left=bounds.Left+(window!=IntPtr.Zero?selection.Left:0),top=bounds.Top+(window!=IntPtr.Zero?selection.Top:0),
        windowTitle=matchedTitle,method=window!=IntPtr.Zero?"PrintWindow":"BitBlt",dpiMode=dpiMode
      };
    } finally { if (previous!=IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
}
`;

export const POWERSHELL_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -ReferencedAssemblies System.Drawing,System.Windows.Forms -TypeDefinition @'
` + NATIVE_SCREENSHOT_SOURCE + String.raw`
'@
  $metadata = [CtmScreenshot]::Capture($env:CTM_SHOT_MODE, [int]$env:CTM_SHOT_MONITOR,
    [long]$env:CTM_SHOT_WINDOW_HANDLE, $env:CTM_SHOT_WINDOW_TITLE, ($env:CTM_SHOT_CROP -eq "1"),
    [int]$env:CTM_SHOT_X, [int]$env:CTM_SHOT_Y, [int]$env:CTM_SHOT_WIDTH, [int]$env:CTM_SHOT_HEIGHT, $env:CTM_SHOT_OUTPUT)
  @{ok=$true;metadata=$metadata} | ConvertTo-Json -Depth 5 -Compress
} catch {
  $failure=$_.Exception
  while ($failure.InnerException) { $failure=$failure.InnerException }
  if ($failure.GetType().FullName -eq "CtmCaptureException") {
    @{ok=$false;error=@{code=$failure.code;stage=$failure.stage;message=$failure.Message;win32Error=$failure.win32Error;diagnostics=$failure.diagnostics}} | ConvertTo-Json -Depth 5 -Compress
  } else {
    @{ok=$false;error=@{code="CAPTURE_INITIALIZATION_FAILED";stage="initialization";message="Windows screenshot initialization failed."}} | ConvertTo-Json -Compress
  }
}
`;
