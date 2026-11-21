import { Agent } from "undici";
import { validatePublicUrl, createPinnedAgent } from "./public-fetch-policy.js";
import { formatFetchedBody, type FetchFormat } from "./html-text.js";
import { createRequire } from "node:module";
const packageVersion = (createRequire(import.meta.url)("../package.json") as { version: string }).version;
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
      privateNetworkTargets: 'blocked for web(action="fetch")',
      redirects: "checked before each hop",
    },
  };
}

export async function webSearch(config: Config, query: string, limit: number): Promise<SearchResult[]> {
  ensureWebToolsEnabled(config);
  if (config.searchProvider !== "searxng") {
    throw new Error('web(action="search") requires CTM_SEARCH_PROVIDER=searxng.');
  }
  if (!config.searxngUrl) {
    throw new Error('web(action="search") requires CTM_SEARXNG_URL.');
  }

  const endpoint = makeSearxngSearchUrl(config.searxngUrl);
  endpoint.searchParams.set("q", query);
  endpoint.searchParams.set("format", "json");

  const data = await withAbortDeadline(config.webTimeoutMs, async signal => {
    const response = await fetchWithSignal(endpoint.toString(), signal);
    if (!response.ok) throw new Error(`SearXNG search failed: HTTP ${response.status}`);
    return await response.json() as { results?: Array<Record<string, unknown>> };
  });

  return (data.results || []).slice(0, Math.max(1, Math.min(limit, 10))).map((item) => ({
    title: String(item.title || ""),
    url: String(item.url || ""),
    snippet: String(item.content || item.snippet || ""),
    engine: Array.isArray(item.engines) ? item.engines.join(", ") : String(item.engine || ""),
  }));
}

export async function webFetch(config: Config, inputUrl: string, format: FetchFormat = "raw"): Promise<FetchResult> {
  ensureWebToolsEnabled(config);
  return withAbortDeadline(config.webTimeoutMs, async signal => {
    let target = await validatePublicUrl(inputUrl);
    for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
      // The dispatcher never performs an unrestricted second DNS lookup.
      const dispatcher = createPinnedAgent(target.addresses);
      try {
        const response = await fetchWithSignal(target.url.toString(), signal, {
          redirect: "manual",
          dispatcher,
        } as RequestInit & { dispatcher: Agent });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          await response.body?.cancel();
          if (!location) throw new Error(`Redirect response missing Location header: HTTP ${response.status}`);
          target = await validatePublicUrl(new URL(location, target.url).toString());
          continue;
        }

        const contentType = response.headers.get("content-type") || "";
        const body = await readBodyCapped(response, config.webMaxBytes);
        const source = decodeUtf8(body.bytes);
        const text = formatFetchedBody(source, contentType, format);
        return {
          finalUrl: target.url.toString(),
          status: response.status,
          contentType,
          title: extractTitle(source),
          text,
          truncated: body.truncated,
        };
      } finally {
        dispatcher.destroy();
      }
    }
    throw new Error("Too many redirects.");
  });
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

/** A deadline covering headers and response-body consumption. */
export async function withAbortDeadline<T>(timeoutMs: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fn(controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithSignal(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
  return fetch(url, {
    ...init,
    method: "GET",
    headers: {
      "user-agent": `chatgpt-codex-tools-mcp/${packageVersion}`,
      accept: "text/html,application/json,text/plain,application/xml;q=0.9,*/*;q=0.5",
    },
    signal,
  });
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
