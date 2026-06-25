import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type { Config } from "./config.js";
import { assertAllowedPath, resolveWorkspacePath } from "./paths.js";

export interface Workspace {
  id: string;
  root: string;
}

export class WorkspaceRegistry {
  private readonly workspaces = new Map<string, Workspace>();

  constructor(private readonly config: Config) {}

  async open(path: string): Promise<Workspace> {
    const root = assertAllowedPath(path, this.config.allowedRoots);
    const stats = await stat(root);
    if (!stats.isDirectory()) throw new Error(`Workspace path is not a directory: ${path}`);
    const workspace = { id: `ws_${randomUUID()}`, root };
    this.workspaces.set(workspace.id, workspace);
    return workspace;
  }

  get(workspaceId: string): Workspace {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) throw new Error(`Unknown workspaceId: ${workspaceId}. Call open_workspace first.`);
    return workspace;
  }

  resolve(workspaceId: string, path: string): { workspace: Workspace; absolutePath: string } {
    const workspace = this.get(workspaceId);
    return { workspace, absolutePath: resolveWorkspacePath(workspace.root, path) };
  }
}
