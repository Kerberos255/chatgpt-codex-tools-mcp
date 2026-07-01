import { existsSync, readFileSync } from "node:fs";
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

interface FileConfig {
  mcp?: Record<string, unknown>;
  web?: Record<string, unknown>;
  sqlite?: Record<string, unknown>;
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
  const fileConfig = readFileConfig(firstConfigured(env.CTM_CONFIG_PATH, env.CONFIG_PATH, resolve(process.cwd(), "config.json")));
  const mcpConfig = fileConfig.mcp ?? {};
  const webConfig = fileConfig.web ?? {};
  const sqliteConfig = fileConfig.sqlite ?? {};

  return {
    host: parseString(firstConfigured(env.HOST, mcpConfig.host), "127.0.0.1"),
    port: parseInteger(firstConfigured(env.PORT, mcpConfig.port), 3333, "PORT"),
    allowedRoots: parsePathList(firstConfigured(env.CTM_ALLOWED_ROOTS, mcpConfig.allowedRoots, process.cwd())),
    denyGlobs: parseList(firstConfigured(env.CTM_DENY_GLOBS, mcpConfig.denyGlobs), defaultDenyGlobs),
    accessMode: parseAccessMode(firstConfigured(env.CTM_ACCESS_MODE, mcpConfig.accessMode)),
    maxReadBytes: parseInteger(firstConfigured(env.CTM_MAX_READ_BYTES, mcpConfig.maxReadBytes), 200_000, "CTM_MAX_READ_BYTES"),
    maxOutputBytes: parseInteger(firstConfigured(env.CTM_MAX_OUTPUT_BYTES, mcpConfig.maxOutputBytes), 200_000, "CTM_MAX_OUTPUT_BYTES"),
    webToolsEnabled: parseBoolean(firstConfigured(env.CTM_WEB_TOOLS, webConfig.enabled)),
    searchProvider: parseSearchProvider(firstConfigured(env.CTM_SEARCH_PROVIDER, webConfig.searchProvider)),
    searxngUrl: parseString(firstConfigured(env.CTM_SEARXNG_URL, webConfig.searxngUrl), ""),
    webMaxBytes: parseInteger(firstConfigured(env.CTM_WEB_MAX_BYTES, webConfig.maxBytes), 200_000, "CTM_WEB_MAX_BYTES"),
    webTimeoutMs: parseInteger(firstConfigured(env.CTM_WEB_TIMEOUT_MS, webConfig.timeoutMs), 15_000, "CTM_WEB_TIMEOUT_MS"),
    sqliteToolsEnabled: parseBoolean(firstConfigured(env.CTM_SQLITE_TOOLS, sqliteConfig.enabled)),
    sqliteAllowedDbs: parseOptionalPathList(firstConfigured(env.CTM_SQLITE_ALLOWED_DBS, sqliteConfig.allowedDbs)),
    sqliteMaxRows: parseInteger(firstConfigured(env.CTM_SQLITE_MAX_ROWS, sqliteConfig.maxRows), 100, "CTM_SQLITE_MAX_ROWS"),
  };
}

function readFileConfig(configPath: unknown): FileConfig {
  const path = parseString(configPath, "");
  if (!path || !existsSync(path)) return {};

  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) throw new Error("top-level JSON value must be an object");
    return parsed as FileConfig;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse config file: ${path}. ${message}`);
  }
}

function firstConfigured(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function parseAccessMode(value: unknown): AccessMode {
  const normalized = parseString(value, "review");
  if (normalized === "review") return "review";
  if (normalized === "full") return "full";
  throw new Error(`Invalid CTM_ACCESS_MODE / mcp.accessMode: ${normalized}`);
}

function parseSearchProvider(value: unknown): SearchProvider {
  const normalized = parseString(value, "none");
  if (normalized === "none") return "none";
  if (normalized === "searxng") return "searxng";
  throw new Error(`Invalid CTM_SEARCH_PROVIDER / web.searchProvider: ${normalized}`);
}

function parseBoolean(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseInteger(value: unknown, fallback: number, name: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Invalid ${name}: ${String(value)}`);
  return parsed;
}

function parseString(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function parseList(value: unknown, fallback: string[]): string[] {
  let entries: string[];
  if (Array.isArray(value)) {
    entries = value.map((entry) => String(entry).trim()).filter(Boolean);
  } else if (typeof value === "string") {
    entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  } else {
    entries = [];
  }
  return entries.length > 0 ? entries : fallback;
}

function parsePathList(value: unknown): string[] {
  return parseList(value, [process.cwd()]).map((entry) => resolve(expandHome(entry)));
}

function parseOptionalPathList(value: unknown): string[] {
  return parseList(value, []).map((entry) => resolve(expandHome(entry)));
}

function expandHome(path: string): string {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return resolve(homedir(), path.slice(2));
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
