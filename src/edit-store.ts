import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { resolve } from "node:path";

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
  fingerprints: FileFingerprint[];
  createdAt: number;
}

export interface DiffEntry {
  path: string;
  type: EditType;
  diff: string;
}

export interface FileFingerprint {
  path: string;
  digest: string | null;
}

const MAX_PENDING_EDITS = 128;
const EDIT_TTL_MS = 10 * 60_000;

export async function snapshotFiles(root: string, changes: Change[]): Promise<FileFingerprint[]> {
  const files = new Set<string>();
  for (const change of changes) {
    files.add(change.path);
    if (change.type === "rename" && change.newPath) files.add(change.newPath);
  }
  const snapshots: FileFingerprint[] = [];
  for (const path of files) snapshots.push({ path, digest: await digestFile(resolveEditPath(root, path)) });
  return snapshots;
}

export async function assertFilesUnchanged(root: string, fingerprints: FileFingerprint[]): Promise<void> {
  for (const file of fingerprints) {
    const actual = await digestFile(resolveEditPath(root, file.path));
    if (actual !== file.digest) throw new Error(`File changed since preview: ${file.path}. Preview again.`);
  }
}

async function digestFile(path: string): Promise<string | null> {
  const hash = createHash("sha256");
  try {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
    return hash.digest("hex");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// --- Edit Store ---

export class EditStore {
  private readonly edits = new Map<string, PendingEdit>();

  create(input: Omit<PendingEdit, "id" | "createdAt">): PendingEdit {
    this.prune();
    if (this.edits.size >= MAX_PENDING_EDITS) throw new Error("Too many pending edits.");
    const edit = { ...input, id: `edit_${randomUUID()}`, createdAt: Date.now() };
    this.edits.set(edit.id, edit);
    return edit;
  }

  take(actionId: string): PendingEdit {
    this.prune();
    const edit = this.edits.get(actionId);
    if (!edit) throw new Error(`Unknown or expired action_id: ${actionId}`);
    this.edits.delete(actionId);
    return edit;
  }

  private prune(): void {
    const cutoff = Date.now() - EDIT_TTL_MS;
    for (const [id, value] of this.edits) {
      if (value.createdAt <= cutoff) this.edits.delete(id);
    }
  }
}

export { previewChanges, applyChanges } from "./edit-planner.js";

// --- Helpers ---

function resolveEditPath(root: string, path: string): string {
  return resolve(root, path);
}
