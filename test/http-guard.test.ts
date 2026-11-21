import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import express from "express";
import { loadConfig } from "../src/config.js";
import { createHttpGuard } from "../src/http-guard.js";

test("HTTP guard is opt-in, defaults to loopback authorities, and accepts explicit configuration", () => {
  const root = mkdtempSync(join(tmpdir(), "ctm-http-guard-"));
  try {
    const path = join(root, "config.json");
    writeFileSync(path, JSON.stringify({ mcp: { port: 47999, httpGuardEnabled: true,
      httpAllowedHosts: ["localhost:47999"], httpAllowedOrigins: ["https://example.com"] } }));
    assert.deepEqual(loadConfig({ CTM_CONFIG_PATH: path }).httpGuard, {
      allowedHosts: ["localhost:47999"], allowedOrigins: ["https://example.com"],
    });
    assert.equal(loadConfig({ CTM_CONFIG_PATH: path, CTM_HTTP_GUARD: "0" }).httpGuard, undefined);
    const fallback = loadConfig({ CTM_CONFIG_PATH: join(root, "absent.json"), CTM_HTTP_GUARD: "1", PORT: "47998" });
    assert.deepEqual(fallback.httpGuard, {
      allowedHosts: ["127.0.0.1:47998", "localhost:47998", "[::1]:47998"], allowedOrigins: [],
    });
    assert.throws(() => createHttpGuard({ allowedHosts: ["*"], allowedOrigins: [] }), /explicit host/);
    assert.throws(() => createHttpGuard({ allowedHosts: ["localhost"], allowedOrigins: ["https://example.com/path"] }), /explicit HTTP/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("HTTP guard rejects rebinding and unapproved browser origins before body parsing", async () => {
  const app = express();
  app.use("/mcp", createHttpGuard({ allowedHosts: ["127.0.0.1:3333", "localhost:3333"],
    allowedOrigins: ["https://example.com"] }));
  app.use(express.json());
  app.post("/mcp", (_req, res) => res.json({ ok: true }));
  app.get("/healthz", (_req, res) => res.json({ ok: true }));
  app.use((_error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { res.status(400).end(); });
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve, reject) => { server.once("listening", resolve); server.once("error", reject); });
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    async function call(host: string, origin?: string, body = "{}", forwardedHost?: string, path = "/mcp") {
      return new Promise<number>((resolve, reject) => {
        const req = request({ hostname: "127.0.0.1", port: address.port, path, method: path === "/healthz" ? "GET" : "POST",
          headers: { host, "content-type": "application/json", "content-length": Buffer.byteLength(body),
            ...(origin === undefined ? {} : { origin }),
            ...(forwardedHost ? { "x-forwarded-host": forwardedHost } : {}) },
        }, res => { res.resume(); res.on("end", () => resolve(res.statusCode ?? 0)); });
        req.on("error", reject);
        req.end(body);
      });
    }
    assert.equal(await call("127.0.0.1:3333"), 200);
    assert.equal(await call("LOCALHOST:3333", "https://example.com"), 200);
    assert.equal(await call("evil.example:3333", undefined, "{"), 403);
    assert.equal(await call("127.0.0.1:3333", "https://evil.example", "{"), 403);
    assert.equal(await call("127.0.0.1:3333", "null"), 403);
    assert.equal(await call("evil.example:3333", undefined, "{}", "127.0.0.1:3333"), 403);
    assert.equal(await call("127.0.0.1:3333", undefined, "{"), 400);
    assert.equal(await call("evil.example", undefined, "{}", undefined, "/healthz"), 200);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
