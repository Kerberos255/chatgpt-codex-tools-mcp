import { readFileSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { assertNotDenied, isInsideRoot } from "./paths.js";

export interface PowerShellPolicyContext {
  cwd?: string;
  allowedRoots?: string[];
  denyGlobs?: string[];
}

const informative = new Set(["-version", "-v", "-help", "-?", "--help"]);
const allowedFlags = new Set([
  "-noprofile", "-nop", "-noninteractive", "-noni", "-nologo",
  "-executionpolicy", "-ep", "-inputformat", "-outputformat",
  "-sta", "-mta",
]);
const codeFlags = new Set(["-command", "-c", "-commandwithargs", "-encodedcommand", "-enc", "-e"]);
const fileFlags = new Set(["-file", "-f"]);

/**
 * A lightweight guard against obvious destructive PowerShell mistakes, not a
 * sandbox or proof that arbitrary script code is safe. Run only in full mode.
 */
export function assertPowerShellAllowed(args: string[], context: PowerShellPolicyContext = {}): void {
  if (args.length === 1 && informative.has(args[0].toLowerCase())) return;
  let index = 0;
  while (index < args.length) {
    const option = args[index].toLowerCase();
    if (allowedFlags.has(option)) {
      if (["-executionpolicy", "-ep", "-inputformat", "-outputformat"].includes(option)) {
        if (++index >= args.length) throw new Error(`PowerShell option ${option} needs a value.`);
      }
      index++;
      continue;
    }
    if (codeFlags.has(option)) {
      if (++index >= args.length) throw new Error("PowerShell -Command needs script content.");
      const raw = args.slice(index).join(" ");
      if (raw.trim() === "-") throw new Error("PowerShell -Command from standard input is unsupported; pass the script text explicitly.");
      if (option === "-encodedcommand" || option === "-enc" || option === "-e") {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(raw) || raw.length % 4 !== 0 || raw.length > 250_000) {
          throw new Error("PowerShell encoded command is malformed or too large.");
        }
        const buffer = Buffer.from(raw, "base64");
        if (buffer.length < 2 || buffer.length % 2 !== 0) {
          throw new Error("PowerShell encoded command must be UTF-16LE.");
        }
        assertPowerShellScriptSafe(buffer.toString("utf16le"));
      } else {
        assertPowerShellScriptSafe(raw);
      }
      return;
    }
    if (fileFlags.has(option)) {
      if (++index >= args.length) throw new Error("PowerShell -File needs a script path.");
      inspectScriptFile(args[index], context);
      return;
    }
    throw new Error("PowerShell needs an explicit -Command or -File (or -Version/-Help). Interactive and opaque invocation modes are not supported.");
  }
  throw new Error("PowerShell needs an explicit -Command or -File; interactive shells are not supported by exec.");
}

function inspectScriptFile(path: string, context: PowerShellPolicyContext): void {
  if (!context.cwd || !context.allowedRoots?.length) {
    throw new Error("PowerShell script execution requires verified workspace context.");
  }
  const absolute = resolve(context.cwd, path);
  if (!/\.ps1$/i.test(absolute)) throw new Error("PowerShell -File only supports .ps1 scripts.");
  const file = realpathSync(absolute);
  const roots = context.allowedRoots.map(root => {
    try { return realpathSync(root); } catch { return resolve(root); }
  });
  if (!roots.some(root => isInsideRoot(file, root))) {
    throw new Error("PowerShell script is outside configured allowed roots.");
  }
  const matchingRoot = roots.find(root => isInsideRoot(file, root))!;
  assertNotDenied(file, matchingRoot, context.denyGlobs ?? []);
  const info = statSync(file);
  if (!info.isFile() || info.size > 512 * 1024) {
    throw new Error("PowerShell script must be a regular file of at most 512 KiB.");
  }
  const bytes = readFileSync(file);
  let script: string;
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) script = bytes.subarray(2).toString("utf16le");
  else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) script = bytes.subarray(3).toString("utf8");
  else script = bytes.toString("utf8");
  assertPowerShellScriptSafe(script);
}

/** Return executable-looking code, ignoring comments and quoted argument text. */
function codeOnly(script: string): string {
  let output = "";
  let index = 0;
  let mode: "normal" | "single" | "double" | "comment" | "hereSingle" | "hereDouble" = "normal";
  while (index < script.length) {
    const ch = script[index];
    const next = script[index + 1];
    if (mode === "comment") {
      if (ch === "\n") { mode = "normal"; output += "\n"; }
      else output += " ";
      index++;
      continue;
    }
    if (mode === "hereSingle" || mode === "hereDouble") {
      const terminator = mode === "hereSingle" ? "'@" : '"@';
      if ((ch === "\n" || index === 0) && script.startsWith(terminator, index + (ch === "\n" ? 1 : 0))) {
        mode = "normal";
      }
      output += ch === "\n" ? "\n" : " ";
      index++;
      continue;
    }
    if (mode === "single") {
      if (ch === "'" && next === "'") { output += "  "; index += 2; continue; }
      if (ch === "'") mode = "normal";
      output += ch === "\n" ? "\n" : " ";
      index++;
      continue;
    }
    if (mode === "double") {
      if (ch === "`" && next) { output += "  "; index += 2; continue; }
      if (ch === '"') { mode = "normal"; output += " "; index++; continue; }
      if (ch === "$" && next === "(") {
        // Double-quoted strings execute $() subexpressions: inspect their code as well.
        output += ";";
        index += 2;
        let level = 1;
        while (index < script.length && level > 0) {
          const part = script[index];
          if (part === "(") level++;
          else if (part === ")") level--;
          if (level > 0) output += part;
          index++;
        }
        output += ";";
        continue;
      }
      output += ch === "\n" ? "\n" : " ";
      index++;
      continue;
    }
    if (ch === "#" && (index === 0 || /[\s;|({]/.test(script[index - 1]))) {
      mode = "comment"; output += " "; index++; continue;
    }
    if (ch === "@" && (next === "'" || next === '"')) {
      mode = next === "'" ? "hereSingle" : "hereDouble";
      output += "  "; index += 2; continue;
    }
    if ((ch === "'" || ch === '"') && /(?:^|[;|\n{}()])\s*[&.]\s*$/.test(output)) {
      // A literal command name following the invocation operator is executable
      // code, not a quoted output string. Preserve it for the policy check.
      let end = index + 1;
      let value = "";
      while (end < script.length && script[end] !== ch) {
        if (ch === "'" && script[end] === "'" && script[end + 1] === "'") { value += "'"; end += 2; continue; }
        if (script[end] === "`" && end + 1 < script.length) { value += script[end + 1]; end += 2; continue; }
        value += script[end++];
      }
      if (end < script.length && !value.includes("$")) {
        const executable = value.replace(/\\/g, "/").split("/").pop() ?? "";
        if (/^[a-zA-Z0-9_.-]+$/.test(executable)) {
          output += executable;
          index = end + 1;
          continue;
        }
      }
    }
    if (ch === "'") { mode = "single"; output += " "; index++; continue; }
    if (ch === '"') { mode = "double"; output += " "; index++; continue; }
    if (ch === "`" && next) { output += next === "\n" ? "" : next; index += 2; continue; }
    output += ch;
    index++;
  }
  return output;
}

const critical = new Set([
  "format", "format.com", "diskpart", "diskpart.exe",
  "format-volume", "clear-disk", "initialize-disk", "remove-partition",
  "stop-computer", "restart-computer", "disable-netadapter",
  "disable-windowsoptionalfeature", "disable-computerrestore",
  "invoke-expression", "iex",
]);

const deleteCommands = new Set(["remove-item", "rm", "del", "erase", "rmdir", "rd"]);

/**
 * Match commands in PowerShell statement position. Never classify a word within
 * a string, comment, regular file path or argument as a command.
 */
export function assertPowerShellScriptSafe(script: string): void {
  if (Buffer.byteLength(script, "utf8") > 512 * 1024) throw new Error("PowerShell script is too large to validate.");
  const code = codeOnly(script);
  const statements = code.split(/[;|\n{}]/);
  for (const raw of statements) {
    const item = raw.trim();
    if (!item) continue;
    // Common control-flow and assignment prefixes are not themselves commands.
    const starts = item.match(/(?:^|[=&(])\s*([\w.-]+)(?=\s|$|[()])/g) ?? [];
    for (const start of starts) {
      const name = start.replace(/^[=&(]\s*/, "").trim().toLowerCase();
      if (critical.has(name) || name === "cmd" || name === "cmd.exe" ||
          name === "shutdown" || name === "shutdown.exe") {
        throw new Error(`PowerShell operation is blocked as high risk: ${name}`);
      }
      if (deleteCommands.has(name)) {
        const recurse = /-(?:recurse|rec|r)(?=\s|$)/i.test(item);
        const force = /-(?:force|fo)(?=\s|$)/i.test(item);
        const whatIf = /-(?:whatif)(?=\s|$)/i.test(item);
        if (recurse && force && !whatIf) {
          throw new Error("PowerShell recursive forced deletion is blocked. Use narrower file edits or review the operation.");
        }
      }
    }
  }
}
