import test from "node:test";
import assert from "node:assert/strict";
import {validateScreenshot,parseScreenshotResponse,screenshotProcessError,validateScreenshotPNG} from "../src/screenshot.js";
import {NATIVE_SCREENSHOT_SOURCE,POWERSHELL_SCRIPT} from "../src/screenshot-native.js";

test("window crops use nonnegative relative physical pixels while screen regions allow negative monitor origins",()=>{
 assert.equal(validateScreenshot({mode:"window",windowHandle:1,width:400,height:250}),true);
 assert.equal(validateScreenshot({mode:"window",windowHandle:1,x:20,y:30,width:400,height:250}),true);
 assert.equal(validateScreenshot({mode:"window",windowTitle:"Fixture"}),false);
 assert.equal(validateScreenshot({mode:"region",x:-500,y:-10,width:400,height:250}),false);
 for(const request of [{mode:"window",windowHandle:1,x:-1,width:10,height:10},
  {mode:"window",windowHandle:1,x:10},{mode:"region",x:0,y:0,width:10},
  {mode:"desktop",width:10,height:10},{mode:"monitor",monitor:-1},
  {mode:"window",windowTitle:" "},{mode:"window",windowHandle:0},
  {mode:"region",x:0,y:0,width:10000,height:10000},{mode:"region",x:NaN,y:0,width:10,height:10}])
   assert.throws(()=>validateScreenshot(request as any),{code:"INVALID_REQUEST"});
});
test("BitBlt access failure on Default is distinct from confirmed desktop unavailability",()=>{
 const response={ok:false,error:{code:"CAPTURE_FAILED",stage:"BitBlt",win32Error:5,
  message:"Unlock your PC; SECRET_ENCODED_COMMAND",diagnostics:{inputDesktop:"Default",threadDesktop:"Default",session:1,consoleSession:40}}};
 assert.throws(()=>parseScreenshotResponse(JSON.stringify(response)),(error: any)=>{
   assert.equal(error.code,"CAPTURE_FAILED");assert.match(error.message,/BitBlt/);assert.match(error.message,/Win32=5/);
   assert.match(error.message,/inputDesktop=Default/);assert.doesNotMatch(error.message,/Unlock|SECRET_ENCODED/);return true;
 });
 response.error.code="DESKTOP_UNAVAILABLE";response.error.stage="OpenInputDesktop";response.error.diagnostics.inputDesktop="Winlogon";
 assert.throws(()=>parseScreenshotResponse(JSON.stringify(response)),{code:"DESKTOP_UNAVAILABLE"});
});
test("child process failures expose bounded errors without command, stderr, environment or output",()=>{
 for(const [value,code] of [[{code:"ENOENT"},"CAPTURE_RUNTIME_MISSING"],[{killed:true},"CAPTURE_TIMEOUT"],
  [{code:1,message:"-EncodedCommand PRIVATE",stderr:"PRIVATE",env:{key:"PRIVATE"}},"CAPTURE_PROCESS_FAILED"]] as const){
  const error=screenshotProcessError(value);assert.equal(error.code,code);assert.doesNotMatch(error.message,/PRIVATE|EncodedCommand/);
 }
 assert.throws(()=>parseScreenshotResponse('{"secret":"PRIVATE"}'),(error: any)=>!error.message.includes("PRIVATE"));
 assert.throws(()=>parseScreenshotResponse("not json"),{code:"INVALID_CAPTURE_RESULT"});
});
test("capture metadata rejects bad geometry and PNG size mismatches",()=>{
 const metadata={width:1,height:1,left:-100,top:0,method:"PrintWindow",dpiMode:"per-monitor-v2"} as const;
 assert.deepEqual(parseScreenshotResponse(JSON.stringify({ok:true,metadata})),metadata);
 const image=Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a/dsAAAAASUVORK5CYII=","base64");
 validateScreenshotPNG(image,metadata);
 assert.throws(()=>validateScreenshotPNG(image,{...metadata,width:2}),{code:"INVALID_CAPTURE_RESULT"});
 assert.throws(()=>validateScreenshotPNG(Buffer.from("not png"),metadata),{code:"INVALID_CAPTURE_RESULT"});
 for(const delta of [{width:0},{height:1000000},{left:0.5},{method:"unknown"},{dpiMode:"unaware"}])
  assert.throws(()=>parseScreenshotResponse(JSON.stringify({ok:true,metadata:{...metadata,...delta}})),{code:"INVALID_CAPTURE_RESULT"});
});
test("the trusted wrapper embeds the same capture core tested on Windows",()=>{
 assert(POWERSHELL_SCRIPT.includes(NATIVE_SCREENSHOT_SOURCE));
 assert(!NATIVE_SCREENSHOT_SOURCE.includes("SwitchDesktop("));
});
