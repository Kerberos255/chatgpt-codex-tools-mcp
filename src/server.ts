import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join, relative, sep, resolve as pathResolve } from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { createGlobMatcher, splitGlobPatterns, type GlobMatcher } from "./globs.js";
import { assertNotDenied, relativeDisplayPath } from "./paths.js";
import { EditStore, type Change, previewChanges, applyChanges } from "./edit-store.js";
import { ManagedProcessStore, type ManagedProcessSnapshot } from "./managed-processes.js";
import { assertProcessAllowed, runProcess, type ProcessResult } from "./process-runner.js";
import { redactText, redactValue } from "./redaction.js";
import { SessionRegistry } from "./session-registry.js";
import {
  sqliteSchema,
  sqliteSelect,
  sqlitePreviewChange,
  sqliteConfirmChange,
} from "./sqlite-tools.js";
import { captureScreenshot } from "./screenshot.js";
import { webFetch, webSearch } from "./web.js";
import { WorkspaceRegistry } from "./workspaces.js";
const packageMetadata = createRequire(import.meta.url)("../package.json") as { version?: unknown };
const SERVER_VERSION = typeof packageMetadata.version === "string" ? packageMetadata.version : "0.0.0";

const TOOL_GROUPS = [
  { type: "meta", tools: ["local_status"] },
  { type: "workspace", tools: ["open_workspace"] },
  { type: "files", tools: ["files"] },
  { type: "git", tools: ["git"] },
  { type: "edit", tools: ["edit"] },
  { type: "exec", tools: ["exec"] },
  { type: "sqlite", tools: ["sqlite"] },
  { type: "web", tools: ["web"] },
  { type: "capture", tools: ["screenshot"] },
];
const config = loadConfig();
const workspaces = new WorkspaceRegistry(config);
const edits = new EditStore();
const managedProcesses = new ManagedProcessStore();

const payloadLimits = {
  previewEditMaxChanges: 20,
  previewEditMaxTextBytesPerChange: 32_000,
  previewEditMaxTotalTextBytes: 120_000,
  sqliteChangeMaxPayloadBytes: 32_000,
};

const editChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("replace_text"),
    path: z.string().describe("File path relative to workspace root."),
    oldText: z.string().describe("Exact text to find and replace. Use create for new files."),
    newText: z.string().describe("Replacement text."),
  }),
  z.object({
    type: z.literal("replace_range"),
    path: z.string().describe("File path relative to workspace root."),
    startLine: z.number().int().min(1).describe("1-indexed start line."),
    endLine: z.number().int().min(1).describe("1-indexed end line, inclusive."),
    newText: z.string().describe("Replacement text for the line range."),
  }),
  z.object({
    type: z.literal("insert_before"),
    path: z.string().describe("File path relative to workspace root."),
    anchor: z.string().describe("Anchor text to insert before. Uses the first occurrence."),
    text: z.string().describe("Text to insert."),
  }),
  z.object({
    type: z.literal("insert_after"),
    path: z.string().describe("File path relative to workspace root."),
    anchorAfter: z.string().describe("Anchor text to insert after. Uses the first occurrence."),
    text: z.string().describe("Text to insert."),
  }),
  z.object({
    type: z.literal("append"),
    path: z.string().describe("File path relative to workspace root."),
    text: z.string().describe("Text to append to the end of the file."),
  }),
  z.object({
    type: z.literal("create"),
    path: z.string().describe("File path relative to workspace root. The file must not already exist."),
    text: z.string().describe("Full file content."),
  }),
  z.object({
    type: z.literal("overwrite"),
    path: z.string().describe("File path relative to workspace root."),
    newText: z.string().describe("New full file content."),
  }),
  z.object({
    type: z.literal("rename"),
    path: z.string().describe("Current file path relative to workspace root."),
    newPath: z.string().describe("Target path relative to workspace root."),
  }),
  z.object({
    type: z.literal("delete"),
    path: z.string().describe("File path relative to workspace root."),
  }),
]);

const sqliteValueSchema = z.union([z.string(), z.number(), z.null()]);
const sqliteWhereConditionSchema = z.object({
  column: z.string().describe("Column name."),
  operator: z.enum(["=", "!=", ">", "<", ">=", "<=", "LIKE", "IS", "IS NOT"]),
  value: sqliteValueSchema,
});
const sqliteChangeSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("insert"),
    table: z.string().describe("Table name."),
    columns: z.array(z.string()).min(1).describe("Column names."),
    values: z.array(sqliteValueSchema).min(1).describe("Values matching columns order."),
  }),
  z.object({
    type: z.literal("update"),
    table: z.string().describe("Table name."),
    set: z.record(z.string(), sqliteValueSchema).describe("Column=value pairs. Use dot-path keys for jsonSet on text columns, e.g. job_json.enabled."),
    where: z.array(sqliteWhereConditionSchema).optional().describe("AND-joined WHERE conditions."),
    limit: z.number().int().min(1).max(100).optional().describe("Row limit. Defaults to 1. Avoid unbounded updates."),
    expected: z.record(z.string(), z.unknown()).optional().describe("Re-verify these field values on confirm. Prevents stale-preview writes."),
  }),
  z.object({
    type: z.literal("delete"),
    table: z.string().describe("Table name."),
    where: z.array(sqliteWhereConditionSchema).optional().describe("AND-joined WHERE conditions."),
    limit: z.number().int().min(1).max(100).optional().describe("Row limit. Defaults to 1. You must specify a limit or WHERE for deletes."),
    expected: z.record(z.string(), z.unknown()).optional().describe("Re-verify these field values on confirm."),
  }),
]);

const localStatusOutputSchema = z.object({
  result: z.string(),
  ok: z.boolean(),
  name: z.string(),
  version: z.string(),
  accessMode: z.string(),
  allowedRoots: z.array(z.string()),
  toolGroups: z.array(z.object({ type: z.string(), tools: z.array(z.string()) })),
  maxReadBytes: z.number(),
  maxOutputBytes: z.number(),
  maxSessions: z.number(),
  webToolsEnabled: z.boolean(),
  searchProvider: z.string(),
  searxngConfigured: z.boolean(),
  webMaxBytes: z.number(),
  webTimeoutMs: z.number(),
  sqliteToolsEnabled: z.boolean(),
  sqliteAllowedDbs: z.array(z.string()),
  sqliteMaxRows: z.number(),
});

const filesOutputSchema = z.object({
  result: z.string(),
  action: z.enum(["list", "read", "search", "find"]),
  path: z.string(),
  recursive: z.boolean().optional(),
  depth: z.number().int().optional(),
  truncated: z.boolean().optional(),
});

const processResultOutputSchema = z.object({
  result: z.string(),
  stdout: z.string(),
  stderr: z.string(),
  exitCode: z.number().nullable(),
  timedOut: z.boolean(),
});

const gitOutputSchema = processResultOutputSchema.extend({
  staged: z.boolean().optional(),
  path: z.string().optional(),
  statOnly: z.boolean().optional(),
});

const editOutputSchema = z.object({
  result: z.string(),
  action_id: z.string(),
  requires_approval: z.boolean().optional(),
  changes: z.array(z.object({
    path: z.string(),
    type: z.enum(["replace_text", "replace_range", "insert_before", "insert_after", "append", "create", "overwrite", "rename", "delete"]),
    diff: z.string(),
  })).optional(),
  applied: z.boolean().optional(),
  changeCount: z.number().int().optional(),
});

const execOutputSchema = processResultOutputSchema.extend({
  process_id: z.string().optional(),
  command: z.string().optional(),
  args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  running: z.boolean().optional(),
  startedAt: z.number().optional(),
  finishedAt: z.number().optional(),
});

const sqliteRowSchema = z.record(z.string(), z.unknown());
const sqliteOutputSchema = z.object({
  result: z.string(),
  rows: z.array(sqliteRowSchema).optional(),
  action_id: z.string().optional(),
  requires_approval: z.boolean().optional(),
  beforeRows: z.array(sqliteRowSchema).optional(),
  diff: z.string().optional(),
  applied: z.boolean().optional(),
  change_type: z.enum(["insert", "update", "delete"]).optional(),
  table: z.string().optional(),
});

const webSearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
  engine: z.string().optional(),
});
const webOutputSchema = z.object({
  result: z.string(),
  results: z.array(webSearchResultSchema).optional(),
  finalUrl: z.string().optional(),
  status: z.number().int().optional(),
  contentType: z.string().optional(),
  title: z.string().optional(),
  text: z.string().optional(),
  truncated: z.boolean().optional(),
});

const screenshotOutputSchema = z.object({
  result: z.string(),
  mode: z.enum(["desktop", "monitor", "window", "region"]),
  width: z.number().int(),
  height: z.number().int(),
  left: z.number().int(),
  top: z.number().int(),
  windowTitle: z.string().optional(),
  savedPath: z.string().optional(),
});

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function assertMaxBytes(label: string, value: string, maxBytes: number): void {
  const size = byteLength(value);
  if (size > maxBytes) {
    throw new Error(`${label} is too large (${size} bytes, max ${maxBytes}). Split it into smaller tool calls.`);
  }
}

function assertPreviewEditPayload(changes: unknown[]): void {
  if (changes.length > payloadLimits.previewEditMaxChanges) {
    throw new Error(`edit(action="preview") supports at most ${payloadLimits.previewEditMaxChanges} changes per call. Split the batch.`);
  }
  let totalBytes = 0;
  for (const [index, raw] of changes.entries()) {
    const change = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
    for (const field of ["oldText", "newText", "text", "anchor", "anchorAfter"]) {
      const value = change[field];
      if (typeof value !== "string") continue;
      const size = byteLength(value);
      totalBytes += size;
      if (size > payloadLimits.previewEditMaxTextBytesPerChange) {
        throw new Error(`edit(action="preview") changes[${index}].${field} is too large (${size} bytes). Split it into smaller edits.`);
      }
    }
  }
  if (totalBytes > payloadLimits.previewEditMaxTotalTextBytes) {
    throw new Error(`edit(action="preview") payload is too large (${totalBytes} bytes). Split it into smaller tool calls.`);
  }
}

function assertSqliteChangePayload(change: unknown): void {
  assertMaxBytes('sqlite(action="preview") payload', JSON.stringify(change), payloadLimits.sqliteChangeMaxPayloadBytes);
}

function assertEditChangePaths(workspaceId: string, changes: Change[]): void {
  for (const change of changes) {
    const { workspace, absolutePath } = workspaces.resolve(workspaceId, change.path);
    assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
    if (change.type === "rename" && change.newPath) {
      const { workspace: targetWorkspace, absolutePath: targetPath } = workspaces.resolve(workspaceId, change.newPath);
      assertNotDenied(targetPath, targetWorkspace.root, config.denyGlobs);
    }
  }
}

// --- MCP Server factory ---

function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "chatgpt-codex-tools-mcp",
      title: "ChatGPT Codex Tools",
      version: SERVER_VERSION,
      description: "Compact Codex-style local workspace tools for ChatGPT: workspace files, local Git inspection, preview-confirm edits, structured execution, allowlisted SQLite, public web access, and Windows screenshots.",
    },
    {
      instructions:
        "You are a local coding assistant using a compact workspace-scoped toolbox. Typical workflow:\n" +
        "1. `open_workspace` once to get a workspaceId.\n" +
        "2. Use `files` with action=list/read/search/find; list with recursive=true replaces the old project tree tool.\n" +
        "3. Use `git` with action=status/diff for local Git only; use GitHub-specific tooling for remote operations.\n" +
        "4. Use `edit` action=preview, review its diff, then `edit` action=confirm with actionId.\n" +
        "5. Use `exec` action=run/start/read/stop for structured executable invocation without a shell.\n" +
        "6. Use `sqlite` action=schema/select/preview/confirm; writes remain preview-then-confirm.\n" +
        "7. Use `web` action=search/fetch for configured public web access.\n" +
        "8. Use `screenshot` only when the user asks to inspect current desktop/window UI; it returns PNG pixels directly.\n" +
        "Use preview-then-confirm for writes where that workflow exists.",
    },
  );

  // ============================================================
  // local_status — server info
  // ============================================================

  server.registerTool(
    "local_status",
    {
      title: "Local status",
      description: "Server status, access mode, allowed roots, caps, and optional feature config. Call once to discover what's available.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      outputSchema: localStatusOutputSchema,
    },
    async () => {
      const status = {
        ok: true,
        name: "chatgpt-codex-tools-mcp",
        version: SERVER_VERSION,
        accessMode: config.accessMode,
        allowedRoots: config.allowedRoots,
        toolGroups: TOOL_GROUPS,
        maxReadBytes: config.maxReadBytes,
        maxOutputBytes: config.maxOutputBytes,
        maxSessions: config.maxSessions,
        webToolsEnabled: config.webToolsEnabled,
        searchProvider: config.searchProvider,
        searxngConfigured: Boolean(config.searxngUrl),
        webMaxBytes: config.webMaxBytes,
        webTimeoutMs: config.webTimeoutMs,
        sqliteToolsEnabled: config.sqliteToolsEnabled,
        sqliteAllowedDbs: config.sqliteAllowedDbs,
        sqliteMaxRows: config.sqliteMaxRows,
      };
      return textResult(JSON.stringify(status, null, 2), status);
    },
  );

  // ============================================================
  // open_workspace — start a workspace session
  // ============================================================

  server.registerTool(
    "open_workspace",
    {
      title: "Open workspace",
      description: "Open a local project directory under CTM_ALLOWED_ROOTS. Returns a workspaceId you reuse across all other tools. Call this first.",
      inputSchema: {
        path: z.string().describe("Absolute path to a local project directory inside an allowed root."),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string(), workspaceId: z.string(), root: z.string() }),
    },
    async ({ path }) => {
      const workspace = await workspaces.open(path);
      return textResult(`Opened workspace ${workspace.id}\nRoot: ${workspace.root}`, {
        workspaceId: workspace.id,
        root: workspace.root,
      });
    },
  );
  // ============================================================
  // files — list/read/search/find in one workspace tool
  // ============================================================

  server.registerTool(
    "files",
    {
      title: "Workspace files",
      description: "Inspect workspace files. action=list supports recursive=true + depth for a project tree; action=read/search/find cover text reading, content search, and filename glob search.",
      inputSchema: {
        action: z.enum(["list", "read", "search", "find"]),
        workspaceId: z.string(),
        path: z.string().default(".").describe("Path relative to workspace root."),
        recursive: z.boolean().default(false).describe("For action=list, recursively render a project tree."),
        depth: z.number().int().min(1).max(5).default(3).describe("For recursive list, maximum directory depth."),
        pattern: z.string().optional().describe("Required for search/find."),
        caseSensitive: z.boolean().default(false).describe("For search, enable case-sensitive matching."),
        contextLines: z.number().int().min(0).max(20).default(0).describe("For search, context lines around matches."),
        maxMatches: z.number().int().min(1).max(5000).default(1000).describe("For search, maximum matching lines."),
        maxResults: z.number().int().min(1).max(500).default(100).describe("For find, maximum matching files."),
        include: z.string().optional().describe("For search, only include matching glob paths."),
        exclude: z.string().optional().describe("For search, exclude matching glob paths."),
      },
      annotations: { readOnlyHint: true },
      outputSchema: filesOutputSchema,
    },
    async ({ action, workspaceId, path, recursive, depth, pattern, caseSensitive, contextLines, maxMatches, maxResults, include, exclude }) => {
      const { workspace, absolutePath } = workspaces.resolve(workspaceId, path);
      assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
      const displayPath = relativeDisplayPath(workspace.root, absolutePath);

      if (action === "list") {
        if (recursive) {
          const tree = await buildProjectTree(workspace.root, absolutePath, 0, depth);
          return textResult(tree || "(empty)", { action, path: displayPath, recursive, depth });
        }
        const entries = await readdir(absolutePath, { withFileTypes: true });
        const lines = entries
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
          .join("\n");
        return textResult(lines || "(empty)", { action, path: displayPath, recursive: false });
      }

      if (action === "read") {
        const content = await readFileCapped(absolutePath, config.maxReadBytes);
        return textResult(content.text, { action, path: displayPath, truncated: content.truncated });
      }

      if (!pattern) throw new Error(`pattern is required for files action=${action}.`);
      if (action === "search") {
        const includeMatcher = include ? createGlobMatcher(include, { matchBasename: true }) : null;
        const excludeMatcher = exclude ? createGlobMatcher(exclude, { matchBasename: true }) : null;
        const output = await searchTextFiles(
          workspace.root,
          absolutePath,
          pattern,
          caseSensitive,
          contextLines,
          maxMatches,
          include,
          exclude,
          includeMatcher,
          excludeMatcher,
        );
        return textResult(output || "(no matches)", { action, path: displayPath });
      }

      const matcher = createGlobMatcher(pattern, { matchBasename: true });
      const results = await findFilesByGlob(workspace.root, absolutePath, matcher, maxResults);
      return textResult(results.length > 0 ? results.join("\n") : "(no matching files)", { action, path: displayPath });
    },
  );

  // ============================================================
  // git — local status/diff only
  // ============================================================

  server.registerTool(
    "git",
    {
      title: "Local Git",
      description: "Inspect the local Git working tree. action=status runs git status --short; action=diff reviews staged/unstaged diffs. Remote GitHub operations belong in GitHub/gh tooling.",
      inputSchema: {
        action: z.enum(["status", "diff"]),
        workspaceId: z.string(),
        staged: z.boolean().default(false),
        path: z.string().optional(),
        statOnly: z.boolean().default(false),
        maxBytes: z.number().int().positive().max(config.maxOutputBytes).default(config.maxOutputBytes),
      },
      annotations: { readOnlyHint: true },
      outputSchema: gitOutputSchema,
    },
    async ({ action, workspaceId, staged, path, statOnly, maxBytes }) => {
      if (action === "status") return gitTool(workspaceId, ["status", "--short"]);
      return gitDiffTool(workspaceId, { staged, path, statOnly, maxBytes });
    },
  );

  // ============================================================
  // edit — preview/confirm file changes
  // ============================================================

  server.registerTool(
    "edit",
    {
      title: "Edit files",
      description: "Preview or confirm bounded workspace edits. Use action=preview first; apply only with action=confirm and the returned actionId.",
      inputSchema: {
        action: z.enum(["preview", "confirm"]),
        workspaceId: z.string().optional().describe("Required for preview."),
        changes: z.array(editChangeSchema).min(1).optional().describe("Required for preview."),
        actionId: z.string().optional().describe("Required for confirm."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      outputSchema: editOutputSchema,
    },
    async ({ action, workspaceId, changes, actionId }) => {
      if (action === "preview") {
        if (!workspaceId || !changes) throw new Error("workspaceId and changes are required for edit action=preview.");
        const typedChanges = changes as Change[];
        assertPreviewEditPayload(typedChanges);
        assertEditChangePaths(workspaceId, typedChanges);
        const { absolutePath } = workspaces.resolve(workspaceId, ".");
        const diffs = await previewChanges(absolutePath, typedChanges);
        const pending = edits.create({ workspaceId, changes: typedChanges, diffs });
        const combinedDiff = diffs.map((d) => `--- ${d.path} (${d.type}) ---\n${d.diff}`).join("\n\n");
        return textResult(`Pending edit: ${pending.id}\n\n${combinedDiff}`, {
          action_id: pending.id,
          requires_approval: true,
          changes: diffs,
        });
      }

      if (!actionId) throw new Error("actionId is required for edit action=confirm.");
      const pending = edits.take(actionId);
      assertEditChangePaths(pending.workspaceId, pending.changes);
      const { absolutePath } = workspaces.resolve(pending.workspaceId, ".");
      await applyChanges(absolutePath, pending.changes);
      return textResult(`Applied ${pending.changes.length} change(s) from ${actionId}`, {
        applied: true,
        action_id: actionId,
        changeCount: pending.changes.length,
      });
    },
  );

  // ============================================================
  // exec — run/start/read/stop structured processes
  // ============================================================

  server.registerTool(
    "exec",
    {
      title: "Execute process",
      description: "Run or manage local executables with structured argv and no shell. action=run waits for a short command; start/read/stop manage long-running processes.",
      inputSchema: {
        action: z.enum(["run", "start", "read", "stop"]),
        workspaceId: z.string().optional().describe("Required for run/start."),
        command: z.string().optional().describe("Required for run/start."),
        args: z.array(z.string()).default([]),
        workingDirectory: z.string().default("."),
        timeoutSeconds: z.number().int().positive().max(3600).optional(),
        maxBytes: z.number().int().positive().max(config.maxOutputBytes).optional(),
        processId: z.string().optional().describe("Required for read/stop."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
      outputSchema: execOutputSchema,
    },
    async ({ action, workspaceId, command, args, workingDirectory, timeoutSeconds, maxBytes, processId }) => {
      if (action === "read" || action === "stop") {
        if (!processId) throw new Error(`processId is required for exec action=${action}.`);
        return action === "read"
          ? managedProcessResult(managedProcesses.read(processId))
          : managedProcessResult(managedProcesses.stop(processId));
      }

      if (!workspaceId || !command) throw new Error(`workspaceId and command are required for exec action=${action}.`);
      assertProcessAllowed(command, args, config.accessMode);
      const { absolutePath } = workspaces.resolve(workspaceId, workingDirectory);
      const dirStat = await stat(absolutePath);
      if (!dirStat.isDirectory()) throw new Error(`workingDirectory is not a directory: ${workingDirectory}`);
      const outputLimit = Math.min(maxBytes ?? config.maxOutputBytes, config.maxOutputBytes);

      if (action === "run") {
        const timeout = Math.min(timeoutSeconds ?? 30, 300);
        const result = await runProcess({ command, args, cwd: absolutePath, timeoutMs: timeout * 1000, maxOutputBytes: outputLimit });
        return textResult(formatProcessResult(result), result);
      }

      const timeout = Math.min(timeoutSeconds ?? 300, 3600);
      return managedProcessResult(managedProcesses.start({
        command,
        args,
        cwd: absolutePath,
        timeoutMs: timeout * 1000,
        maxOutputBytes: outputLimit,
      }));
    },
  );

  // ============================================================
  // sqlite — schema/select/preview/confirm in one tool
  // ============================================================

  server.registerTool(
    "sqlite",
    {
      title: "SQLite",
      description: "Allowlisted SQLite inspection and structured writes. action=schema/select are read-only; preview/confirm preserve the two-step write workflow.",
      inputSchema: {
        action: z.enum(["schema", "select", "preview", "confirm"]),
        dbPath: z.string().optional(),
        sql: z.string().optional().describe("Required for select; SELECT/WITH or safe PRAGMA only."),
        params: z.array(z.union([z.string(), z.number(), z.null()])).default([]),
        limit: z.number().int().positive().max(config.sqliteMaxRows).optional(),
        change: sqliteChangeSchema.optional().describe("Required for preview."),
        actionId: z.string().optional().describe("Required for confirm."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      outputSchema: sqliteOutputSchema,
    },
    async ({ action, dbPath, sql, params, limit, change, actionId }) => {
      if (!config.sqliteToolsEnabled) throw new Error("SQLite tools are disabled. Enable sqlite in config.json or CTM_SQLITE_TOOLS=1.");
      if (action === "schema") {
        const rows = sqliteSchema(config, dbPath);
        return textResult(JSON.stringify(rows, null, 2), { rows });
      }
      if (action === "select") {
        if (!sql) throw new Error("sql is required for sqlite action=select.");
        const rows = sqliteSelect(config, { dbPath, sql, params, limit: limit ?? config.sqliteMaxRows });
        return textResult(JSON.stringify(rows, null, 2), { rows });
      }
      if (action === "preview") {
        if (!change) throw new Error("change is required for sqlite action=preview.");
        assertSqliteChangePayload(change);
        const { action: pending, beforeRows, diff } = sqlitePreviewChange(config, { dbPath, change: change as any });
        return textResult(`Pending sqlite change: ${pending.id}\n\n${diff}`, {
          action_id: pending.id,
          requires_approval: true,
          beforeRows,
          diff,
        });
      }
      if (!actionId) throw new Error("actionId is required for sqlite action=confirm.");
      const result = sqliteConfirmChange(config, actionId);
      return textResult(`Applied sqlite change: ${actionId} (${result.change_type} on ${result.table})`, result);
    },
  );

  // ============================================================
  // web — search/fetch in one tool
  // ============================================================

  server.registerTool(
    "web",
    {
      title: "Web",
      description: "Configured public web access. action=search queries SearXNG; action=fetch retrieves public HTTP(S) while blocking private/local targets.",
      inputSchema: {
        action: z.enum(["search", "fetch"]),
        query: z.string().optional().describe("Required for search."),
        limit: z.number().int().min(1).max(10).default(5),
        url: z.string().url().optional().describe("Required for fetch."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
      outputSchema: webOutputSchema,
    },
    async ({ action, query, limit, url }) => {
      if (!config.webToolsEnabled) throw new Error("Web tools are disabled. Enable web in config.json or CTM_WEB_TOOLS=1.");
      if (action === "search") {
        if (!query) throw new Error("query is required for web action=search.");
        const results = await webSearch(config, query, limit);
        return textResult(
          results.length === 0 ? "(no results)" : results.map((r) => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`).join("\n\n"),
          { results },
        );
      }
      if (!url) throw new Error("url is required for web action=fetch.");
      const result = await webFetch(config, url);
      return textResult(
        [
          `final_url: ${result.finalUrl}`,
          `status: ${result.status}`,
          `content_type: ${result.contentType}`,
          result.truncated ? "[output truncated]\n" : "",
          result.text.slice(0, config.maxReadBytes),
        ].filter(Boolean).join("\n"),
        result,
      );
    },
  );

  // ============================================================
  // screenshot — return desktop/window pixels directly to ChatGPT
  // ============================================================

  server.registerTool(
    "screenshot",
    {
      title: "Screenshot",
      description: "Capture the current Windows desktop, monitor, window, or screen region and return a PNG image directly. Use only when the user asks to inspect current UI. Optional savePath must be inside an open workspace.",
      inputSchema: {
        mode: z.enum(["desktop", "monitor", "window", "region"]).default("desktop"),
        workspaceId: z.string().optional().describe("Required only when savePath is used."),
        monitor: z.number().int().min(0).default(0),
        windowTitle: z.string().optional().describe("For window mode, case-insensitive title substring."),
        windowHandle: z.number().int().positive().optional().describe("For window mode, optional HWND as an integer."),
        x: z.number().int().optional(),
        y: z.number().int().optional(),
        width: z.number().int().positive().max(20000).optional(),
        height: z.number().int().positive().max(20000).optional(),
        savePath: z.string().optional().describe("Optional workspace-relative PNG path. Omit to avoid writing a file."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      outputSchema: screenshotOutputSchema,
    },
    async ({ mode, workspaceId, monitor, windowTitle, windowHandle, x, y, width, height, savePath }) => {
      let absoluteSavePath: string | undefined;
      let displaySavePath: string | undefined;
      if (savePath) {
        if (!workspaceId) throw new Error("workspaceId is required when screenshot savePath is used.");
        const resolved = workspaces.resolve(workspaceId, savePath);
        assertNotDenied(resolved.absolutePath, resolved.workspace.root, config.denyGlobs);
        absoluteSavePath = resolved.absolutePath;
        displaySavePath = relativeDisplayPath(resolved.workspace.root, resolved.absolutePath);
      }

      const shot = await captureScreenshot({
        mode,
        monitor,
        windowTitle,
        windowHandle,
        x,
        y,
        width,
        height,
        savePath: absoluteSavePath,
      });
      const matchedWindowTitle = shot.windowTitle ? redactText(shot.windowTitle) : undefined;
      const summary = [
        `Captured ${mode} screenshot: ${shot.width}x${shot.height}`,
        matchedWindowTitle ? `window: ${matchedWindowTitle}` : undefined,
        displaySavePath ? `saved: ${displaySavePath}` : "saved: no (returned in-memory)",
      ].filter(Boolean).join("\n");
      const redactedSummary = redactText(summary);
      const structuredContent = redactValue({
        result: redactedSummary,
        mode,
        width: shot.width,
        height: shot.height,
        left: shot.left,
        top: shot.top,
        windowTitle: matchedWindowTitle,
        savedPath: displaySavePath,
      }) as Record<string, unknown>;
      return {
        content: [
          { type: "text" as const, text: redactedSummary },
          { type: "image" as const, data: shot.data, mimeType: shot.mimeType },
        ],
        structuredContent,
      };
    },
  );

  return server;
}

// --- Git helper ---

async function gitTool(workspaceId: string, args: string[]) {
  const workspace = workspaces.get(workspaceId);
  const result = await runProcess({ command: "git", args, cwd: workspace.root, timeoutMs: 30_000, maxOutputBytes: config.maxOutputBytes });
  return textResult(formatProcessResult(result), result);
}

async function gitDiffTool(
  workspaceId: string,
  options: { staged: boolean; path?: string; statOnly: boolean; maxBytes: number },
) {
  const workspace = workspaces.get(workspaceId);
  const maxBytes = Math.min(options.maxBytes ?? config.maxOutputBytes, config.maxOutputBytes);
  let pathspec: string | undefined;

  if (options.path) {
    const { absolutePath } = workspaces.resolve(workspaceId, options.path);
    assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
    pathspec = relativeDisplayPath(workspace.root, absolutePath);
  }

  const baseArgs = ["diff"];
  if (options.staged) baseArgs.push("--cached");
  const pathArgs = pathspec ? ["--", pathspec] : [];

  const statResult = await runProcess({
    command: "git",
    args: [...baseArgs, "--stat", ...pathArgs],
    cwd: workspace.root,
    timeoutMs: 30_000,
    maxOutputBytes: maxBytes,
  });

  if (statResult.exitCode !== 0 || options.statOnly) {
    return textResult(formatProcessResult(statResult), {
      ...statResult,
      staged: options.staged,
      path: pathspec,
      statOnly: options.statOnly,
    });
  }

  const diffResult = await runProcess({
    command: "git",
    args: [...baseArgs, ...pathArgs],
    cwd: workspace.root,
    timeoutMs: 30_000,
    maxOutputBytes: maxBytes,
  });
  const result = combineProcessResults([statResult, diffResult], maxBytes);
  return textResult(formatProcessResult(result), {
    ...result,
    staged: options.staged,
    path: pathspec,
    statOnly: options.statOnly,
  });
}

function combineProcessResults(results: ProcessResult[], maxBytes: number): ProcessResult {
  return {
    stdout: capText(results.map((result) => result.stdout.trimEnd()).filter(Boolean).join("\n\n"), maxBytes),
    stderr: capText(results.map((result) => result.stderr.trimEnd()).filter(Boolean).join("\n\n"), maxBytes),
    exitCode: results.find((result) => result.exitCode !== 0)?.exitCode ?? results[results.length - 1]?.exitCode ?? null,
    timedOut: results.some((result) => result.timedOut),
  };
}

function capText(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  return text.slice(0, maxBytes) + "\n[output truncated]\n";
}

// --- Result helper ---

function textResult(text: string, structuredContent: object = {}) {
  const redactedText = redactText(text);
  const redactedStructuredContent = redactValue({ result: redactedText, ...structuredContent });
  return {
    content: [{ type: "text" as const, text: redactedText }],
    structuredContent: redactedStructuredContent,
  };
}



function managedProcessResult(snapshot: ManagedProcessSnapshot) {
  return textResult(
    [
      `process_id: ${snapshot.id}`,
      `running: ${snapshot.running}`,
      `exit_code: ${snapshot.exitCode}`,
      `timed_out: ${snapshot.timedOut}`,
      snapshot.stdout ? `stdout:\n${snapshot.stdout}` : undefined,
      snapshot.stderr ? `stderr:\n${snapshot.stderr}` : undefined,
    ].filter(Boolean).join("\n"),
    {
      process_id: snapshot.id,
      command: snapshot.command,
      args: snapshot.args,
      cwd: snapshot.cwd,
      running: snapshot.running,
      startedAt: snapshot.startedAt,
      finishedAt: snapshot.finishedAt,
      stdout: snapshot.stdout,
      stderr: snapshot.stderr,
      exitCode: snapshot.exitCode,
      timedOut: snapshot.timedOut,
    },
  );
}

// --- File reading ---

async function readFileCapped(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const buffer = await readFile(path);
  if (buffer.byteLength <= maxBytes) return { text: buffer.toString("utf8"), truncated: false };
  return { text: buffer.subarray(0, maxBytes).toString("utf8") + "\n[file truncated]\n", truncated: true };
}

// --- Enhanced search_text_files ---

async function searchTextFiles(
  workspaceRoot: string,
  startPath: string,
  pattern: string,
  caseSensitive: boolean,
  contextLines: number,
  maxMatches: number,
  includePatternText: string | undefined,
  excludePatternText: string | undefined,
  includeMatcher: GlobMatcher | null,
  excludeMatcher: GlobMatcher | null,
): Promise<string> {
  const ripgrepOutput = await searchTextFilesWithRipgrep(
    workspaceRoot,
    startPath,
    pattern,
    caseSensitive,
    contextLines,
    maxMatches,
    includePatternText,
    excludePatternText,
  );
  if (ripgrepOutput !== null) return ripgrepOutput;

  const needle = caseSensitive ? pattern : pattern.toLowerCase();
  const lines: string[] = [];
  let outputBytes = 0;

  async function walk(path: string, relBase: string): Promise<void> {
    if (lines.length >= maxMatches) return;
    if (outputBytes > config.maxOutputBytes) return;

    let info;
    try {
      info = await stat(path);
      assertNotDenied(path, workspaceRoot, config.denyGlobs);
    } catch {
      return;
    }

    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
        const childRel = relBase ? `${relBase}/${entry.name}` : entry.name;
        if (excludeMatcher && (excludeMatcher(childRel) || excludeMatcher(`${childRel}/`))) continue;
        await walk(join(path, entry.name), childRel);
      }
      return;
    }

    if (!info.isFile()) return;
    const relPath = relBase || relativeDisplayPath(workspaceRoot, path);
    if (excludeMatcher && excludeMatcher(relPath)) return;
    if (includeMatcher && !includeMatcher(relPath)) return;

    let text: string;
    try {
      text = (await readFileCapped(path, Math.min(config.maxReadBytes, 128_000))).text;
    } catch {
      return;
    }

    const fileLines = text.split(/\r?\n/);

    for (let index = 0; index < fileLines.length && lines.length < maxMatches; index++) {
      const line = fileLines[index];
      const matchTarget = caseSensitive ? line : line.toLowerCase();
      const matchResult = matchTarget.includes(needle);

      if (matchResult) {
        const displayLine = line.length > 300 ? `${line.slice(0, 300)}...` : line;

        if (contextLines > 0) {
          const contextStart = Math.max(0, index - contextLines);
          const contextEnd = Math.min(fileLines.length - 1, index + contextLines);
          if (contextStart < index) {
            pushSearchLine(`... ${relPath}:${contextStart + 1}-${index} (context)`);
          }
          pushSearchLine(`${relPath}:${index + 1}: ${displayLine}`);
          if (contextEnd > index) {
            pushSearchLine(`... ${relPath}:${index + 2}-${contextEnd + 1} (context)`);
          }
        } else {
          pushSearchLine(`${relPath}:${index + 1}: ${displayLine}`);
        }
      }
    }
  }

  const baseRel = startPath === "." ? "" : relative(workspaceRoot, startPath).replace(/\\/g, "/");
  await walk(startPath, startPath === workspaceRoot ? "" : baseRel);

  const output = lines.slice(0, maxMatches).join("\n");
  if (Buffer.byteLength(output, "utf8") <= config.maxOutputBytes) return output;
  return output.slice(0, config.maxOutputBytes) + "\n[output truncated]\n";

  function pushSearchLine(line: string): void {
    if (lines.length >= maxMatches || outputBytes > config.maxOutputBytes) return;
    lines.push(line);
    outputBytes += Buffer.byteLength(line, "utf8") + 1;
  }
}

async function searchTextFilesWithRipgrep(
  workspaceRoot: string,
  startPath: string,
  pattern: string,
  caseSensitive: boolean,
  contextLines: number,
  maxMatches: number,
  includePatternText: string | undefined,
  excludePatternText: string | undefined,
): Promise<string | null> {
  const pathArg = startPath === workspaceRoot ? "." : relative(workspaceRoot, startPath).replace(/\\/g, "/");
  const args = [
    "--color",
    "never",
    "--line-number",
    "--no-heading",
    "--with-filename",
    "--fixed-strings",
  ];
  if (!caseSensitive) args.push("--ignore-case");
  if (contextLines > 0) args.push("--context", String(contextLines));

  for (const glob of ["node_modules/**", "dist/**", ".git/**"]) {
    args.push("--glob", `!${glob}`);
  }
  for (const glob of config.denyGlobs) {
    args.push("--glob", `!${glob.replace(/\\/g, "/")}`);
  }
  for (const glob of splitGlobPatterns(includePatternText ?? "")) {
    args.push("--glob", glob);
  }
  for (const glob of splitGlobPatterns(excludePatternText ?? "")) {
    args.push("--glob", `!${glob}`);
  }
  args.push("--", pattern, pathArg);

  const result = await runProcess({
    command: "rg",
    args,
    cwd: workspaceRoot,
    timeoutMs: 30_000,
    maxOutputBytes: config.maxOutputBytes,
  });

  if (result.exitCode === null && /enoent|not found|could not be found/i.test(result.stderr)) return null;
  if (result.exitCode === 1) return "";
  if (result.exitCode !== 0) return null;

  const lines = result.stdout.split(/\r?\n/).filter((line) => line.length > 0);
  const filteredLines = filterRipgrepOutputLines(workspaceRoot, lines, maxMatches);
  return capText(filteredLines.join("\n"), config.maxOutputBytes);
}

function filterRipgrepOutputLines(workspaceRoot: string, lines: string[], maxLines: number): string[] {
  const output: string[] = [];
  for (const line of lines) {
    const relPath = parseRipgrepOutputPath(line);
    if (relPath) {
      try {
        assertNotDenied(join(workspaceRoot, relPath), workspaceRoot, config.denyGlobs);
      } catch {
        continue;
      }
    }
    if (line === "--" && (output.length === 0 || output[output.length - 1] === "--")) continue;
    output.push(normalizeRipgrepOutputLine(line));
    if (output.length >= maxLines) break;
  }
  while (output[output.length - 1] === "--") output.pop();
  return output;
}

function parseRipgrepOutputPath(line: string): string | null {
  const match = /^(.+?)(?::|-)\d+(?::|-)/.exec(line);
  return match ? normalizeToolPath(match[1]) : null;
}

function normalizeRipgrepOutputLine(line: string): string {
  const match = /^(.+?)(?=[:|-]\d+[:|-])/.exec(line);
  if (!match) return line;
  return `${normalizeToolPath(match[1])}${line.slice(match[1].length)}`;
}

function normalizeToolPath(path: string): string {
  let normalized = path.replace(/\\/g, "/");
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  return normalized;
}

// --- files(action="find") helpers ---

async function findFilesByGlob(
  workspaceRoot: string,
  startPath: string,
  matcher: GlobMatcher,
  maxResults: number,
): Promise<string[]> {
  const results: string[] = [];

  async function walk(path: string): Promise<void> {
    if (results.length >= maxResults) return;

    let info;
    try {
      info = await stat(path);
      assertNotDenied(path, workspaceRoot, config.denyGlobs);
    } catch {
      return;
    }

    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      for (const entry of entries) {
        if (["node_modules", "dist", ".git"].includes(entry.name)) continue;
        await walk(join(path, entry.name));
      }
      return;
    }

    if (!info.isFile()) return;

    const relPath = relative(workspaceRoot, path).replace(/\\/g, "/");
    if (matcher(relPath)) {
      results.push(relPath);
    }
  }

  await walk(startPath);
  return results.slice(0, maxResults);
}

// --- files(action="list") recursive helpers ---

async function buildProjectTree(
  root: string,
  startPath: string,
  currentDepth: number,
  maxDepth: number,
): Promise<string> {
  const lines: string[] = [];

  async function walk(path: string, depth: number, prefix: string): Promise<void> {
    if (depth > maxDepth) return;

    let info;
    try {
      info = await stat(path);
      assertNotDenied(path, root, config.denyGlobs);
    } catch {
      return;
    }

    if (info.isDirectory()) {
      const entries = await readdir(path, { withFileTypes: true });
      const dirs = entries.filter((e) => e.isDirectory() && !["node_modules", "dist", ".git"].includes(e.name)).sort((a, b) => a.name.localeCompare(b.name));
      const files = entries.filter((e) => e.isFile()).sort((a, b) => a.name.localeCompare(b.name));

      if (depth > 0) {
        lines.push(`${prefix}📁 ${path.split(sep).pop()}/`);
      }

      const newPrefix = depth === 0 ? "" : `${prefix}  `;
      for (const dir of dirs) {
        await walk(join(path, dir.name), depth + 1, `${newPrefix}  `);
      }
      for (const file of files) {
        lines.push(`${newPrefix}📄 ${file.name}`);
      }
    } else {
      lines.push(`📄 ${relative(root, path)}`);
    }
  }

  await walk(startPath, currentDepth, "");
  return lines.join("\n");
}

// --- Process result formatter ---

function formatProcessResult(result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }): string {
  return [
    `exit_code: ${result.exitCode}`,
    `timed_out: ${result.timedOut}`,
    result.stdout ? `stdout:\n${result.stdout}` : undefined,
    result.stderr ? `stderr:\n${result.stderr}` : undefined,
  ].filter(Boolean).join("\n");
}

// ============================================================
// Express server setup
// ============================================================

const app = express();
app.use((req, res, next) => {
  const start = Date.now();
  res.once("finish", () => {
    if (req.path === "/mcp" || req.path === "/healthz") {
      console.log(`${req.method} ${req.originalUrl} -> ${res.statusCode} ${Date.now() - start}ms`);
    }
  });
  next();
});
app.use(express.json({ limit: "4mb" }));
app.use(express.urlencoded({ extended: false }));
app.get("/healthz", (_req, res) => res.json({ ok: true, name: "chatgpt-codex-tools-mcp" }));

// Keep MCP sessions alive across long-idle ChatGPT windows. Memory remains bounded by
// evicting only the least-recently-used sessions when the configured cap is exceeded.
const transports = new SessionRegistry<StreamableHTTPServerTransport>(config.maxSessions);

app.all("/mcp", async (req, res) => {
  const sessionId = req.header("mcp-session-id");
  const initializeRequest = req.method === "POST" && isInitializeRequest(req.body);

  try {
    let transport: StreamableHTTPServerTransport | undefined;
    if (sessionId) {
      transport = transports.get(sessionId);
      if (!transport) {
        res.status(404).json({ error: "Unknown MCP session" });
        return;
      }
    } else if (initializeRequest) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (newSessionId) => {
          if (!transport) return;
          const evicted = transports.set(newSessionId, transport);
          if (evicted.length > 0) {
            console.log(`MCP session LRU: evicted ${evicted.length} old session(s); cap=${config.maxSessions}`);
          }
        },
      });
      transport.onclose = () => {
        if (transport?.sessionId) transports.delete(transport.sessionId);
      };
      await createMcpServer().connect(transport);
    } else {
      res.status(400).json({ error: "No valid MCP session" });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  }
});

app.listen(config.port, config.host, () => {
  console.log(`chatgpt-codex-tools-mcp listening on http://${config.host}:${config.port}/mcp`);
  console.log(`allowed roots: ${config.allowedRoots.join(", ")}`);
  console.log(`access mode: ${config.accessMode}`);
  console.log("auth: no authentication (use only behind a private/local tunnel)");
});
