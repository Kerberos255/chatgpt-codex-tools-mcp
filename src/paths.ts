import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { realpath } from "node:fs/promises";
import { createGlobMatcher, type GlobMatcher } from "./globs.js";

export class AccessDeniedError extends Error {
  constructor(message: string) { super(message); this.name = "AccessDeniedError"; }
}

export function isInsideRoot(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const candidate = resolve(path);
  if (!allowedRoots.some(root => isInsideRoot(candidate, root))) {
    throw new AccessDeniedError("Path is outside allowed roots.");
  }
  return candidate;
}

export function resolveWorkspacePath(root: string, inputPath: string): string {
  const candidate = resolve(root, inputPath);
  if (!isInsideRoot(candidate, root)) throw new AccessDeniedError("Path is outside workspace.");
  return candidate;
}

export function relativeDisplayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel ? rel.split(sep).join("/") : ".";
}

const denyMatcherCache = new WeakMap<string[], GlobMatcher>();
export function assertNotDenied(path: string, workspaceRoot: string, denyGlobs: string[]): void {
  let matcher = denyMatcherCache.get(denyGlobs);
  if (!matcher) {
    matcher = createGlobMatcher(denyGlobs.join(","), { matchBasename: true });
    denyMatcherCache.set(denyGlobs, matcher);
  }
  const rel = relativeDisplayPath(workspaceRoot, path);
  const parts = rel.split("/");
  // Also reject denied parent directories (not only files beneath them).
  for (let i = 1; i <= parts.length; i++) {
    const part = parts.slice(0, i).join("/");
    if (matcher(part) || matcher(part + "/")) {
      throw new AccessDeniedError(`Path is blocked by deny globs: ${rel}`);
    }
  }
}

/** Find the existing parent for new files so symlink/junction escapes are detected. */
export async function assertRealWorkspacePath(path: string, root: string, allowedRoots: string[], denyGlobs: string[]): Promise<void> {
  const candidate = resolveWorkspacePath(root, path);
  assertAllowedPath(candidate, allowedRoots);
  assertNotDenied(candidate, root, denyGlobs);
  const realRoot = await realpath(root);
  let existing = candidate;
  for (;;) {
    try { await realpath(existing); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new AccessDeniedError("Cannot resolve a safe parent.");
      existing = parent;
    }
  }
  const canonical = resolve(await realpath(existing), relative(existing, candidate));
  if (!isInsideRoot(canonical, realRoot)) throw new AccessDeniedError("Symlink or junction escapes the workspace.");
  const roots = await Promise.all(allowedRoots.map(async value => {
    try { return await realpath(value); } catch { return resolve(value); }
  }));
  assertAllowedPath(canonical, roots);
  assertNotDenied(canonical, realRoot, denyGlobs);
}
