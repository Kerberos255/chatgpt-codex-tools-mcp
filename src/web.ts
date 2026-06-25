import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { Config } from "./config.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
}

export interface FetchResult {
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  truncated: boolean;
}

export function webStatus(config: Config) {
  return {
    enabled: config.webToolsEnabled,
    searchProvider: config.searchProvider,
    searxngConfigured: Boolean(config.searxngUrl),
    webMaxBytes: config.webMaxBytes,
    webTimeoutMs: config.webTimeoutMs,
    fetchPolicy: {
      methods: ["GET"],
      protocols: ["http", "https"],
      credentials: "not sent",
      privateNetworkTargets: "blocked for web_fetch",
      redirects: "checked before each hop",
    },
  };
}

export async function webSearch(config: Config, query: string, limit: number): Promise<SearchResult[]> {
  ensureWebToolsEnabled(config);
  if (config.searchProvider !== "searxng") {
    throw new Error("web_search requires CTM_SEARCH_PROVIDER=searxng.");
  }
  if (!config.searxngUrl) {
    throw new Error("web_search requires CTM_SEARXNG_URL.");
  }

  const endpoint = makeSearxngSearchUrl(config.searxngUrl);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");

  const response = await fetchWithTimeout(endpoint.toString(), config.webTimeoutMs);
  if (!response.ok) {
    throw new Error(`SearXNG search failed: HTTP ${response.status}`);
  }

  const data = await response.json() as { results?: Array<Record<string, unknown>> };
  return (data.results || []).slice(0, Math.max(1, Math.min(limit, 10))).map((item) => ({
    title: String(item.title || ""),
    url: String(item.url || ""),
    snippet: String(item.content || item.snippet || ""),
    engine: Array.isArray(item.engines) ? item.engines.join(", ") : String(item.engine || ""),
  }));
}

export async function webFetch(config: Config, inputUrl: string): Promise<FetchResult> {
  ensureWebToolsEnabled(config);
  let current = await assertPublicFetchUrl(inputUrl);

  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    const response = await fetchWithTimeout(current.toString(), config.webTimeoutMs, { redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) throw new Error(`Redirect response missing Location header: HTTP ${response.status}`);
      current = await assertPublicFetchUrl(new URL(location, current).toString());
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    const body = await readBodyCapped(response, config.webMaxBytes);
    const text = decodeUtf8(body.bytes);
    return {
      finalUrl: current.toString(),
      status: response.status,
      contentType,
      title: extractTitle(text),
      text,
      truncated: body.truncated,
    };
  }

  throw new Error("Too many redirects.");
}

function ensureWebToolsEnabled(config: Config): void {
  if (!config.webToolsEnabled) {
    throw new Error("Web tools are disabled. Set CTM_WEB_TOOLS=1 to enable them.");
  }
}

function makeSearxngSearchUrl(baseUrl: string): URL {
  const base = new URL(baseUrl);
  if (!["http:", "https:"].includes(base.protocol)) throw new Error("CTM_SEARXNG_URL must use http or https.");
  if (base.username || base.password) throw new Error("CTM_SEARXNG_URL must not include credentials.");
  const path = base.pathname.replace(/\/$/, "");
  base.pathname = `${path}/search`;
  base.search = "";
  base.hash = "";
  return base;
}

async function assertPublicFetchUrl(inputUrl: string): Promise<URL> {
  const url = new URL(inputUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("web_fetch only supports http and https URLs.");
  if (url.username || url.password) throw new Error("web_fetch URLs must not include credentials.");

  const host = url.hostname.toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) throw new Error("web_fetch cannot access localhost.");

  if (isIP(host)) {
    if (isPrivateAddress(host)) throw new Error("web_fetch cannot access private or local network addresses.");
    return url;
  }

  const addresses = await lookup(host, { all: true, verbatim: false });
  if (addresses.length === 0) throw new Error(`Unable to resolve host: ${host}`);
  if (addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new Error("web_fetch cannot access hosts that resolve to private or local network addresses.");
  }
  return url;
}

function isPrivateAddress(address: string): boolean {
  const ipv4 = parseMappedIpv4(address) || (isIP(address) === 4 ? address : "");
  if (ipv4) return isPrivateIpv4(ipv4);
  if (isIP(address) === 6) return isPrivateIpv6(address);
  return true;
}

function parseMappedIpv4(address: string): string {
  const match = address.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return match ? match[1] : "";
}

function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(address: string): boolean {
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fe80:") || normalized.startsWith("fc") || normalized.startsWith("fd") || normalized.startsWith("ff");
}

async function fetchWithTimeout(url: string, timeoutMs: number, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      ...init,
      method: "GET",
      headers: {
        "user-agent": "chatgpt-codex-tools-mcp/0.1",
        accept: "text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.5",
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function readBodyCapped(response: Response, maxBytes: number): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!response.body) return { bytes: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - total;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    if (value.byteLength > remaining) {
      chunks.push(value.slice(0, remaining));
      total += remaining;
      truncated = true;
      break;
    }
    chunks.push(value);
    total += value.byteLength;
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes: output, truncated };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
}

function extractTitle(text: string): string {
  const match = text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return "";
  return match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}
