import http from "node:http";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import express from "express";
import { getOAuthProtectedResourceMetadataUrl, mcpAuthRouter } from "@modelcontextprotocol/sdk/server/auth/router.js";
import { requireBearerAuth } from "@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js";
import { TailscaleOwnerOAuthProvider } from "./tailscale-oauth.js";

const projectRoot = process.cwd();
const publicBaseRaw = String(process.env.CTM_TAILSCALE_PUBLIC_BASE_URL || "").trim();
if (!publicBaseRaw) throw new Error("CTM_TAILSCALE_PUBLIC_BASE_URL is required");
const publicBaseUrl = new URL(publicBaseRaw.endsWith("/") ? publicBaseRaw : `${publicBaseRaw}/`);
if (publicBaseUrl.protocol !== "https:") throw new Error("Tailscale public base URL must use HTTPS");

const resourceUrl = new URL("mcp", publicBaseUrl);
const listenHost = process.env.CTM_TAILSCALE_GATEWAY_HOST || "127.0.0.1";
const listenPort = Number(process.env.CTM_TAILSCALE_GATEWAY_PORT || 3334);
const targetHost = process.env.CTM_TAILSCALE_TARGET_HOST || "127.0.0.1";
const targetPort = Number(process.env.CTM_TAILSCALE_TARGET_PORT || 3333);
const ownerTokenPath = resolve(projectRoot, process.env.CTM_TAILSCALE_OWNER_TOKEN_FILE || "tunnel/tailscale/owner-password.txt");
const statePath = resolve(projectRoot, process.env.CTM_TAILSCALE_OAUTH_STATE_FILE || "tunnel/tailscale/oauth-state.json");
const ownerToken = readFileSync(ownerTokenPath, "utf8").trim();
if (ownerToken.length < 24) throw new Error("Tailscale Owner Password file is missing or too short; run the initializer first");

const provider = new TailscaleOwnerOAuthProvider(ownerToken, resourceUrl, statePath);
const app = express();
app.set("trust proxy", "loopback");
app.disable("x-powered-by");

app.use(mcpAuthRouter({
  provider,
  issuerUrl: publicBaseUrl,
  baseUrl: publicBaseUrl,
  resourceServerUrl: resourceUrl,
  scopesSupported: ["mcp", "offline_access"],
  resourceName: "ChatGPT Codex Tools",
}));

app.get("/healthz", (_req, res) => res.json({ ok: true, name: "tailscale-oauth-gateway" }));

const auth = requireBearerAuth({
  verifier: provider,
  requiredScopes: ["mcp"],
  resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
});

app.all("/mcp", auth, (req, res) => {
  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  for (const name of ["authorization", "connection", "proxy-connection", "keep-alive", "upgrade", "te", "trailer", "transfer-encoding"]) {
    delete headers[name];
  }
  headers.host = `${targetHost}:${targetPort}`;

  let upstreamRes: http.IncomingMessage | undefined;
  const upstream = http.request({
    hostname: targetHost,
    port: targetPort,
    method: req.method,
    path: req.originalUrl,
    headers,
  }, (response) => {
    upstreamRes = response;
    res.statusCode = response.statusCode ?? 502;
    if (response.statusMessage) res.statusMessage = response.statusMessage;
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) continue;
      if (["connection", "proxy-connection", "keep-alive", "upgrade", "transfer-encoding"].includes(name.toLowerCase())) continue;
      res.setHeader(name, value);
    }
    response.pipe(res);
  });

  const destroyUpstream = () => {
    upstreamRes?.destroy();
    upstream.destroy();
  };

  upstream.on("error", () => {
    if (!res.headersSent) res.status(502).json({ error: "MCP upstream unavailable" });
    else res.end();
  });
  req.on("aborted", destroyUpstream);
  res.on("close", () => {
    if (!res.writableFinished) destroyUpstream();
  });
  req.pipe(upstream);
});

const server = app.listen(listenPort, listenHost, () => {
  console.log(`Tailscale OAuth gateway listening on http://${listenHost}:${listenPort}`);
  console.log(`Public MCP URL: ${resourceUrl.href}`);
  console.log(`Forwarding authenticated MCP traffic to http://${targetHost}:${targetPort}/mcp`);
});
server.requestTimeout = 0;
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
