import { basename, extname, relative, resolve, sep } from "node:path";

export class AccessDeniedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessDeniedError";
  }
}

export function isInsideRoot(path: string, root: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedRoot = resolve(root);
  const rel = relative(resolvedRoot, resolvedPath);
  return rel === "" || (!rel.startsWith("..") && rel !== ".." && !rel.includes(`..${sep}`));
}

export function assertAllowedPath(path: string, allowedRoots: string[]): string {
  const resolved = resolve(path);
  if (!allowedRoots.some((root) => isInsideRoot(resolved, root))) {
    throw new AccessDeniedError(`Path is outside allowed roots: ${path}`);
  }
  return resolved;
}

export function resolveWorkspacePath(root: string, inputPath: string): string {
  const resolved = resolve(root, inputPath);
  if (!isInsideRoot(resolved, root)) {
    throw new AccessDeniedError(`Path is outside workspace: ${inputPath}`);
  }
  return resolved;
}

export function relativeDisplayPath(root: string, path: string): string {
  const rel = relative(root, path);
  return rel ? rel.split(sep).join("/") : ".";
}

export function assertNotDenied(path: string, workspaceRoot: string, denyGlobs: string[]): void {
  const rel = relativeDisplayPath(workspaceRoot, path);
  const lowerPath = rel.toLowerCase();
  const lowerBase = basename(lowerPath);
  const lowerExt = extname(lowerBase);
  const parts = lowerPath.split("/");

  for (const glob of denyGlobs.map((entry) => entry.toLowerCase())) {
    if (glob === "**/.env" && lowerBase === ".env") deny(glob, rel);
    if (glob === "**/.env.*" && lowerBase.startsWith(".env.")) deny(glob, rel);
    if (glob === "**/id_rsa" && lowerBase === "id_rsa") deny(glob, rel);
    if (glob === "**/id_ed25519" && lowerBase === "id_ed25519") deny(glob, rel);
    if (glob === "**/*token*" && lowerBase.includes("token")) deny(glob, rel);
    if (glob === "**/*secret*" && lowerBase.includes("secret")) deny(glob, rel);
    if (glob === "**/key.txt" && lowerBase === "key.txt") deny(glob, rel);
    if (glob === "**/*.key" && lowerExt === ".key") deny(glob, rel);
    if (glob === "**/*.pem" && lowerExt === ".pem") deny(glob, rel);
    if (glob === "**/appdata/**" && parts.includes("appdata")) deny(glob, rel);
    if (glob === "**/.git/config" && lowerPath.endsWith(".git/config")) deny(glob, rel);
  }
}

function deny(glob: string, path: string): never {
  throw new AccessDeniedError(`Path is blocked by deny globs (${glob}): ${path}`);
}
