import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { isInsideRoot, resolveWorkspacePath } from "./paths.js";
import type { Change, DiffEntry, FileFingerprint } from "./edit-store.js";
import { capText } from "./text.js";

type FileState = { path: string; before: Buffer | null; after: Buffer | null };
const equal = (a: Buffer | null, b: Buffer | null): boolean => a === null ? b === null : b !== null && a.equals(b);
const MAX_EDIT_FILE_BYTES = 16 * 1024 * 1024;
type Plan = { files: FileState[]; diffs: DiffEntry[] };
const DIFF_LIMIT = 32_000;

async function readMaybe(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Edits require regular files, not links or directories.");
    if (info.size > MAX_EDIT_FILE_BYTES) throw new Error("File exceeds the 16 MiB edit snapshot limit.");
    const bytes = await readFile(path);
    if (bytes.length > MAX_EDIT_FILE_BYTES) throw new Error("File exceeds the 16 MiB edit snapshot limit.");
    return bytes;
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function textContent(bytes: Buffer | null): string | null {
  if (bytes === null) return null;
  const text = bytes.toString("utf8");
  if (bytes.includes(0) || !Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error("Binary or non-UTF-8 file: only rename or delete is supported.");
  }
  return text;
}

function requireContent(value: string | null, path: string): string {
  if (value === null) throw new Error(`File does not exist: ${path}`);
  return value;
}

/** Deterministic in-memory edit step; the same transformation powers preview and apply. */
export function computeNext(current: string | null, change: Change): string | null {
  switch (change.type) {
    case "replace_text": {
      const oldText = change.oldText ?? "";
      if (current === null) {
        if (oldText) throw new Error(`File does not exist: ${change.path}`);
        return change.newText ?? ""; // backwards-compatible create
      }
      if (!oldText) throw new Error("oldText cannot be empty on an existing file. Use overwrite, append, or insert.");
      const index = current.indexOf(oldText);
      if (index < 0) throw new Error(`oldText not found in ${change.path}`);
      if (current.indexOf(oldText, index + 1) >= 0) throw new Error(`oldText is ambiguous in ${change.path}. Provide more context.`);
      return current.slice(0, index) + (change.newText ?? "") + current.slice(index + oldText.length);
    }
    case "replace_range": {
      const content = requireContent(current, change.path);
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      const start = (change.startLine ?? 1) - 1;
      const end = (change.endLine ?? start + 1) - 1;
      if (start < 0 || start >= lines.length) throw new Error(`startLine ${change.startLine} out of range`);
      if (end < start || end >= lines.length) throw new Error(`endLine ${change.endLine} out of range`);
      const replacement = (change.newText ?? "").replace(/\r\n?/g, "\n").split("\n");
      lines.splice(start, end - start + 1, ...replacement);
      return lines.join(eol);
    }
    case "insert_before": {
      const content = requireContent(current, change.path);
      const index = content.indexOf(change.anchor ?? "");
      if (index < 0) throw new Error(`anchor not found in ${change.path}`);
      return content.slice(0, index) + (change.text ?? "") + content.slice(index);
    }
    case "insert_after": {
      const content = requireContent(current, change.path);
      const anchor = change.anchorAfter ?? "";
      const index = content.indexOf(anchor);
      if (index < 0) throw new Error(`anchor not found in ${change.path}`);
      return content.slice(0, index + anchor.length) + (change.text ?? "") + content.slice(index + anchor.length);
    }
    case "append": {
      const content = current ?? "";
      const needsNewline = content.length > 0 && !content.endsWith("\n");
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      return content + (needsNewline ? eol : "") + (change.text ?? "");
    }
    case "create":
      if (current !== null) throw new Error(`File already exists: ${change.path}. Use overwrite instead.`);
      return change.text ?? "";
    case "overwrite":
      return change.newText ?? "";
    case "delete":
      requireContent(current, change.path);
      return null;
    case "rename":
      throw new Error("rename must be planned across source and destination");
  }
}

function diffFor(path: string, before: string | null, after: string | null): string {
  if (before === after) return "(no changes)";
  const oldLines = before === null ? [] : before.replace(/\r\n/g, "\n").split("\n");
  const newLines = after === null ? [] : after.replace(/\r\n/g, "\n").split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let oldEnd = oldLines.length, newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--; newEnd--;
  }
  const contextStart = Math.max(0, prefix - 2);
  const contextEndOld = Math.min(oldLines.length, oldEnd + 2);
  const contextEndNew = Math.min(newLines.length, newEnd + 2);
  const lines = [
    `--- ${before === null ? "(new file)" : path}`,
    `+++ ${after === null ? "(deleted)" : path}`,
    `@@ -${contextStart + 1},${contextEndOld - contextStart} +${contextStart + 1},${contextEndNew - contextStart} @@`,
  ];
  let bytes = Buffer.byteLength(lines.join("\n"));
  function append(values: string[], start: number, end: number, marker: string): boolean {
    for (let i = start; i < end; i++) {
      const line = marker + values[i];
      const available = DIFF_LIMIT - bytes - 1;
      if (Buffer.byteLength(line) > available) {
        lines.push(capText(line, Math.max(0, available)));
        return false;
      }
      lines.push(line);
      bytes += Buffer.byteLength(line) + 1;
    }
    return true;
  }
  if (!append(oldLines, contextStart, prefix, " ") ||
      !append(oldLines, prefix, oldEnd, "-") ||
      !append(newLines, prefix, newEnd, "+") ||
      !append(oldLines, oldEnd, contextEndOld, " ")) {
    return capText(lines.join("\n") + "\n[diff truncated]", DIFF_LIMIT);
  }
  return capText(lines.join("\n"), DIFF_LIMIT);
}

/** Plan every change against a virtual filesystem before any disk mutation. */
export async function planChanges(root: string, changes: Change[]): Promise<Plan> {
  const before = new Map<string, Buffer | null>();
  const virtual = new Map<string, Buffer | null>();
  const names = new Map<string, string>();
  let totalSnapshotBytes = 0;
  const diffs: DiffEntry[] = [];
  const canonicalRoot = await realpath(root);
  const keyOf = (path: string) => process.platform === "win32" ? path.toLowerCase() : path;
  async function keyFor(input: string): Promise<string> {
    const path = resolveWorkspacePath(root, input);
    const rel = relative(root, path);
    if (!rel) throw new Error("Cannot edit the workspace root.");
    let ancestor = path;
    let canonical: string;
    for (;;) {
      try { canonical = await realpath(ancestor); break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        const parent = dirname(ancestor);
        if (parent === ancestor) throw error;
        ancestor = parent;
      }
    }
    const target = resolve(canonical, relative(ancestor, path));
    if (!isInsideRoot(target, canonicalRoot) ||
        keyOf(target) !== keyOf(resolve(canonicalRoot, rel))) {
      throw new Error("Edit path resolves through an alias or junction. Use the canonical workspace-relative path.");
    }
    const key = keyOf(rel);
    if (names.has(key) && names.get(key) !== rel) throw new Error("Use consistent casing for paths within one edit batch.");
    if (!names.has(key)) names.set(key, rel);
    return key;
  }
  async function get(key: string): Promise<Buffer | null> {
    if (!virtual.has(key)) {
      const content = await readMaybe(resolve(root, names.get(key)!));
      totalSnapshotBytes += content?.length ?? 0;
      if (totalSnapshotBytes > 64 * 1024 * 1024) throw new Error("Edit batch exceeds the 64 MiB snapshot limit.");
      before.set(key, content);
      virtual.set(key, content);
    }
    return virtual.get(key) ?? null;
  }

  for (const change of changes) {
    const key = await keyFor(change.path);
    const current = await get(key);
    if (change.type === "rename") {
      const newPath = change.newPath;
      if (!newPath) throw new Error("newPath must differ from the source");
      const target = await keyFor(newPath);
      if (target === key) throw new Error("newPath must differ from the source");
      if (current === null) throw new Error(`File does not exist: ${change.path}`);
      if (await get(target) !== null) throw new Error(`Target already exists: ${newPath}`);
      virtual.set(key, null);
      virtual.set(target, current);
      diffs.push({ path: change.path, type: "rename", diff: `Rename: ${change.path} → ${newPath}` });
    } else if (change.type === "delete") {
      if (current === null) throw new Error(`File does not exist: ${change.path}`);
      virtual.set(key, null);
      let diff: string;
      try { diff = diffFor(change.path, textContent(current), null); }
      catch { diff = `Delete binary/non-UTF-8 file (${current.length} bytes)`; }
      diffs.push({ path: change.path, type: "delete", diff });
    } else {
      const previous = textContent(current);
      const next = computeNext(previous, change);
      const after = next === null ? null : Buffer.from(next, "utf8");
      if (after && after.length > MAX_EDIT_FILE_BYTES) throw new Error("Edited file exceeds the 16 MiB limit.");
      virtual.set(key, after);
      diffs.push({ path: change.path, type: current === null && change.type === "replace_text" ? "create" : change.type,
        diff: diffFor(change.path, previous, next) });
    }
  }
  return { files: [...virtual].map(([key, after]) => ({ path: names.get(key)!, before: before.get(key) ?? null, after })), diffs };
}

function fingerprintsFor(plan: Plan): FileFingerprint[] {
  return plan.files.map(file => ({
    path: file.path,
    digest: file.before === null ? null : createHash("sha256").update(file.before).digest("hex"),
  }));
}

export async function previewChangesWithFingerprints(root: string, changes: Change[]): Promise<{diffs: DiffEntry[]; fingerprints: FileFingerprint[]}> {
  const plan = await planChanges(root, changes);
  return { diffs: plan.diffs, fingerprints: fingerprintsFor(plan) };
}

export async function previewChanges(root: string, changes: Change[]): Promise<DiffEntry[]> {
  return (await planChanges(root, changes)).diffs;
}

function temporaryPath(path: string): string {
  return `${path}.ctm-tmp-${randomUUID()}`;
}

async function restore(path: string, previous: Buffer | null, priorMode?: number): Promise<void> {
  if (previous === null) {
    await unlink(path).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    });
    return;
  }
  const temporary = temporaryPath(path);
  try {
    await writeFile(temporary, previous, { encoding: "utf8", flag: "wx", mode: 0o600 });
    if (priorMode !== undefined) await chmod(temporary, priorMode);
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

/** Inject failures into a private workspace test without changing the public MCP API. */
export interface EditCommitHooks {
  beforeCommit?: (index: number) => void | Promise<void>;
  expectedFingerprints?: readonly FileFingerprint[];
  /** Revalidate canonical workspace and deny-glob boundaries immediately before I/O. */
  validatePath?: (relativePath: string) => Promise<void>;
}

/** Stage all writes first. Per-file renames are atomic; cross-file rollback is best effort. */
export async function applyChanges(root: string, changes: Change[], hooks: EditCommitHooks = {}): Promise<void> {
  const plan = await planChanges(root, changes);
  if (hooks.expectedFingerprints) {
    const actual = fingerprintsFor(plan);
    const expected = new Map(hooks.expectedFingerprints.map(file => [file.path, file.digest]));
    if (expected.size !== actual.length || actual.some(file => !expected.has(file.path) || expected.get(file.path) !== file.digest)) {
      throw new Error("File changed since preview. Preview again.");
    }
  }
  const updates = plan.files.filter(file => !equal(file.before, file.after));
  const staged = new Map<string, string>();
  const priorModes = new Map<string, number>();
  const committed: FileState[] = [];
  try {
    for (const file of updates) {
      await hooks.validatePath?.(file.path);
      const path = resolve(root, file.path);
      if (file.before !== null) priorModes.set(path, (await stat(path)).mode);
      if (file.after === null) continue;
      await mkdir(dirname(path), { recursive: true });
      const temp = temporaryPath(path);
      staged.set(path, temp);
      await writeFile(temp, file.after, { encoding: "utf8", flag: "wx", mode: 0o600 });
      // Preserve existing POSIX permissions and the Windows read-only bit.
      const targetMode = priorModes.get(path) ?? (0o666 & ~process.umask());
      await chmod(temp, targetMode);
    }

    // Catch ordinary concurrent modifications after planning, before touching any target.
    for (const file of updates) {
      if (!equal(await readMaybe(resolve(root, file.path)), file.before)) {
        throw new Error(`File changed since preview: ${file.path}. Preview again.`);
      }
    }

    for (const [index, file] of updates.entries()) {
      await hooks.beforeCommit?.(index);
      await hooks.validatePath?.(file.path);
      const path = resolve(root, file.path);
      // Recheck immediately before each operation, not only before the batch.
      if (!equal(await readMaybe(path), file.before)) {
        throw new Error(`File changed during commit: ${file.path}. Preview again.`);
      }
      if (file.after === null) await unlink(path);
      else await rename(staged.get(path)!, path);
      committed.push(file);
    }
  } catch (error) {
    const rollbackErrors: string[] = [];
    for (const file of committed.reverse()) {
      try {
        await hooks.validatePath?.(file.path);
        const path = resolve(root, file.path);
        // Do not silently overwrite another writer's changes while recovering.
        if (!equal(await readMaybe(path), file.after)) {
          throw new Error("File changed after commit; refusing to overwrite external changes");
        }
        await restore(path, file.before, priorModes.get(path));
      } catch (rollbackError) {
        rollbackErrors.push(`${file.path}: ${String(rollbackError)}`);
      }
    }
    if (rollbackErrors.length > 0) {
      throw new Error(`${String(error)}; rollback incomplete: ${rollbackErrors.join("; ")}`);
    }
    throw error;
  } finally {
    for (const [path, temp] of staged) {
      try {
        // A moved directory must not redirect cleanup into an untrusted junction.
        await hooks.validatePath?.(relative(root, path));
        await unlink(temp);
      } catch { /* A displaced temp may remain; never follow an unsafe path. */ }
    }
  }
}
