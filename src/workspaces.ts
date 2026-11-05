import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import type { Config } from "./config.js";
import { assertAllowedPath, assertRealWorkspacePath, isInsideRoot, resolveWorkspacePath, AccessDeniedError } from "./paths.js";

export interface Workspace { id: string; root: string; }
const MAX_WORKSPACES = 256;

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();
  constructor(private readonly config: Config) {}

  async open(path: string): Promise<Workspace> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const stats = await stat(root);
    if (!stats.isDirectory()) throw new Error("Workspace path is not a directory.");
    const canonical = await realpath(root);
    const canonicalRoots = await Promise.all(this.config.allowedRoots.map(value => realpath(value).catch(() => value)));
    if (!canonicalRoots.some(value => isInsideRoot(canonical, value))) throw new AccessDeniedError("Workspace symlink escapes allowed roots.");
    const workspace = { id: `ws_${randomUUID()}`, root };
    if (this.workspaces.size >= MAX_WORKSPACES) {
      const oldest = this.workspaces.keys().next().value;
      if (oldest) this.workspaces.delete(oldest);
    }
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }
  get(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    // Refresh insertion order for simple LRU without a per-request timer.
    this.workspaces.delete(workspaceId);
    this.workspaces.set(workspaceId, workspace);
    return workspace;
  }
  resolve(workspaceId: string, path: string): { workspace: Workspace; absolutePath: string } {
    const workspace = this.get(workspaceId);
    return { workspace, absolutePath: resolveWorkspacePath(workspace.root, path) };
  }
  async resolveSafe(workspaceId: string, path: string): Promise<{ workspace: Workspace; absolutePath: string }> {
    const value = this.resolve(workspaceId, path);
    await assertRealWorkspacePath(value.absolutePath, value.workspace.root, this.config.allowedRoots, this.config.denyGlobs);
    return value;
  }
}
