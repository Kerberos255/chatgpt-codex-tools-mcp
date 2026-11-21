import { open, opendir, lstat, stat, readdir, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { Config } from "./config.js";
import { splitGlobPatterns, type GlobMatcher } from "./globs.js";
import { assertNotDenied, isInsideRoot, relativeDisplayPath } from "./paths.js";
import { parseRipgrepOutputPath, normalizeRipgrepOutputLine } from "./ripgrep-output.js";
import { runProcess } from "./process-runner.js";
import { capText, truncateUtf8 } from "./text.js";

const OMIT_DIRS = new Set(["node_modules", "dist", ".git"]);

function allowedEntry(name: string, path: string, root: string, denyGlobs: string[]): boolean {
  if (OMIT_DIRS.has(name)) return false;
  try { assertNotDenied(path, root, denyGlobs); return true; }
  catch { return false; }
}

/** Stream directory entries; avoid an additional stat for every ordinary file. */
async function* walkFiles(
  root: string,
  start: string,
  denyGlobs: string[],
  exclude: GlobMatcher | null = null,
): AsyncGenerator<{ path: string; relPath: string }> {
  const canonicalRoot = await realpath(root);
  async function* walkDirectory(path: string): AsyncGenerator<{ path: string; relPath: string }> {
    let directory;
    let canonical: string;
    try {
      canonical = await realpath(path);
      if (!isInsideRoot(canonical, canonicalRoot)) return;
      assertNotDenied(canonical, canonicalRoot, denyGlobs);
      directory = await opendir(path);
    } catch { return; }
    // Breaking out of the async iterator closes the directory handle automatically.
    for await (const entry of directory) {
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (!allowedEntry(entry.name, child, root, denyGlobs)) continue;
      if ((canonical !== path || canonicalRoot !== root) &&
          !allowedEntry(entry.name, join(canonical, entry.name), canonicalRoot, denyGlobs)) continue;
      const relPath = relativeDisplayPath(root, child);
      if (exclude?.(relPath)) continue;
      if (entry.isDirectory()) yield* walkDirectory(child);
      else if (entry.isFile()) yield { path: child, relPath };
    }
  }
  try {
    assertNotDenied(start, root, denyGlobs);
    const canonicalStart = await realpath(start);
    if (!isInsideRoot(canonicalStart, canonicalRoot)) return;
    assertNotDenied(canonicalStart, canonicalRoot, denyGlobs);
    // Explicitly selected, validated workspace-internal links remain supported.
    const info = await stat(start);
    if (info.isDirectory()) yield* walkDirectory(start);
    else if (info.isFile() && !exclude?.(relativeDisplayPath(root, start))) {
      yield { path: start, relPath: relativeDisplayPath(root, start) };
    }
  } catch (error) {
    // A changing or unreadable subtree must not hide unexpected programming errors.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || (error as Error).name === "AccessDeniedError") return;
    throw error;
  }
}

export async function readFileCapped(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const handle = await open(path, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error("Only regular files can be read.");
    const limit = Math.min(info.size, maxBytes);
    const buffer = Buffer.alloc(limit);
    let received = 0;
    while (received < limit) {
      const value = await handle.read(buffer, received, limit - received, received);
      if (!value.bytesRead) break;
      received += value.bytesRead;
    }
    const truncated = info.size > received;
    return { text: (truncated ? truncateUtf8(buffer.subarray(0, received), received) : buffer.subarray(0, received).toString("utf8")) + (truncated ? "\n[file truncated]\n" : ""), truncated };
  } finally { await handle.close(); }
}

export async function searchTextFiles(
  config: Config,
  workspaceRoot: string,
  startPath: string,
  pattern: string,
  caseSensitive: boolean,
  contextLines: number,
  maxMatches: number,
  includePatternText: string | undefined,
  excludePatternText: string | undefined,
  includeMatcher: GlobMatcher | null,
  excludeMatcher: GlobMatcher | null,
): Promise<string> {
  const ripgrepOutput = await searchTextFilesWithRipgrep(
    config,
    workspaceRoot,
    startPath,
    pattern,
    caseSensitive,
    contextLines,
    maxMatches,
    includePatternText,
    excludePatternText,
  );
  if (ripgrepOutput !== null) return ripgrepOutput;
  return searchTextFilesFallback(config, workspaceRoot, startPath, pattern, caseSensitive,
    contextLines, maxMatches, includeMatcher, excludeMatcher);
}

export async function searchTextFilesFallback(
  config: Config,
  workspaceRoot: string,
  startPath: string,
  pattern: string,
  caseSensitive: boolean,
  contextLines: number,
  maxMatches: number,
  includeMatcher: GlobMatcher | null,
  excludeMatcher: GlobMatcher | null,
): Promise<string> {
  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const canonicalRoot = await realpath(workspaceRoot);
  const lines: string[] = [];
  let outputBytes = 0;

  for await (const { path, relPath } of walkFiles(workspaceRoot, startPath, config.denyGlobs, excludeMatcher)) {
    if (lines.length >= maxMatches || outputBytes > config.maxOutputBytes) break;
    if (includeMatcher && !includeMatcher(relPath)) continue;
    let text: string;
    try {
      const canonical = await realpath(path);
      if (!isInsideRoot(canonical, canonicalRoot)) continue;
      assertNotDenied(canonical, canonicalRoot, config.denyGlobs);
      const data = await readFileCapped(path, Math.min(config.maxReadBytes, 128_000));
      text = data.truncated ? data.text.replace(/\n\[file truncated\]\n$/, "") : data.text;
    } catch {
      continue;
    }

    const fileLines = text.split(/\r?\n/);

    for (let index = 0; index < fileLines.length && lines.length < maxMatches && outputBytes <= config.maxOutputBytes; index++) {
      const line = fileLines[index];
      const matchTarget = caseSensitive ? line : line.toLowerCase();
      const matchResult = matchTarget.includes(needle);

      if (matchResult) {
        const displayLine = line.length > 300 ? `${line.slice(0, 300)}...` : line;

        if (contextLines > 0) {
          const contextStart = Math.max(0, index - contextLines);
          const contextEnd = Math.min(fileLines.length - 1, index + contextLines);
          if (contextStart < index) {
            pushSearchLine(`... ${relPath}:${contextStart + 1}-${index} (context)`);
          }
          pushSearchLine(`${relPath}:${index + 1}: ${displayLine}`);
          if (contextEnd > index) {
            pushSearchLine(`... ${relPath}:${index + 2}-${contextEnd + 1} (context)`);
          }
        } else {
          pushSearchLine(`${relPath}:${index + 1}: ${displayLine}`);
        }
      }
    }
  }

  const output = lines.slice(0, maxMatches).join("\n");
  if (Buffer.byteLength(output, "utf8") <= config.maxOutputBytes) return output;
  return capText(output, config.maxOutputBytes);

  function pushSearchLine(line: string): void {
    if (lines.length >= maxMatches || outputBytes > config.maxOutputBytes) return;
    lines.push(line);
    outputBytes += Buffer.byteLength(line, "utf8") + 1;
  }
}

async function searchTextFilesWithRipgrep(
  config: Config,
  workspaceRoot: string,
  startPath: string,
  pattern: string,
  caseSensitive: boolean,
  contextLines: number,
  maxMatches: number,
  includePatternText: string | undefined,
  excludePatternText: string | undefined,
): Promise<string | null> {
  const pathArg = startPath === workspaceRoot ? "." : relative(workspaceRoot, startPath).replace(/\\/g, "/");
  const args = [
    "--no-config",
    "--color",
    "never",
    "--line-number",
    "--no-heading",
    "--null",
    "--with-filename",
    "--fixed-strings",
  ];
  if (!caseSensitive) args.push("--ignore-case");
  if (contextLines > 0) args.push("--context", String(contextLines));

  for (const glob of splitGlobPatterns(includePatternText ?? "")) {
    args.push("--glob", glob);
  }
  for (const glob of splitGlobPatterns(excludePatternText ?? "")) {
    args.push("--glob", `!${glob}`);
  }
  // Negative safety globs come last, so an include cannot override them.
  for (const glob of ["**/node_modules/**", "**/dist/**", "**/.git/**"]) {
    args.push("--glob", `!${glob}`);
  }
  for (const glob of config.denyGlobs) {
    args.push("--iglob", `!${glob.replace(/\\/g, "/")}`);
  }
  args.push("--", pattern, pathArg);

  const result = await runProcess({
    command: "rg",
    args,
    cwd: workspaceRoot,
    timeoutMs: 30_000,
    maxOutputBytes: config.maxOutputBytes,
    terminateOnOutputLimit: true,
  });

  if (result.exitCode === null && /enoent|not found|could not be found/i.test(result.stderr)) return null;
  if (!result.outputLimitReached && result.exitCode === 1) return "";
  if (!result.outputLimitReached && result.exitCode !== 0) return null;

  // An early stop may cut the final line in half; only return complete matches.
  let output = result.stdout;
  if (result.outputLimitReached) {
    output = output.replace(/\n\[output truncated\]\n$/, "");
    output = output.slice(0, output.lastIndexOf("\n") + 1);
  }
  const lines = output.split(/\r?\n/).filter(line => line.length > 0);
  const filteredLines = filterRipgrepOutputLines(config.denyGlobs, workspaceRoot, lines, maxMatches);
  const formatted = filteredLines.join("\n") + (result.outputLimitReached ? "\n[search output truncated]" : "");
  return capText(formatted, config.maxOutputBytes);
}

function filterRipgrepOutputLines(denyGlobs: string[], workspaceRoot: string, lines: string[], maxLines: number): string[] {
  const output: string[] = [];
  for (const line of lines) {
    const relPath = parseRipgrepOutputPath(line);
    if (!relPath && line !== "--") continue;
    if (relPath) {
      try {
        assertNotDenied(join(workspaceRoot, relPath), workspaceRoot, denyGlobs);
      } catch {
        continue;
      }
    }
    if (line === "--" && (output.length === 0 || output[output.length - 1] === "--")) continue;
    output.push(normalizeRipgrepOutputLine(line));
    if (output.length >= maxLines) break;
  }
  while (output[output.length - 1] === "--") output.pop();
  return output;
}

/** Glob matching uses the shared matcher, including hidden and ignored files.
 * A bounded native walk avoids spawning rg and then collecting its complete listing.
 */
export async function findFilesByGlob(
  config: Config,
  workspaceRoot: string,
  startPath: string,
  matcher: GlobMatcher,
  maxResults: number,
): Promise<string[]> {
  const results: string[] = [];
  for await (const file of walkFiles(workspaceRoot, startPath, config.denyGlobs)) {
    if (matcher(file.relPath)) results.push(file.relPath);
    if (results.length >= maxResults) break;
  }
  return results;
}

export async function buildProjectTree(
  config: Config,
  root: string,
  startPath: string,
  currentDepth: number,
  maxDepth: number,
): Promise<string> {
  const lines: string[] = [];
  const maxEntries = 3000;
  const maxBytes = Math.min(config.maxOutputBytes, 60_000);
  let bytes = 0;
  let visited = 0;
  let clipped = false;
  const canonicalRoot = await realpath(root);
  function push(line: string): void {
    if (clipped) return;
    const next = Buffer.byteLength(line, "utf8") + 1;
    if (lines.length >= maxEntries || bytes + next > maxBytes) { clipped = true; return; }
    lines.push(line); bytes += next;
  }
  async function walk(path: string, depth: number, prefix: string): Promise<void> {
    if (clipped || depth > maxDepth) return;
    if (++visited > 15_000) { clipped = true; return; }
    let info;
    let canonical: string;
    try {
      info = depth === currentDepth ? await stat(path) : await lstat(path);
      if (info.isSymbolicLink()) return;
      canonical = await realpath(path);
      if (!isInsideRoot(canonical, canonicalRoot)) return;
      assertNotDenied(canonical, canonicalRoot, config.denyGlobs);
      assertNotDenied(path, root, config.denyGlobs);
    } catch { return; }
    if (!info.isDirectory()) { push(`📄 ${relative(root, path)}`); return; }
    const entries = await readdir(path, { withFileTypes: true });
    const visible = entries.filter(entry => {
      return !entry.isSymbolicLink() &&
        allowedEntry(entry.name, join(path, entry.name), root, config.denyGlobs) &&
        ((canonical === path && canonicalRoot === root) ||
          allowedEntry(entry.name, join(canonical, entry.name), canonicalRoot, config.denyGlobs));
    }).sort((a, b) => a.name.localeCompare(b.name));
    if (depth > 0) push(`${prefix}📁 ${path.split(sep).pop()}/`);
    const childPrefix = depth === 0 ? "" : `${prefix}  `;
    if (depth < maxDepth) {
      for (const entry of visible) {
        if (clipped) break;
        if (entry.isDirectory()) await walk(join(path, entry.name), depth + 1, `${childPrefix}  `);
      }
    }
    for (const entry of visible) {
      if (clipped) break;
      if (entry.isFile()) push(`${childPrefix}📄 ${entry.name}`);
    }
  }
  await walk(startPath, currentDepth, "");
  if (clipped) lines.push("[tree truncated: narrow the path or depth]");
  return lines.join("\n");
}
