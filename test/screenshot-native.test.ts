import test from "node:test";
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NATIVE_SCREENSHOT_SOURCE,POWERSHELL_SCRIPT} from "../src/screenshot-native.js";

// Exercise the same native capture code without an arbitrary PowerShell command.
// All captured pixels belong to our temporary fixture window.
test("native DPI, crop, desktop-state and failure behavior",{skip:process.platform!=="win32"},()=>{
 const directory=mkdtempSync(join(tmpdir(),"ctm-shot-native-test-"));
 const source=join(directory,"Fixture.cs"),exe=join(directory,"Fixture.exe"),report=join(directory,"result.txt"),wrapper=join(directory,"capture.ps1");
 try{
  writeFileSync(source,NATIVE_SCREENSHOT_SOURCE+String.raw`
public sealed class CtmFixture : Form {
  protected override void OnPaint(PaintEventArgs e) {
    e.Graphics.Clear(Color.FromArgb(31,117,196));
    e.Graphics.FillRectangle(Brushes.Magenta,ClientSize.Width-40,ClientSize.Height-40,40,40);
  }
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out CtmScreenshot.RECT rect);
  [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref Point point);
  static void Check(bool value, string message) { if (!value) throw new Exception(message); }
  [STAThread] static void Main(string[] args) {
    var automation=System.Reflection.Assembly.Load("System.Management.Automation, Version=3.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35");
    var parser=automation.GetType("System.Management.Automation.Language.Parser");
    object[] parsed={System.IO.File.ReadAllText(args[1]),null,null};
    foreach (var method in parser.GetMethods()) if (method.Name=="ParseInput" && method.GetParameters().Length==3) { method.Invoke(null,parsed); break; }
    Check(parsed[2]!=null && ((Array)parsed[2]).Length==0,"PowerShell wrapper syntax errors");
    var remote=new CtmDesktopInfo {inputDesktop="Default",threadDesktop="Default",session=1,consoleSession=40};
    CtmScreenshot.CheckDesktop(remote);
    var failed=CtmScreenshot.CaptureFailure("BitBlt",5,remote);
    Check(failed.code=="CAPTURE_FAILED" && !failed.Message.Contains("Unlock"),"incorrect lock diagnosis");
    try { CtmScreenshot.CheckDesktop(new CtmDesktopInfo {inputDesktop="Winlogon",threadDesktop="Default"}); throw new Exception("secure desktop accepted"); }
    catch (CtmCaptureException e) { Check(e.code=="DESKTOP_UNAVAILABLE","wrong desktop error"); }
    Check(CtmScreenshot.WindowCrop(1941,1243,true,100,120,800,600).Width==800,"wrong crop");
    try { CtmScreenshot.WindowCrop(1941,1243,true,1900,0,100,100); throw new Exception("outside crop accepted"); }
    catch (CtmCaptureException e) { Check(e.code=="INVALID_BOUNDS","wrong bounds error"); }
    var desktop=CtmScreenshot.DesktopInfo();
    try { CtmScreenshot.CheckDesktop(desktop); }
    catch (CtmCaptureException) { System.IO.File.WriteAllText(args[0],"state-and-bounds=passed;pixels=skipped-desktop-unavailable"); return; }
    IntPtr previous=SetThreadDpiAwarenessContext(new IntPtr(-4));
    try {
      using (var form=new CtmFixture()) {
        form.Text="CTM screenshot acceptance fixture"; form.StartPosition=FormStartPosition.Manual;
        form.Location=new Point(140,140); form.ClientSize=new Size(730,490);
        form.Show(); form.Refresh(); Application.DoEvents();
        CtmScreenshot.RECT rect; Check(GetWindowRect(form.Handle,out rect),"fixture bounds unavailable");
        string full=System.IO.Path.Combine(System.IO.Path.GetDirectoryName(args[0]),"full.png");
        string crop=System.IO.Path.Combine(System.IO.Path.GetDirectoryName(args[0]),"crop.png");
        var result=CtmScreenshot.Capture("window",0,form.Handle.ToInt64(),null,false,0,0,0,0,full);
        Check(result.width==rect.Right-rect.Left && result.height==rect.Bottom-rect.Top,"DPI dimensions were virtualized");
        var pixel=new Point(form.ClientSize.Width-10,form.ClientSize.Height-10); ClientToScreen(form.Handle,ref pixel);
        using (var image=new Bitmap(full)) {
          Check(image.Width==result.width && image.Height==result.height,"PNG geometry mismatch");
          Color color=image.GetPixel(pixel.X-rect.Left,pixel.Y-rect.Top);
          Check(color.R>240 && color.G<15 && color.B>240 && color.A==255,"bottom-right pixel clipped or transparent");
        }
        var clipped=CtmScreenshot.Capture("window",0,form.Handle.ToInt64(),null,true,pixel.X-rect.Left-5,pixel.Y-rect.Top-5,10,10,crop);
        Check(clipped.width==10 && clipped.height==10 && clipped.left==pixel.X-5 && clipped.top==pixel.Y-5,"relative crop origin incorrect");
        using (var image=new Bitmap(crop)) Check(image.GetPixel(5,5).R>240 && image.GetPixel(5,5).B>240,"crop pixels incorrect");
        try { CtmScreenshot.Capture("window",0,123,null,false,0,0,0,0,full); throw new Exception("invalid handle accepted"); }
        catch (CtmCaptureException e) { Check(e.code=="WINDOW_NOT_FOUND","wrong invalid handle error"); }
        System.IO.File.WriteAllText(args[0],"wrapper-syntax=passed;state-and-bounds=passed;pixels=passed;full="+result.width+"x"+result.height+";crop=10x10;dpi="+result.dpiMode);
        form.Close();
      }
    } finally { if (previous!=IntPtr.Zero) SetThreadDpiAwarenessContext(previous); }
  }
}
`);
  const compiler=join(process.env.WINDIR??"C:\\Windows","Microsoft.NET","Framework64","v4.0.30319","csc.exe");
  writeFileSync(wrapper,POWERSHELL_SCRIPT);
  execFileSync(compiler,["/nologo","/target:exe",`/out:${exe}`,"/reference:System.Drawing.dll","/reference:System.Windows.Forms.dll",source],{windowsHide:true,timeout:30_000});
  execFileSync(exe,[report,wrapper],{windowsHide:false,timeout:20_000});
  const result=readFileSync(report,"utf8");assert.match(result,/state-and-bounds=passed/);console.log(result);
 }finally{rmSync(directory,{recursive:true,force:true});}
});
