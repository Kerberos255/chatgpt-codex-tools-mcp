import { homedir } from "node:os";
import { resolve } from "node:path";

export type AccessMode = "review" | "full";

export interface Config {
  host: string;
  port: number;
  allowedRoots: string[];
  denyGlobs: string[];
  accessMode: AccessMode;
  maxReadBytes: number;
  maxOutputBytes: number;
}

const defaultDenyGlobs = [
  "**/.env",
  "**/.env.*",
  "**/id_rsa",
  "**/id_ed25519",
  "**/*token*",
  "**/*secret*",
  "**/key.txt",
  "**/*.key",
  "**/*.pem",
  "**/AppData/**",
  "**/.git/config",
];

export function loadConfig(env = process.env): Config {
  return {
    host: env.HOST || "127.0.0.1",
    port: parseInteger(env.PORT, 3333, "PORT"),
    allowedRoots: parsePathList(env.CTM_ALLOWED_ROOTS || process.cwd()),
    denyGlobs: parseList(env.CTM_DENY_GLOBS, defaultDenyGlobs),
    accessMode: parseAccessMode(env.CTM_ACCESS_MODE),
    maxReadBytes: parseInteger(env.CTM_MAX_READ_BYTES, 200_000, "CTM_MAX_READ_BYTES"),
    maxOutputBytes: parseInteger(env.CTM_MAX_OUTPUT_BYTES, 200_000, "CTM_MAX_OUTPUT_BYTES"),
  };
}

function parseAccessMode(value: string | undefined): AccessMode {
  if (!value || value === "review") return "review";
  if (value === "full") return "full";
  throw new Error(`Invalid CTM_ACCESS_MODE: ${value}`);
}

function parseInteger(value: string | undefined, fallback: number, name: string): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: ${value}`);
  return parsed;
}

function parseList(value: string | undefined, fallback: string[]): string[] {
  const entries = value?.split(",").map((entry) => entry.trim()).filter(Boolean);
  return entries && entries.length > 0 ? entries : fallback;
}

function parsePathList(value: string): string[] {
  return parseList(value, [process.cwd()]).map((entry) => resolve(expandHome(entry)));
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return path;
}
