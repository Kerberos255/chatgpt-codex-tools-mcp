import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import type { Change, DiffEntry } from "./edit-store.js";
import { capText } from "./text.js";

type FileState = { path: string; before: string | null; after: string | null };
type Plan = { files: FileState[]; diffs: DiffEntry[] };
const DIFF_LIMIT = 32_000;

async function readMaybe(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
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
    ...oldLines.slice(contextStart, prefix).map(line => " " + line),
    ...oldLines.slice(prefix, oldEnd).map(line => "-" + line),
    ...newLines.slice(prefix, newEnd).map(line => "+" + line),
    ...oldLines.slice(oldEnd, contextEndOld).map(line => " " + line),
  ];
  return capText(lines.join("\n"), DIFF_LIMIT);
}

/** Plan every change against a virtual filesystem before any disk mutation. */
export async function planChanges(root: string, changes: Change[]): Promise<Plan> {
  const before = new Map<string, string | null>();
  const virtual = new Map<string, string | null>();
  const diffs: DiffEntry[] = [];
  async function get(path: string): Promise<string | null> {
    if (!virtual.has(path)) {
      const content = await readMaybe(resolve(root, path));
      before.set(path, content);
      virtual.set(path, content);
    }
    return virtual.get(path) ?? null;
  }

  for (const change of changes) {
    const current = await get(change.path);
    if (change.type === "rename") {
      const newPath = change.newPath;
      if (!newPath || newPath === change.path) throw new Error("newPath must differ from the source");
      requireContent(current, change.path);
      if (await get(newPath) !== null) throw new Error(`Target already exists: ${newPath}`);
      virtual.set(change.path, null);
      virtual.set(newPath, current);
      diffs.push({ path: change.path, type: "rename", diff: `Rename: ${change.path} → ${newPath}` });
    } else {
      const next = computeNext(current, change);
      virtual.set(change.path, next);
      diffs.push({ path: change.path, type: current === null && change.type === "replace_text" ? "create" : change.type,
        diff: diffFor(change.path, current, next) });
    }
  }
  return { files: [...virtual].map(([path, after]) => ({ path, before: before.get(path) ?? null, after })), diffs };
}

export async function previewChanges(root: string, changes: Change[]): Promise<DiffEntry[]> {
  return (await planChanges(root, changes)).diffs;
}

function temporaryPath(path: string): string {
  return `${path}.ctm-tmp-${randomUUID()}`;
}

async function restore(path: string, previous: string | null, priorMode?: number): Promise<void> {
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
  /** Revalidate canonical workspace and deny-glob boundaries immediately before I/O. */
  validatePath?: (relativePath: string) => Promise<void>;
}

/** Stage all writes first. Per-file renames are atomic; cross-file rollback is best effort. */
export async function applyChanges(root: string, changes: Change[], hooks: EditCommitHooks = {}): Promise<void> {
  const plan = await planChanges(root, changes);
  const updates = plan.files.filter(file => file.before !== file.after);
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
      if (await readMaybe(resolve(root, file.path)) !== file.before) {
        throw new Error(`File changed since preview: ${file.path}. Preview again.`);
      }
    }

    for (const [index, file] of updates.entries()) {
      await hooks.beforeCommit?.(index);
      await hooks.validatePath?.(file.path);
      const path = resolve(root, file.path);
      // Recheck immediately before each operation, not only before the batch.
      if (await readMaybe(path) !== file.before) {
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
        if (await readMaybe(path) !== file.after) {
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
