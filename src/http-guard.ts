import type { RequestHandler } from "express";

export interface HttpGuardPolicy {
  allowedHosts: string[];
  allowedOrigins: string[];
}

function normalizeHost(value: string): string {
  if (!value || !/^(?:[a-z0-9.-]+|\[[0-9a-f:.]+\])(?::[0-9]{1,5})?$/i.test(value)) {
    throw new Error("HTTP allowed hosts must be explicit host[:port] values.");
  }
  const url = new URL(`http://${value}`);
  if (!url.hostname || url.username || url.password || url.pathname !== "/") throw new Error("Invalid HTTP host.");
  return value.toLowerCase();
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password ||
      url.pathname !== "/" || url.search || url.hash) {
    throw new Error("HTTP allowed origins must be explicit HTTP(S) origins.");
  }
  return url.origin;
}

export function createHttpGuard(policy?: HttpGuardPolicy): RequestHandler {
  if (!policy) return (_req, _res, next) => next();
  const hosts = new Set(policy.allowedHosts.map(normalizeHost));
  const origins = new Set(policy.allowedOrigins.map(normalizeOrigin));
  if (!hosts.size) throw new Error("HTTP guard requires at least one allowed host.");

  return (req, res, next) => {
    const rawNames = req.rawHeaders.filter((_value, index) => index % 2 === 0).map(name => name.toLowerCase());
    const host = req.headers.host;
    const origin = req.headers.origin;
    if (rawNames.filter(name => name === "host").length !== 1 ||
        typeof host !== "string" || !hosts.has(host.toLowerCase())) {
      res.status(403).json({ error: "HTTP Host is not allowed." });
      return;
    }
    // The absence of Origin is normal for native MCP/HTTP clients. If a
    // browser sends one, it must match the explicit allowlist.
    if (rawNames.filter(name => name === "origin").length > 1 ||
        (origin !== undefined && (typeof origin !== "string" || !origins.has(origin)))) {
      res.status(403).json({ error: "HTTP Origin is not allowed." });
      return;
    }
    next();
  };
}
