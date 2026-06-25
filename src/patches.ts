import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface PendingPatch {
  id: string;
  workspaceId: string;
  path: string;
  oldText: string;
  newText: string;
  createdAt: number;
}

export class PatchStore {
  private readonly patches = new Map<string, PendingPatch>();

  create(input: Omit<PendingPatch, "id" | "createdAt">): PendingPatch {
    const patch = { ...input, id: `act_${randomUUID()}`, createdAt: Date.now() };
    this.patches.set(patch.id, patch);
    return patch;
  }

  take(actionId: string): PendingPatch {
    const patch = this.patches.get(actionId);
    if (!patch) throw new Error(`Unknown action_id: ${actionId}`);
    this.patches.delete(actionId);
    return patch;
  }
}

export async function previewReplacement(path: string, oldText: string, newText: string): Promise<string> {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    if (oldText !== "") throw new Error("File does not exist; use empty oldText to create it.");
  }

  if (oldText && !current.includes(oldText)) {
    throw new Error("oldText was not found in the target file.");
  }

  const beforeLines = oldText.split("\n").length;
  const afterLines = newText.split("\n").length;
  return [
    `--- ${path}`,
    `+++ ${path}`,
    `@@ replace ${beforeLines} line(s) with ${afterLines} line(s) @@`,
    ...oldText.split("\n").slice(0, 20).map((line) => `-${line}`),
    ...newText.split("\n").slice(0, 20).map((line) => `+${line}`),
  ].join("\n");
}

export async function applyReplacement(path: string, oldText: string, newText: string): Promise<void> {
  let current = "";
  try {
    current = await readFile(path, "utf8");
  } catch {
    if (oldText !== "") throw new Error("File does not exist; use empty oldText to create it.");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, newText, "utf8");
    return;
  }

  if (!current.includes(oldText)) throw new Error("oldText was not found in the target file.");
  await writeFile(path, current.replace(oldText, newText), "utf8");
}
