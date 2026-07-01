import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
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
import { assertCommandAllowed, runCommand, runProcess, type ProcessResult } from "./process-runner.js";
import { redactText, redactValue } from "./redaction.js";
import {
  sqliteStatus,
  sqliteSchema,
  sqliteSelect,
  sqlitePreviewChange,
  sqliteConfirmChange,
} from "./sqlite-tools.js";
import { webFetch, webSearch, webStatus } from "./web.js";
import { WorkspaceRegistry } from "./workspaces.js";

const config = loadConfig();
const workspaces = new WorkspaceRegistry(config);
const edits = new EditStore();

// --- Pending shell action store ---

interface PendingShellAction {
  id: string;
  workspaceId: string;
  command: string;
  workingDirectory: string;
  timeoutSeconds: number;
  createdAt: number;
}

class ShellActionStore {
  private readonly actions = new Map<string, PendingShellAction>();

  create(input: Omit<PendingShellAction, "id" | "createdAt">): PendingShellAction {
    const action = { ...input, id: `act_${randomUUID()}`, createdAt: Date.now() };
    this.actions.set(action.id, action);
    return action;
  }

  take(actionId: string): PendingShellAction {
    const action = this.actions.get(actionId);
    if (!action) throw new Error(`Unknown shell actionId: ${actionId}`);
    this.actions.delete(actionId);
    return action;
  }
}

const shellActions = new ShellActionStore();

const payloadLimits = {
  previewEditMaxChanges: 20,
  previewEditMaxTextBytesPerChange: 32_000,
  previewEditMaxTotalTextBytes: 120_000,
  previewShellMaxCommandChars: 800,
  sqliteChangeMaxPayloadBytes: 32_000,
};

const blockedShellPayloadPatterns = [
  /frombase64string/i,
  /writeallbytes/i,
  /encodedcommand/i,
  /set-content/i,
  /add-content/i,
  /out-file/i,
  /@['"]/,
];

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
    throw new Error(`preview_edit supports at most ${payloadLimits.previewEditMaxChanges} changes per call. Split the batch.`);
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
        throw new Error(`preview_edit changes[${index}].${field} is too large (${size} bytes). Split it into smaller edits.`);
      }
    }
  }
  if (totalBytes > payloadLimits.previewEditMaxTotalTextBytes) {
    throw new Error(`preview_edit payload is too large (${totalBytes} bytes). Split it into smaller tool calls.`);
  }
}

function assertPreviewShellPayload(command: string): void {
  if (command.length > payloadLimits.previewShellMaxCommandChars) {
    throw new Error(`preview_shell command is too long (${command.length} chars). Use smaller commands or preview_edit for file changes.`);
  }
  if (blockedShellPayloadPatterns.some((pattern) => pattern.test(command))) {
    throw new Error("preview_shell blocks bulk write/encoded payload patterns. Use preview_edit with small changes instead.");
  }
}

function assertSqliteChangePayload(change: unknown): void {
  assertMaxBytes("sqlite_preview_change payload", JSON.stringify(change), payloadLimits.sqliteChangeMaxPayloadBytes);
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
      version: "0.4.4",
      description: "Codex-style local workspace tools for ChatGPT. Constrained local execution: edit files preview-then-confirm, read/search/tree for inspection, SQLite schema/select + structured change workflow, git status/diff, web search/fetch.",
    },
    {
      instructions:
        "You are a local coding assistant using workspace-scoped tools. Typical workflow:\n" +
        "1. `open_workspace` once to get a workspaceId.\n" +
        "2. Use `list_dir`, `read_file`, `search_files`, `find_files`, `project_tree` for inspection.\n" +
        "3. `git_status`/`git_diff` to review local changes.\n" +
        "4. For edits: use `preview_edit` with one or more changes, then `confirm_edit` with the returned action_id.\n" +
        "5. For SQLite: use `sqlite_schema`/`sqlite_select` for reading, `sqlite_preview_change`/`sqlite_confirm_change` for structured writes.\n" +
        "6. For SHELL: use `preview_shell` then `confirm_shell` for write/publish commands; use `shell` only for low-risk verification.\n" +
        "7. For web: use `web_search` (SearXNG) and `web_fetch` (public HTTP, blocks local/private networks).\n" +
        "Use preview-then-confirm for all writes (file edits, SQLite changes, shell commands).",
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
      outputSchema: z.object({ result: z.string() }),
    },
    async () => textResult(JSON.stringify({
      ok: true,
      name: "chatgpt-codex-tools-mcp",
      version: "0.4.4",
      accessMode: config.accessMode,
      allowedRoots: config.allowedRoots,
      maxReadBytes: config.maxReadBytes,
      maxOutputBytes: config.maxOutputBytes,
      webToolsEnabled: config.webToolsEnabled,
      searchProvider: config.searchProvider,
      searxngConfigured: Boolean(config.searxngUrl),
      webMaxBytes: config.webMaxBytes,
      webTimeoutMs: config.webTimeoutMs,
      sqliteToolsEnabled: config.sqliteToolsEnabled,
      sqliteAllowedDbs: config.sqliteAllowedDbs,
      sqliteMaxRows: config.sqliteMaxRows,
    }, null, 2)),
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
  // list_dir — list files in workspace
  // ============================================================

  server.registerTool(
    "list_dir",
    {
      title: "List directory",
      description: "List files and subdirectories in an open workspace. Use for browsing project structure.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().default("."),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string() }),
    },
    async ({ workspaceId, path }) => {
      const { workspace, absolutePath } = workspaces.resolve(workspaceId, path);
      assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
      const entries = await readdir(absolutePath, { withFileTypes: true });
      const lines = entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((entry) => `${entry.isDirectory() ? "dir " : "file"} ${entry.name}`)
        .join("\n");
      return textResult(lines || "(empty)");
    },
  );

  // ============================================================
  // read_file — read a text file
  // ============================================================

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read a UTF-8 text file inside a workspace. Best for viewing source code, configs, and logs. Output is byte-capped.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string(),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string(), path: z.string(), truncated: z.boolean() }),
    },
    async ({ workspaceId, path }) => {
      const { workspace, absolutePath } = workspaces.resolve(workspaceId, path);
      assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
      const content = await readFileCapped(absolutePath, config.maxReadBytes);
      return textResult(content.text, {
        path: relativeDisplayPath(workspace.root, absolutePath),
        truncated: content.truncated,
      });
    },
  );

  // ============================================================
  // search_files — full-text search in workspace
  // ============================================================

  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description: "Search text content inside a workspace. Uses ripgrep when available, with a Node fallback. Skips node_modules, dist, .git, and denied paths. Supports optional case-sensitivity, context lines, max matches, include/exclude path globs.",
      inputSchema: {
        workspaceId: z.string(),
        pattern: z.string().describe("Text pattern to search for (case-insensitive by default)."),
        path: z.string().default(".").describe("Starting directory relative to workspace root."),
        caseSensitive: z.boolean().default(false).describe("Enable case-sensitive matching."),
        contextLines: z.number().int().min(0).max(20).default(0).describe("Number of context lines to include around each match."),
        maxMatches: z.number().int().min(1).max(5000).default(1000).describe("Maximum number of matching lines to return."),
        include: z.string().optional().describe("Only search files matching this glob pattern (e.g. '*.ts', 'src/**/*.js')."),
        exclude: z.string().optional().describe("Skip files matching this glob pattern (e.g. '*.test.ts', '**/*.min.js')."),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string() }),
    },
    async ({ workspaceId, pattern, path, caseSensitive, contextLines, maxMatches, include, exclude }) => {
      const { workspace, absolutePath } = workspaces.resolve(workspaceId, path);
      assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
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
      return textResult(output || "(no matches)");
    },
  );

  // ============================================================
  // find_files — find files by name pattern
  // ============================================================

  server.registerTool(
    "find_files",
    {
      title: "Find files",
      description: "Find files by filename pattern (glob) in a workspace. Skips node_modules, dist, .git. Use when you know part of the filename but not the path.",
      inputSchema: {
        workspaceId: z.string(),
        pattern: z.string().describe("Glob pattern to match filenames (e.g. '*.ts', '**/*.test.js', '*config*')."),
        path: z.string().default(".").describe("Starting directory relative to workspace root."),
        maxResults: z.number().int().min(1).max(500).default(100).describe("Maximum files to return."),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string() }),
    },
    async ({ workspaceId, pattern, path, maxResults }) => {
      const { workspace, absolutePath } = workspaces.resolve(workspaceId, path);
      assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
      const matcher = createGlobMatcher(pattern, { matchBasename: true });
      const results = await findFilesByGlob(workspace.root, absolutePath, matcher, maxResults);
      return textResult(results.length > 0 ? results.join("\n") : "(no matching files)");
    },
  );

  // ============================================================
  // project_tree — show project directory tree
  // ============================================================

  server.registerTool(
    "project_tree",
    {
      title: "Project tree",
      description: "Show a visual directory tree of the workspace. Skips node_modules, dist, .git. Depth-limited. Use for understanding project structure at a glance.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string().default(".").describe("Starting directory relative to workspace root."),
        depth: z.number().int().min(1).max(5).default(3).describe("Maximum directory depth to traverse."),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string() }),
    },
    async ({ workspaceId, path, depth }) => {
      const { workspace, absolutePath } = workspaces.resolve(workspaceId, path);
      assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
      const tree = await buildProjectTree(workspace.root, absolutePath, 0, depth);
      return textResult(tree || "(empty)");
    },
  );

  // ============================================================
  // git_status — git status
  // ============================================================

  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description: "Run git status --short in a workspace. Use to check what's changed, staged, or untracked.",
      inputSchema: { workspaceId: z.string() },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string(), stdout: z.string(), stderr: z.string(), exitCode: z.number().nullable(), timedOut: z.boolean() }),
    },
    async ({ workspaceId }) => gitTool(workspaceId, "git status --short"),
  );

  // ============================================================
  // git_diff — git diff
  // ============================================================

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description: "Review git diffs. Defaults to unstaged stat + full diff. Can inspect staged changes, a single path, stat-only output, and smaller output caps.",
      inputSchema: {
        workspaceId: z.string(),
        staged: z.boolean().default(false).describe("Show staged/cached changes instead of unstaged changes."),
        path: z.string().optional().describe("Optional file or directory path relative to the workspace root."),
        statOnly: z.boolean().default(false).describe("Return only git diff --stat, not the full patch."),
        maxBytes: z.number().int().positive().max(config.maxOutputBytes).default(config.maxOutputBytes).describe("Maximum stdout/stderr bytes returned."),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({
        result: z.string(),
        stdout: z.string(),
        stderr: z.string(),
        exitCode: z.number().nullable(),
        timedOut: z.boolean(),
        staged: z.boolean(),
        path: z.string().optional(),
        statOnly: z.boolean(),
      }),
    },
    async ({ workspaceId, staged, path, statOnly, maxBytes }) => gitDiffTool(workspaceId, { staged, path, statOnly, maxBytes }),
  );

  // ============================================================
  // preview_edit — new generic file editing (replace_text etc.)
  // ============================================================

  server.registerTool(
    "preview_edit",
    {
      title: "Preview edit",
      description: "Preview one or more bounded file edits. Does not write. Use confirm_edit with the returned action_id after review.",
      inputSchema: {
        workspaceId: z.string(),
        changes: z.array(
          z.object({
            path: z.string().describe("File path relative to workspace root."),
            type: z.enum(["replace_text", "replace_range", "insert_before", "insert_after", "append", "create", "overwrite", "rename", "delete"]),
            // replace_text
            oldText: z.string().optional().describe("Exact text to find and replace. Empty string creates a new file (backward compat)."),
            newText: z.string().optional().describe("Replacement text for replace_text/overwrite/replace_range."),
            // replace_range
            startLine: z.number().int().min(1).optional().describe("1-indexed start line for replace_range."),
            endLine: z.number().int().min(1).optional().describe("1-indexed end line (inclusive) for replace_range."),
            // insert_before / insert_after / append / create
            text: z.string().optional().describe("Text to insert (create, append, insert_before, insert_after)."),
            // insert_before
            anchor: z.string().optional().describe("Anchor text to insert before (first occurrence)."),
            // insert_after
            anchorAfter: z.string().optional().describe("Anchor text to insert after (first occurrence)."),
            // rename
            newPath: z.string().optional().describe("Target path for rename."),
          }),
        ).min(1).describe("One or more file changes in this batch."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      outputSchema: z.object({
        result: z.string(),
        action_id: z.string(),
        requires_approval: z.boolean(),
        changes: z.array(z.object({ path: z.string(), type: z.string(), diff: z.string() })),
      }),
    },
    async ({ workspaceId, changes }) => {
      const typedChanges = changes as Change[];
      assertPreviewEditPayload(typedChanges);
      assertEditChangePaths(workspaceId, typedChanges);
      const { workspace, absolutePath } = workspaces.resolve(workspaceId, ".");
      const diffs = await previewChanges(absolutePath, typedChanges);
      const pending = edits.create({ workspaceId, changes: typedChanges, diffs });
      const combinedDiff = diffs.map((d) => `--- ${d.path} (${d.type}) ---\n${d.diff}`).join("\n\n");
      return textResult(`Pending edit: ${pending.id}\n\n${combinedDiff}`, {
        action_id: pending.id,
        requires_approval: true,
        changes: diffs,
      });
    },
  );

  // ============================================================
  // confirm_edit — confirm multi-file edit
  // ============================================================

  server.registerTool(
    "confirm_edit",
    {
      title: "Confirm edit",
      description: "Apply a pending file edit created by preview_edit after rechecking paths. Not transactional.",
      inputSchema: {
        actionId: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      outputSchema: z.object({ result: z.string(), applied: z.boolean(), action_id: z.string(), changeCount: z.number() }),
    },
    async ({ actionId }) => {
      const pending = edits.take(actionId);
      assertEditChangePaths(pending.workspaceId, pending.changes);
      const { workspace, absolutePath } = workspaces.resolve(pending.workspaceId, ".");
      await applyChanges(absolutePath, pending.changes);
      return textResult(`Applied ${pending.changes.length} change(s) from ${actionId}`, {
        applied: true,
        action_id: actionId,
        changeCount: pending.changes.length,
      });
    },
  );

  // ============================================================
  // preview_shell / confirm_shell / shell
  // ============================================================

  server.registerTool(
    "preview_shell",
    {
      title: "Preview shell command",
      description: "Preview a bounded shell command for explicit approval. Does not execute until confirm_shell is called.",
      inputSchema: {
        workspaceId: z.string(),
        command: z.string(),
        workingDirectory: z.string().default("."),
        timeoutSeconds: z.number().int().positive().max(300).default(30),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      outputSchema: z.object({ result: z.string(), action_id: z.string(), requires_approval: z.boolean(), workspaceId: z.string(), workingDirectory: z.string(), command: z.string(), timeoutSeconds: z.number() }),
    },
    async ({ workspaceId, command, workingDirectory, timeoutSeconds }) => {
      assertPreviewShellPayload(command);
      const { absolutePath } = workspaces.resolve(workspaceId, workingDirectory);
      assertCommandAllowed(command, config.accessMode, "confirmed");
      const dirStat = await stat(absolutePath);
      if (!dirStat.isDirectory()) throw new Error(`workingDirectory is not a directory: ${workingDirectory}`);
      const pending = shellActions.create({ workspaceId, command, workingDirectory, timeoutSeconds });
      return textResult(
        [
          `Pending shell action: ${pending.id}`,
          `workspaceId: ${workspaceId}`,
          `workingDirectory: ${workingDirectory}`,
          `timeoutSeconds: ${timeoutSeconds}`,
          "command:",
          command,
          "",
          "This command has not been executed. Call confirm_shell with this actionId to run it.",
        ].join("\n"),
        {
          action_id: pending.id,
          requires_approval: true,
          workspaceId,
          workingDirectory,
          command,
          timeoutSeconds,
        },
      );
    },
  );

  server.registerTool(
    "confirm_shell",
    {
      title: "Confirm shell command",
      description: "Execute a pending shell command created by preview_shell.",
      inputSchema: {
        actionId: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      outputSchema: z.object({ result: z.string(), stdout: z.string(), stderr: z.string(), exitCode: z.number().nullable(), timedOut: z.boolean() }),
    },
    async ({ actionId }) => {
      const pending = shellActions.take(actionId);
      const { absolutePath } = workspaces.resolve(pending.workspaceId, pending.workingDirectory);
      assertCommandAllowed(pending.command, config.accessMode, "confirmed");
      const dirStat = await stat(absolutePath);
      if (!dirStat.isDirectory()) throw new Error(`workingDirectory is not a directory: ${pending.workingDirectory}`);
      const result = await runCommand({
        command: pending.command,
        cwd: absolutePath,
        timeoutMs: pending.timeoutSeconds * 1000,
        maxOutputBytes: config.maxOutputBytes,
      });
      return textResult(formatProcessResult(result), result);
    },
  );

  server.registerTool(
    "shell",
    {
      title: "Shell",
      description: "Run a low-risk local command in a workspace. Use preview_shell/confirm_shell for write or publish commands.",
      inputSchema: {
        workspaceId: z.string(),
        command: z.string(),
        workingDirectory: z.string().default("."),
        timeoutSeconds: z.number().int().positive().max(300).default(30),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
      outputSchema: z.object({ result: z.string(), stdout: z.string(), stderr: z.string(), exitCode: z.number().nullable(), timedOut: z.boolean() }),
    },
    async ({ workspaceId, command, workingDirectory, timeoutSeconds }) => {
      const { workspace, absolutePath } = workspaces.resolve(workspaceId, workingDirectory);
      assertCommandAllowed(command, config.accessMode);
      const dirStat = await stat(absolutePath);
      if (!dirStat.isDirectory()) throw new Error(`workingDirectory is not a directory: ${workingDirectory}`);
      const result = await runCommand({
        command,
        cwd: absolutePath,
        timeoutMs: timeoutSeconds * 1000,
        maxOutputBytes: config.maxOutputBytes,
      });
      return textResult(formatProcessResult(result), result);
    },
  );

  // ============================================================
  // SQLite: status, schema, select, preview_change, confirm_change
  // ============================================================

  server.registerTool(
    "sqlite_status",
    {
      title: "SQLite status",
      description: "Show SQLite tool configuration. SQLite tools are disabled unless CTM_SQLITE_TOOLS=1 and CTM_SQLITE_ALLOWED_DBS is set.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string() }),
    },
    async () => textResult(JSON.stringify(sqliteStatus(config), null, 2)),
  );

  if (config.sqliteToolsEnabled) {
    server.registerTool(
      "sqlite_schema",
      {
        title: "SQLite schema",
        description: "Inspect tables, views, indexes, and triggers for an allowed database. Does not read row data. Use to discover table structure before SELECT or CHANGE operations.",
        inputSchema: {
          dbPath: z.string().optional().describe("Absolute path to an allowed SQLite database. Omit only when one DB is allowed."),
        },
        annotations: { readOnlyHint: true },
        outputSchema: z.object({ result: z.string(), rows: z.array(z.record(z.string(), z.unknown())) }),
      },
      async ({ dbPath }) => {
        const rows = sqliteSchema(config, dbPath);
        return textResult(JSON.stringify(rows, null, 2), { rows });
      },
    );

    server.registerTool(
      "sqlite_select",
      {
        title: "SQLite select",
        description: "Run one read-only SELECT/WITH or safe PRAGMA statement. Write SQL is blocked. Use for ad-hoc queries, or as precursor to a structured change.",
        inputSchema: {
          dbPath: z.string().optional().describe("Absolute path to an allowed SQLite database. Omit only when one DB is allowed."),
          sql: z.string().describe("Single read-only SQL statement. SELECT/WITH and safe PRAGMA only."),
          params: z.array(z.union([z.string(), z.number(), z.null()])).default([]).describe("Positional SQL parameters (?, ?, etc)."),
          limit: z.number().int().positive().max(config.sqliteMaxRows).default(config.sqliteMaxRows).describe("Maximum rows returned."),
        },
        annotations: { readOnlyHint: true },
        outputSchema: z.object({ result: z.string(), rows: z.array(z.record(z.string(), z.unknown())) }),
      },
      async ({ dbPath, sql, params, limit }) => {
        const rows = sqliteSelect(config, { dbPath, sql, params, limit });
        return textResult(JSON.stringify(rows, null, 2), { rows });
      },
    );

    server.registerTool(
      "sqlite_preview_change",
      {
        title: "SQLite preview change",
        description: "Preview a bounded structured SQLite insert/update/delete on an allowed DB. Does not write. Use sqlite_confirm_change after review.",
        inputSchema: {
          dbPath: z.string().optional().describe("Absolute path to an allowed SQLite database."),
          change: z.union([
            // insert
            z.object({
              type: z.literal("insert"),
              table: z.string().describe("Table name."),
              columns: z.array(z.string()).min(1).describe("Column names."),
              values: z.array(z.union([z.string(), z.number(), z.null()])).min(1).describe("Values matching columns order."),
            }),
            // update
            z.object({
              type: z.literal("update"),
              table: z.string().describe("Table name."),
              set: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).describe("Column=value pairs. Use dot-path keys for jsonSet on text columns (e.g. job_json.enabled)."),
              where: z.array(z.object({
                column: z.string(),
                operator: z.enum(["=", "!=", ">", "<", ">=", "<=", "LIKE", "IS", "IS NOT"]),
                value: z.union([z.string(), z.number(), z.null()]),
              })).optional().describe("AND-joined WHERE conditions."),
              limit: z.number().int().min(1).max(100).optional().describe("Row limit (default 1). Avoid unbounded updates."),
              expected: z.record(z.string(), z.unknown()).optional().describe("Re-verify these field values on confirm. Prevents stale-preview writes."),
            }),
            // delete
            z.object({
              type: z.literal("delete"),
              table: z.string().describe("Table name."),
              where: z.array(z.object({
                column: z.string(),
                operator: z.enum(["=", "!=", ">", "<", ">=", "<=", "LIKE", "IS", "IS NOT"]),
                value: z.union([z.string(), z.number(), z.null()]),
              })).optional().describe("AND-joined WHERE conditions."),
              limit: z.number().int().min(1).max(100).optional().describe("Row limit (default 1). You must specify a limit or WHERE for deletes."),
              expected: z.record(z.string(), z.unknown()).optional().describe("Re-verify these field values on confirm."),
            }),
          ]),
        },
        annotations: { readOnlyHint: false, destructiveHint: false },
        outputSchema: z.object({
          result: z.string(),
          action_id: z.string(),
          requires_approval: z.boolean(),
          beforeRows: z.array(z.record(z.string(), z.unknown())),
          diff: z.string(),
        }),
      },
      async ({ dbPath, change }) => {
        assertSqliteChangePayload(change);
        const { action, beforeRows, diff } = sqlitePreviewChange(config, { dbPath, change: change as any });
        return textResult(`Pending sqlite change: ${action.id}\n\n${diff}`, {
          action_id: action.id,
          requires_approval: true,
          beforeRows,
          diff,
        });
      },
    );

    server.registerTool(
      "sqlite_confirm_change",
      {
        title: "SQLite confirm change",
        description: "Apply a pending SQLite change created by sqlite_preview_change. Re-verifies 'expected' fields before writing. Prevents applying stale previews.",
        inputSchema: {
          actionId: z.string(),
        },
        annotations: { readOnlyHint: false, destructiveHint: true },
        outputSchema: z.object({ result: z.string(), applied: z.boolean(), action_id: z.string(), change_type: z.string(), table: z.string() }),
      },
      async ({ actionId }) => {
        const result = sqliteConfirmChange(config, actionId);
        return textResult(
          `Applied sqlite change: ${actionId} (${result.change_type} on ${result.table})`,
          result,
        );
      },
    );
  }

  // ============================================================
  // Web: always-registered status, gated search/fetch
  // ============================================================

  server.registerTool(
    "web_status",
    {
      title: "Web status",
      description: "Show web tools configuration: whether web_search and web_fetch are available and how they are configured.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string() }),
    },
    async () => textResult(JSON.stringify(webStatus(config), null, 2)),
  );

  if (config.webToolsEnabled) {
    server.registerTool(
      "web_search",
      {
        title: "Web search",
        description: "Search the web via SearXNG. Requires CTM_WEB_TOOLS=1 and CTM_SEARCH_PROVIDER=searxng. Use for looking up docs, news, or public information.",
        inputSchema: {
          query: z.string().describe("Search query."),
          limit: z.number().int().min(1).max(10).default(5).describe("Number of results (1-10)."),
        },
        annotations: { readOnlyHint: true },
        outputSchema: z.object({ result: z.string(), results: z.array(z.object({ title: z.string(), url: z.string(), snippet: z.string(), engine: z.string().optional() })) }),
      },
      async ({ query, limit }) => {
        const results = await webSearch(config, query, limit);
        return textResult(
          results.length === 0 ? "(no results)" : results.map((r) => `- ${r.title}\n  ${r.url}\n  ${r.snippet}`).join("\n\n"),
          { results },
        );
      },
    );

    server.registerTool(
      "web_fetch",
      {
        title: "Web fetch",
        description: "Fetch a public HTTP(S) page. Blocks localhost, private networks, and credentials in URLs. Use to read documentation, API responses, or web pages. No cookies or auth headers are sent.",
        inputSchema: {
          url: z.string().url().describe("HTTP or HTTPS URL."),
        },
        annotations: { readOnlyHint: true },
        outputSchema: z.object({ result: z.string(), finalUrl: z.string(), status: z.number(), contentType: z.string(), title: z.string(), text: z.string(), truncated: z.boolean() }),
      },
      async ({ url }) => {
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
  }

  return server;
}

// --- Git helper ---

async function gitTool(workspaceId: string, command: string) {
  const workspace = workspaces.get(workspaceId);
  const result = await runCommand({ command, cwd: workspace.root, timeoutMs: 30_000, maxOutputBytes: config.maxOutputBytes });
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

// --- find_files helpers ---

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

// --- project_tree helpers ---

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

const transports = new Map<string, StreamableHTTPServerTransport>();

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
          if (transport) transports.set(newSessionId, transport);
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
