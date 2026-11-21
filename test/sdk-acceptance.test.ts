import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("strict SDK client accepts structured results for files, git, edit and exec", { timeout: 30000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ctm-sdk-smoke-"));
  const checkout = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const socket = createServer();
  await new Promise<void>((res, rej) => { socket.once("error", rej); socket.listen(0, "127.0.0.1", res); });
  const address = socket.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>(res => socket.close(() => res()));
  const url = "http://127.0.0.1:" + port;
  const server = spawn(process.execPath, ["--import", "tsx", join(checkout, "src", "server.ts")], {
    cwd: checkout, windowsHide: true,
    env: { ...process.env, CTM_CONFIG_PATH: join(root, "missing.json"), HOST: "127.0.0.1",
      PORT: String(port), CTM_ALLOWED_ROOTS: root, CTM_ACCESS_MODE: "full",
      CTM_HTTP_GUARD: "1", CTM_HTTP_ALLOWED_HOSTS: "127.0.0.1:" + port,
      CTM_WEB_TOOLS: "0", CTM_SQLITE_TOOLS: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.resume();
  server.stderr.resume();
  let exited = false;
  server.once("exit", () => { exited = true; });
  const client = new Client({ name: "ctm-sdk-acceptance", version: "1.0.0" });
  try {
    let ready = false;
    for (let i = 0; i < 50 && !exited; i++) {
      try { if ((await fetch(url + "/healthz", { signal: AbortSignal.timeout(500) })).ok) { ready = true; break; } } catch {}
      await new Promise(res => setTimeout(res, 100));
    }
    assert.ok(ready, "isolated MCP server did not start");
    writeFileSync(join(root, "demo.txt"), "hello");
    assert.equal(spawnSync("git", ["init", "--quiet"], { cwd: root, windowsHide: true }).status, 0);
    await client.connect(new StreamableHTTPClientTransport(new URL(url + "/mcp")));
    assert.equal((await client.listTools()).tools.length, 9);
    async function call(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, "tool failed: " + name);
      return response.structuredContent ?? {};
    }
    const opened = await call("open_workspace", { path: root });
    const workspaceId = opened.workspaceId;
    assert.ok(workspaceId);
    assert.match(String((await call("files", { action: "read", workspaceId, path: "demo.txt" })).result), /hello/);
    assert.match(String((await call("git", { action: "status", workspaceId })).stdout), /demo.txt/);
    const run = await call("exec", { action: "run", command: "node", args: ["--version"], workspaceId });
    assert.equal(run.exitCode, 0);
    assert.equal(run.outputLimitReached, false);
    const preview = await call("edit", { action: "preview", workspaceId,
      changes: [{ type: "overwrite", path: "demo.txt", newText: "updated" }] });
    assert.ok(preview.action_id);
    assert.equal(readFileSync(join(root, "demo.txt"), "utf8"), "hello");
    await call("edit", { action: "confirm", actionId: preview.action_id });
    assert.equal(readFileSync(join(root, "demo.txt"), "utf8"), "updated");
  } finally {
    await client.close().catch(() => {});
    if (!exited) { const done = new Promise<void>(res => server.once("exit", () => res())); server.kill(); await done; }
    rmSync(root, { recursive: true, force: true });
  }
});
