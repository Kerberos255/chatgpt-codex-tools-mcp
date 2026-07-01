import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename as fsRename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

// --- Types ---

export const EDIT_TYPES = [
  "replace_text",
  "replace_range",
  "insert_before",
  "insert_after",
  "append",
  "create",
  "overwrite",
  "rename",
  "delete",
] as const;

export type EditType = (typeof EDIT_TYPES)[number];

export interface Change {
  path: string;
  type: EditType;
  /** replace_text: exact text to find */
  oldText?: string;
  /** replace_text, replace_range, overwrite: replacement/new content */
  newText?: string;
  /** replace_range: 1-indexed start line */
  startLine?: number;
  /** replace_range: 1-indexed end line (inclusive) */
  endLine?: number;
  /** insert_before, insert_after, append, create: text to insert */
  text?: string;
  /** insert_before: anchor text to search (first occurrence) */
  anchor?: string;
  /** insert_after: anchor text to search (first occurrence) */
  anchorAfter?: string;
  /** rename: target path relative to workspace */
  newPath?: string;
}

export interface PendingEdit {
  id: string;
  workspaceId: string;
  changes: Change[];
  diffs: DiffEntry[];
  createdAt: number;
}

export interface DiffEntry {
  path: string;
  type: EditType;
  diff: string;
}

// --- Edit Store ---

export class EditStore {
  private readonly edits = new Map<string, PendingEdit>();

  create(input: Omit<PendingEdit, "id" | "createdAt">): PendingEdit {
    const edit = { ...input, id: `edit_${randomUUID()}`, createdAt: Date.now() };
    this.edits.set(edit.id, edit);
    return edit;
  }

  take(actionId: string): PendingEdit {
    const edit = this.edits.get(actionId);
    if (!edit) throw new Error(`Unknown action_id: ${actionId}`);
    this.edits.delete(actionId);
    return edit;
  }
}

// --- Preview logic ---

export async function previewChanges(
  absoluteRoot: string,
  changes: Change[],
): Promise<DiffEntry[]> {
  const diffs: DiffEntry[] = [];
  for (const change of changes) {
    const diff = await previewOne(absoluteRoot, change);
    diffs.push(diff);
  }
  return diffs;
}

async function previewOne(root: string, change: Change): Promise<DiffEntry> {
  const fullPath = resolveEditPath(root, change.path);

  switch (change.type) {
    case "replace_text": {
      const content = await tryRead(fullPath);
      if (content === null) {
        // Creating new file when oldText is empty (backward compat)
        if (change.oldText && change.oldText.length > 0) {
          throw new Error(`File does not exist: ${change.path}`);
        }
        return {
          path: change.path,
          type: "create",
          diff: `--- (new file)\n+++ ${change.path}\n@@ -0,0 +1,${countLines(change.newText ?? "")} @@\n${prependPlus(change.newText ?? "")}`,
        };
      }
      if (!change.oldText && change.oldText !== "") {
        throw new Error("oldText is required for replace_text on an existing file.");
      }
      if (change.oldText && !content.includes(change.oldText)) {
        throw new Error(`oldText not found in ${change.path}`);
      }
      const beforeLines = countLines(change.oldText ?? "");
      const afterLines = countLines(change.newText ?? "");
      return {
        path: change.path,
        type: "replace_text",
        diff: [
          `--- ${change.path}`,
          `+++ ${change.path}`,
          `@@ replace ${beforeLines} line(s) with ${afterLines} line(s) @@`,
          ...(change.oldText ?? "").split("\n").slice(0, 20).map((l) => `-${l}`),
          ...(change.newText ?? "").split("\n").slice(0, 20).map((l) => `+${l}`),
        ].join("\n"),
      };
    }

    case "replace_range": {
      const content = await assertRead(fullPath, change.path);
      const lines = content.split("\n");
      const start = (change.startLine ?? 1) - 1;
      const end = (change.endLine ?? start + 1) - 1;
      if (start < 0 || start >= lines.length) {
        throw new Error(`startLine ${change.startLine} out of range (file has ${lines.length} lines)`);
      }
      if (end < start || end >= lines.length) {
        throw new Error(`endLine ${change.endLine} out of range`);
      }
      const oldText = lines.slice(start, end + 1).join("\n");
      const newText = change.newText ?? "";
      return {
        path: change.path,
        type: "replace_range",
        diff: [
          `--- ${change.path}`,
          `+++ ${change.path}`,
          `@@ L${change.startLine}-L${change.endLine}: ${countLines(oldText)} → ${countLines(newText)} line(s) @@`,
          ...oldText.split("\n").slice(0, 20).map((l) => `-${l}`),
          ...newText.split("\n").slice(0, 20).map((l) => `+${l}`),
        ].join("\n"),
      };
    }

    case "insert_before": {
      const content = await assertRead(fullPath, change.path);
      const anchor = change.anchor ?? "";
      if (!content.includes(anchor)) throw new Error(`anchor not found in ${change.path}`);
      return {
        path: change.path,
        type: "insert_before",
        diff: [
          `--- ${change.path}`,
          `+++ ${change.path}`,
          `@@ insert before "${truncate(anchor, 40)}" @@`,
          ...(change.text ?? "").split("\n").slice(0, 20).map((l) => `+${l}`),
        ].join("\n"),
      };
    }

    case "insert_after": {
      const content = await assertRead(fullPath, change.path);
      const anchor = change.anchorAfter ?? "";
      if (!content.includes(anchor)) throw new Error(`anchor not found in ${change.path}`);
      return {
        path: change.path,
        type: "insert_after",
        diff: [
          `--- ${change.path}`,
          `+++ ${change.path}`,
          `@@ insert after "${truncate(anchor, 40)}" @@`,
          ...(change.text ?? "").split("\n").slice(0, 20).map((l) => `+${l}`),
        ].join("\n"),
      };
    }

    case "append": {
      return {
        path: change.path,
        type: "append",
        diff: [
          `--- ${change.path}`,
          `+++ ${change.path}`,
          `@@ append ${countLines(change.text ?? "")} line(s) @@`,
          ...(change.text ?? "").split("\n").slice(0, 20).map((l) => `+${l}`),
        ].join("\n"),
      };
    }

    case "create": {
      const existing = await tryRead(fullPath);
      if (existing !== null) throw new Error(`File already exists: ${change.path}. Use overwrite instead.`);
      return {
        path: change.path,
        type: "create",
        diff: `--- (new file)\n+++ ${change.path}\n@@ -0,0 +1,${countLines(change.text ?? "")} @@\n${prependPlus(change.text ?? "")}`,
      };
    }

    case "overwrite": {
      const content = await tryRead(fullPath);
      const oldSummary = content !== null ? `${countLines(content)} line(s)` : "(new file)";
      const newSummary = `${countLines(change.newText ?? "")} line(s)`;
      return {
        path: change.path,
        type: "overwrite",
        diff: `--- ${change.path} (${oldSummary})\n+++ ${change.path}\n@@ overwrite: ${oldSummary} → ${newSummary} @@`,
      };
    }

    case "rename": {
      const targetPath = change.newPath ?? "";
      if (!targetPath) throw new Error("newPath is required for rename");
      const targetFull = resolveEditPath(root, targetPath);
      const existing = await tryRead(targetFull);
      if (existing !== null) throw new Error(`Target already exists: ${targetPath}. Use overwrite or delete first.`);
      return {
        path: change.path,
        type: "rename",
        diff: `Rename: ${change.path} → ${targetPath}`,
      };
    }

    case "delete": {
      await assertRead(fullPath, change.path);
      return {
        path: change.path,
        type: "delete",
        diff: `Delete: ${change.path}`,
      };
    }

    default:
      throw new Error(`Unknown edit type: ${(change as Change).type}`);
  }
}

// --- Apply logic ---

export async function applyChanges(
  root: string,
  changes: Change[],
): Promise<void> {
  for (const change of changes) {
    await applyOne(root, change);
  }
}

async function applyOne(root: string, change: Change): Promise<void> {
  const fullPath = resolveEditPath(root, change.path);

  switch (change.type) {
    case "replace_text": {
      const content = await tryRead(fullPath);
      if (content === null) {
        // Creating new file (empty oldText compat)
        if (change.oldText && change.oldText.length > 0) {
          throw new Error(`File does not exist: ${change.path}`);
        }
        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, change.newText ?? "", "utf8");
        return;
      }
      if (!change.oldText && change.oldText !== "") {
        throw new Error("oldText is required for replace_text on existing file");
      }
      if (change.oldText && !content.includes(change.oldText)) {
        throw new Error(`oldText not found in ${change.path}`);
      }
      if (change.oldText) {
        await writeFile(fullPath, content.replace(change.oldText, change.newText ?? ""), "utf8");
      }
      return;
    }

    case "replace_range": {
      const content = await assertRead(fullPath, change.path);
      const lines = content.split("\n");
      const start = (change.startLine ?? 1) - 1;
      const end = (change.endLine ?? start + 1) - 1;
      if (start < 0 || start >= lines.length) throw new Error(`startLine out of range`);
      if (end < start || end >= lines.length) throw new Error(`endLine out of range`);
      const newLines = (change.newText ?? "").split("\n");
      lines.splice(start, end - start + 1, ...newLines);
      await writeFile(fullPath, lines.join("\n"), "utf8");
      return;
    }

    case "insert_before": {
      const content = await assertRead(fullPath, change.path);
      const anchor = change.anchor ?? "";
      const index = content.indexOf(anchor);
      if (index === -1) throw new Error(`anchor not found in ${change.path}`);
      await writeFile(
        fullPath,
        content.slice(0, index) + (change.text ?? "") + content.slice(index),
        "utf8",
      );
      return;
    }

    case "insert_after": {
      const content = await assertRead(fullPath, change.path);
      const anchor = change.anchorAfter ?? "";
      const index = content.indexOf(anchor);
      if (index === -1) throw new Error(`anchor not found in ${change.path}`);
      await writeFile(
        fullPath,
        content.slice(0, index + anchor.length) + (change.text ?? "") + content.slice(index + anchor.length),
        "utf8",
      );
      return;
    }

    case "append": {
      await mkdir(dirname(fullPath), { recursive: true });
      const content = await tryRead(fullPath) ?? "";
      const needsNewline = content.length > 0 && !content.endsWith("\n");
      await writeFile(fullPath, content + (needsNewline ? "\n" : "") + (change.text ?? ""), "utf8");
      return;
    }

    case "create": {
      const existing = await tryRead(fullPath);
      if (existing !== null) throw new Error(`File already exists: ${change.path}`);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, change.text ?? "", "utf8");
      return;
    }

    case "overwrite": {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, change.newText ?? "", "utf8");
      return;
    }

    case "rename": {
      const targetPath = change.newPath ?? "";
      if (!targetPath) throw new Error("newPath is required for rename");
      const targetFull = resolveEditPath(root, targetPath);
      await mkdir(dirname(targetFull), { recursive: true });
      await fsRename(fullPath, targetFull);
      return;
    }

    case "delete": {
      await unlink(fullPath);
      return;
    }

    default:
      throw new Error(`Unknown edit type: ${(change as Change).type}`);
  }
}

// --- Helpers ---

function resolveEditPath(root: string, path: string): string {
  return resolve(root, path);
}

async function tryRead(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

async function assertRead(path: string, displayPath: string): Promise<string> {
  const content = await tryRead(path);
  if (content === null) throw new Error(`File does not exist: ${displayPath}`);
  return content;
}

function countLines(text: string): number {
  if (!text) return 0;
  return text.split("\n").length;
}

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) + "…" : text;
}

function prependPlus(text: string): string {
  if (!text) return "";
  return text.split("\n").map((l) => `+${l}`).join("\n");
}
