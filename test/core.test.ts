import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { loadConfig, type Config } from "../src/config.js";
import { createGlobMatcher, splitGlobPatterns } from "../src/globs.js";
import { redactText, redactValue } from "../src/redaction.js";
import { SessionRegistry } from "../src/session-registry.js";
import { sqliteStatus } from "../src/sqlite-tools.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function baseConfig(): Config {
  return {
    host: "127.0.0.1",
    port: 3333,
    allowedRoots: [repoRoot],
    denyGlobs: [],
    accessMode: "review",
    maxReadBytes: 200_000,
    maxOutputBytes: 200_000,
    maxSessions: 128,
    webToolsEnabled: false,
    searchProvider: "none",
    searxngUrl: "",
    webMaxBytes: 200_000,
    webTimeoutMs: 15_000,
    sqliteToolsEnabled: false,
    sqliteAllowedDbs: [],
    sqliteMaxRows: 100,
  };
}

test("config file loads and environment variables take precedence", () => {
  const temp = mkdtempSync(join(tmpdir(), "ctm-config-"));
  try {
    const configPath = join(temp, "config.json");
    writeFileSync(configPath, JSON.stringify({
      mcp: { port: 3334, allowedRoots: [temp], accessMode: "full" },
      web: { enabled: true, searchProvider: "searxng", searxngUrl: "https://example.com" },
    }));
    const config = loadConfig({ CTM_CONFIG_PATH: configPath, PORT: "4444", CTM_MAX_SESSIONS: "64" });
    assert.equal(config.port, 4444);
    assert.equal(config.maxSessions, 64);
    assert.equal(config.accessMode, "full");
    assert.deepEqual(config.allowedRoots, [resolve(temp)]);
    assert.equal(config.webToolsEnabled, true);
    assert.equal(config.searchProvider, "searxng");
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("MCP sessions stay alive while the registry remains under its LRU cap", () => {
  let now = 0;
  const closed: string[] = [];
  const makeSession = (id: string) => ({ close: () => { closed.push(id); } });
  const sessions = new SessionRegistry(2, () => now);

  sessions.set("a", makeSession("a"));
  now = 1;
  sessions.set("b", makeSession("b"));

  now = 10_000_000;
  assert.ok(sessions.get("a"), "idle time alone must not expire a session");

  now += 1;
  const evicted = sessions.set("c", makeSession("c"));
  assert.deepEqual(evicted, ["b"]);
  assert.deepEqual(closed, ["b"]);
  assert.equal(sessions.size, 2);
  assert.ok(sessions.get("a"));
  assert.equal(sessions.get("b"), undefined);
  assert.ok(sessions.get("c"));
});

test("glob matching supports basenames, nested paths, and alternatives", () => {
  const matcher = createGlobMatcher("src/**/*.ts,{README.md,README.zh.md}", { matchBasename: true });
  assert.equal(matcher("src/server.ts"), true);
  assert.equal(matcher("src/lib/tool.ts"), true);
  assert.equal(matcher("docs/README.md"), true);
  assert.equal(matcher("src/server.js"), false);
  assert.deepEqual(splitGlobPatterns("*.ts,{*.js,*.mjs}"), ["*.ts", "{*.js,*.mjs}"]);
});

test("redaction removes common sensitive values in text and objects", () => {
  const authorizationName = ["author", "ization"].join("");
  const bearerName = ["bear", "er"].join("");
  const tokenName = ["to", "ken"].join("");
  const bearerValue = ["abcde", "fghij", "klmno", "pqrst", "uvwxy", "z0123"].join("");
  const tokenValue = ["demo", "value", "for", "test"].join("-");
  const text = redactText(`${bearerName} ${bearerValue}\n${authorizationName}: placeholder\n${tokenName}=${tokenValue}`);
  assert.equal(text.includes(bearerValue), false);
  assert.equal(text.includes(tokenValue), false);

  const apiField = ["api", "Key"].join("");
  const passwordField = ["pass", "word"].join("");
  const source = {
    [apiField]: ["demo", "api", "value"].join("-"),
    nested: { [passwordField]: ["demo", "password"].join("-"), safe: "ok" },
  };
  const value = redactValue(source) as Record<string, unknown>;
  assert.equal(value[apiField], "[REDACTED]");
  assert.deepEqual(value.nested, { [passwordField]: "[REDACTED]", safe: "ok" });
});

test("SQLite status is safe even when node:sqlite is unavailable", () => {
  const status = sqliteStatus(baseConfig());
  assert.equal(status.enabled, false);
  assert.equal(typeof status.nodeSqlite, "boolean");
});

test("repository metadata and public configuration stay synchronized", () => {
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };
  const lock = JSON.parse(readFileSync(join(repoRoot, "package-lock.json"), "utf8")) as {
    version: string;
    packages: Record<string, { version?: string }>;
  };
  const changelog = readFileSync(join(repoRoot, "CHANGELOG.md"), "utf8");
  const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  const server = readFileSync(join(repoRoot, "src", "server.ts"), "utf8");

  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[""]?.version, pkg.version);
  assert.equal(changelog.includes(`## v${pkg.version}`), true);
  assert.equal(gitignore.split(/\r?\n/).includes("config.json"), true);
  assert.equal(server.includes('const SERVER_VERSION = "'), false);
  assert.doesNotThrow(() => JSON.parse(readFileSync(join(repoRoot, "config.example.json"), "utf8")));
});

test("Windows tunnel bootstrap keeps public entry points minimal", () => {
  const gitignore = readFileSync(join(repoRoot, ".gitignore"), "utf8");
  const initializer = readFileSync(join(repoRoot, "scripts", "init-windows.ps1"), "utf8");
  const releaseBuilder = readFileSync(join(repoRoot, "scripts", "build-release.ps1"), "utf8");
  const tailscaleGateway = readFileSync(join(repoRoot, "src", "tailscale-gateway.ts"), "utf8");

  assert.equal(gitignore.split(/\r?\n/).includes("/tunnel/"), true);
  assert.equal(gitignore.split(/\r?\n/).includes("start-openai-mcp.cmd"), true);
  assert.equal(gitignore.split(/\r?\n/).includes("start-tailscale-mcp.cmd"), true);
  assert.equal(initializer.includes('[ValidateSet("OpenAI", "Tailscale", "Both")]'), true);
  assert.equal(initializer.includes("SHA256SUMS.txt"), true);
  assert.equal(initializer.includes("Existing config.json kept unchanged"), true);
  assert.equal(tailscaleGateway.includes("tunnel/tailscale/owner-password.txt"), true);
  for (const retired of ["start-all.cmd", "start-mcp.cmd", "start-tunnel.cmd"]) {
    assert.equal(releaseBuilder.includes(`\"${retired}\"`), false);
  }
});

test("CI and release workflows include validation and package gates", () => {
  const ci = readFileSync(join(repoRoot, ".github", "workflows", "ci.yml"), "utf8");
  const release = readFileSync(join(repoRoot, ".github", "workflows", "release.yml"), "utf8");
  const builder = readFileSync(join(repoRoot, "scripts", "build-release.ps1"), "utf8");
  assert.equal(ci.includes("node-version: ${{ matrix.node }}"), true);
  assert.equal(ci.includes("Build release package (dry run)"), true);
  assert.equal(release.includes("merge-base --is-ancestor"), true);
  assert.equal(release.includes("package version"), true);
  assert.equal(release.includes("build-release.ps1"), true);
  assert.equal(builder.includes("SHA256SUMS.txt"), true);
});
