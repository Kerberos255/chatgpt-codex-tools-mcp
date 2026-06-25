import { randomUUID } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import * as z from "zod/v4";
import { loadConfig } from "./config.js";
import { assertNotDenied, relativeDisplayPath } from "./paths.js";
import { applyReplacement, PatchStore, previewReplacement } from "./patches.js";
import { assertCommandAllowed, runCommand } from "./process-runner.js";
import { webFetch, webSearch, webStatus } from "./web.js";
import { WorkspaceRegistry } from "./workspaces.js";

const config = loadConfig();
const workspaces = new WorkspaceRegistry(config);
const patches = new PatchStore();
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

function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "chatgpt-codex-tools-mcp",
      title: "ChatGPT Codex Tools",
      version: "0.2.0",
      description: "Codex-style local workspace tools for ChatGPT. ChatGPT reasons; this server only executes constrained local tools.",
    },
    {
      instructions:
        "Use these tools like a Codex-style local workspace. Open a workspace once, reuse workspaceId, prefer read/search/git tools for inspection, use preview_patch before confirm_patch for edits, use preview_shell/confirm_shell for write or publish commands, and run direct shell only for verification or low-risk local commands.",
    },
  );

  server.registerTool(
    "local_status",
    {
      title: "Local status",
      description: "Return local server status and safety configuration.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string() }),
    },
    async () => textResult(JSON.stringify({
      ok: true,
      name: "chatgpt-codex-tools-mcp",
      accessMode: config.accessMode,
      allowedRoots: config.allowedRoots,
      maxReadBytes: config.maxReadBytes,
      maxOutputBytes: config.maxOutputBytes,
      webToolsEnabled: config.webToolsEnabled,
      searchProvider: config.searchProvider,
      searxngConfigured: Boolean(config.searxngUrl),
      webMaxBytes: config.webMaxBytes,
      webTimeoutMs: config.webTimeoutMs,
    }, null, 2)),
  );

  server.registerTool(
    "open_workspace",
    {
      title: "Open workspace",
      description: "Open a local project directory under CTM_ALLOWED_ROOTS and return a workspaceId.",
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

  server.registerTool(
    "list_dir",
    {
      title: "List directory",
      description: "List a directory inside an open workspace.",
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

  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description: "Read a UTF-8 text file inside an open workspace. Output is byte capped.",
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

  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description: "Search text inside a workspace without requiring rg. Skips node_modules, dist, .git, and denied paths.",
      inputSchema: {
        workspaceId: z.string(),
        pattern: z.string(),
        path: z.string().default("."),
      },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string() }),
    },
    async ({ workspaceId, pattern, path }) => {
      const { workspace, absolutePath } = workspaces.resolve(workspaceId, path);
      assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
      const output = await searchTextFiles(workspace.root, absolutePath, pattern);
      return textResult(output || "(no matches)");
    },
  );

  server.registerTool(
    "git_status",
    {
      title: "Git status",
      description: "Run git status --short inside a workspace.",
      inputSchema: { workspaceId: z.string() },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string(), stdout: z.string(), stderr: z.string(), exitCode: z.number().nullable(), timedOut: z.boolean() }),
    },
    async ({ workspaceId }) => gitTool(workspaceId, "git status --short"),
  );

  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description: "Run git diff --stat and git diff inside a workspace.",
      inputSchema: { workspaceId: z.string() },
      annotations: { readOnlyHint: true },
      outputSchema: z.object({ result: z.string(), stdout: z.string(), stderr: z.string(), exitCode: z.number().nullable(), timedOut: z.boolean() }),
    },
    async ({ workspaceId }) => gitTool(workspaceId, "git diff --stat && git diff"),
  );

  server.registerTool(
    "preview_patch",
    {
      title: "Preview patch",
      description: "Create a pending replacement patch. Does not write until confirm_patch is called.",
      inputSchema: {
        workspaceId: z.string(),
        path: z.string(),
        oldText: z.string().describe("Exact text to replace. Use empty string to create a new file."),
        newText: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
      outputSchema: z.object({ result: z.string(), action_id: z.string(), requires_approval: z.boolean(), path: z.string(), diff: z.string() }),
    },
    async ({ workspaceId, path, oldText, newText }) => {
      const { workspace, absolutePath } = workspaces.resolve(workspaceId, path);
      assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
      const diff = await previewReplacement(absolutePath, oldText, newText);
      const pending = patches.create({ workspaceId, path, oldText, newText });
      return textResult(`Pending action: ${pending.id}\n\n${diff}`, {
        action_id: pending.id,
        requires_approval: true,
        path,
        diff,
      });
    },
  );

  server.registerTool(
    "confirm_patch",
    {
      title: "Confirm patch",
      description: "Apply a pending patch created by preview_patch.",
      inputSchema: {
        actionId: z.string(),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
      outputSchema: z.object({ result: z.string(), applied: z.boolean(), action_id: z.string(), path: z.string() }),
    },
    async ({ actionId }) => {
      const pending = patches.take(actionId);
      const { workspace, absolutePath } = workspaces.resolve(pending.workspaceId, pending.path);
      assertNotDenied(absolutePath, workspace.root, config.denyGlobs);
      await applyReplacement(absolutePath, pending.oldText, pending.newText);
      return textResult(`Applied ${actionId} to ${pending.path}`, {
        applied: true,
        action_id: actionId,
        path: pending.path,
      });
    },
  );

  server.registerTool(
    "preview_shell",
    {
      title: "Preview shell command",
      description: "Create a pending shell action for review-mode write or publish commands. Does not execute until confirm_shell is called.",
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
      description: "Execute a pending shell action created by preview_shell.",
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
      description: "Run a shell command inside a workspace. Review mode blocks risky commands and allows only low-risk inspection/test commands.",
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

  // ---- web tools ----

  // web_status is always registered so ChatGPT can discover the web tools config
  server.registerTool(
    "web_status",
    {
      title: "Web status",
      description: "Show web tools configuration status.",
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
        description: "Search the web via the configured search provider (SearXNG). Only available when CTM_WEB_TOOLS=1 and CTM_SEARCH_PROVIDER=searxng.",
        inputSchema: {
          query: z.string().describe("Search query."),
          limit: z.number().int().min(1).max(10).default(5).describe("Number of results."),
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
        description: "Fetch a public HTTP(S) page. Blocks localhost, private networks, and credentials in URLs. No cookies or auth headers are sent.",
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

async function gitTool(workspaceId: string, command: string) {
  const workspace = workspaces.get(workspaceId);
  const result = await runCommand({ command, cwd: workspace.root, timeoutMs: 30_000, maxOutputBytes: config.maxOutputBytes });
  return textResult(formatProcessResult(result), result);
}

function textResult(text: string, structuredContent: object = {}) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: { result: text, ...structuredContent },
  };
}

async function readFileCapped(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const buffer = await readFile(path);
  if (buffer.byteLength <= maxBytes) return { text: buffer.toString("utf8"), truncated: false };
  return { text: buffer.subarray(0, maxBytes).toString("utf8") + "\n[file truncated]\n", truncated: true };
}

async function searchTextFiles(workspaceRoot: string, startPath: string, pattern: string): Promise<string> {
  const needle = pattern.toLowerCase();
  const lines: string[] = [];

  async function walk(path: string): Promise<void> {
    if (Buffer.byteLength(lines.join("\n"), "utf8") > config.maxOutputBytes) return;

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

    let text: string;
    try {
      text = (await readFileCapped(path, Math.min(config.maxReadBytes, 128_000))).text;
    } catch {
      return;
    }

    const fileLines = text.split(/\r?\n/);
    fileLines.forEach((line, index) => {
      if (line.toLowerCase().includes(needle)) {
        const displayLine = line.length > 300 ? `${line.slice(0, 300)}...` : line;
        lines.push(`${relativeDisplayPath(workspaceRoot, path)}:${index + 1}: ${displayLine}`);
      }
    });
  }

  await walk(startPath);
  const output = lines.join("\n");
  if (Buffer.byteLength(output, "utf8") <= config.maxOutputBytes) return output;
  return output.slice(0, config.maxOutputBytes) + "\n[output truncated]\n";
}

function formatProcessResult(result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }): string {
  return [
    `exit_code: ${result.exitCode}`,
    `timed_out: ${result.timedOut}`,
    result.stdout ? `stdout:\n${result.stdout}` : undefined,
    result.stderr ? `stderr:\n${result.stderr}` : undefined,
  ].filter(Boolean).join("\n");
}

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
