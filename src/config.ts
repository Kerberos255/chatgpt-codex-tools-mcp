import { homedir } from "node:os";
import { resolve } from "node:path";

export type AccessMode = "review" | "full";
export type SearchProvider = "none" | "searxng";

export interface Config {
  host: string;
  port: number;
  allowedRoots: string[];
  denyGlobs: string[];
  accessMode: AccessMode;
  maxReadBytes: number;
  maxOutputBytes: number;
  webToolsEnabled: boolean;
  searchProvider: SearchProvider;
  searxngUrl: string;
  webMaxBytes: number;
  webTimeoutMs: number;
  sqliteToolsEnabled: boolean;
  sqliteAllowedDbs: string[];
  sqliteMaxRows: number;
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
    webToolsEnabled: parseBoolean(env.CTM_WEB_TOOLS),
    searchProvider: parseSearchProvider(env.CTM_SEARCH_PROVIDER),
    searxngUrl: env.CTM_SEARXNG_URL || "",
    webMaxBytes: parseInteger(env.CTM_WEB_MAX_BYTES, 200_000, "CTM_WEB_MAX_BYTES"),
    webTimeoutMs: parseInteger(env.CTM_WEB_TIMEOUT_MS, 15_000, "CTM_WEB_TIMEOUT_MS"),
    sqliteToolsEnabled: parseBoolean(env.CTM_SQLITE_TOOLS),
    sqliteAllowedDbs: parseOptionalPathList(env.CTM_SQLITE_ALLOWED_DBS),
    sqliteMaxRows: parseInteger(env.CTM_SQLITE_MAX_ROWS, 100, "CTM_SQLITE_MAX_ROWS"),
  };
}

function parseAccessMode(value: string | undefined): AccessMode {
  if (!value || value === "review") return "review";
  if (value === "full") return "full";
  throw new Error(`Invalid CTM_ACCESS_MODE: ${value}`);
}

function parseSearchProvider(value: string | undefined): SearchProvider {
  if (!value || value === "none") return "none";
  if (value === "searxng") return "searxng";
  throw new Error(`Invalid CTM_SEARCH_PROVIDER: ${value}`);
}

function parseBoolean(value: string | undefined): boolean {
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
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

function parseOptionalPathList(value: string | undefined): string[] {
  return parseList(value, []).map((entry) => resolve(expandHome(entry)));
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return path;
}
