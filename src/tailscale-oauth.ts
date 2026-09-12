import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { Response } from "express";
import type { OAuthRegisteredClientsStore } from "@modelcontextprotocol/sdk/server/auth/clients.js";
import {
  AccessDeniedError,
  InvalidClientMetadataError,
  InvalidGrantError,
  InvalidRequestError,
  InvalidTokenError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type { AuthorizationParams, OAuthServerProvider } from "@modelcontextprotocol/sdk/server/auth/provider.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { checkResourceAllowed, resourceUrlFromServerUrl } from "@modelcontextprotocol/sdk/shared/auth-utils.js";

interface TokenRecord {
  clientId: string;
  scopes: string[];
  expiresAt: number;
  resource?: string;
}

interface PersistedOAuthState {
  clients: Record<string, OAuthClientInformationFull>;
  accessTokens: Record<string, TokenRecord>;
  refreshTokens: Record<string, TokenRecord>;
}

interface AuthorizationCodeRecord {
  clientId: string;
  params: AuthorizationParams;
  expiresAtMs: number;
}

const EMPTY_STATE: PersistedOAuthState = {
  clients: {},
  accessTokens: {},
  refreshTokens: {},
};
const CODE_TTL_MS = 5 * 60 * 1000;

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("base64url");
}

function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

function safeEquals(leftValue: string, rightValue: string): boolean {
  const left = Buffer.from(leftValue, "utf8");
  const right = Buffer.from(rightValue, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function authorizationFields(client: OAuthClientInformationFull, params: AuthorizationParams): Record<string, string | undefined> {
  return {
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: params.redirectUri,
    code_challenge: params.codeChallenge,
    code_challenge_method: "S256",
    scope: params.scopes?.join(" "),
    state: params.state,
    resource: params.resource?.href,
  };
}

function approvalPage(options: {
  clientName: string;
  scopes: string[];
  resource?: URL;
  fields: Record<string, string | undefined>;
  error?: string;
}): string {
  const hidden = Object.entries(options.fields)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([name, value]) => `<input type="hidden" name="${htmlEscape(name)}" value="${htmlEscape(value)}">`)
    .join("\n");
  const error = options.error ? `<p class="error">${htmlEscape(options.error)}</p>` : "";
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>授权 ChatGPT Codex Tools</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;background:#f5f5f5;color:#171717}
main{max-width:520px;margin:10vh auto;padding:30px;background:white;border:1px solid #ddd;border-radius:16px;box-shadow:0 18px 60px rgba(0,0,0,.12)}
h1{margin-top:0}p{line-height:1.6}.warning{background:#fff7d6;padding:12px;border-radius:10px}.error{background:#fee2e2;color:#991b1b;padding:10px;border-radius:10px}
dl{background:#f7f7f7;padding:14px;border-radius:10px}dt{font-size:12px;color:#666}dd{margin:4px 0 12px;word-break:break-all}
label{display:block;font-weight:600;margin:18px 0 8px}input[type=password]{box-sizing:border-box;width:100%;padding:12px;border:1px solid #bbb;border-radius:9px;font-size:16px}
button{margin-top:18px;width:100%;padding:12px;border:0;border-radius:9px;background:#111;color:white;font-weight:700;cursor:pointer}
</style>
</head>
<body><main>
<h1>连接 ChatGPT Codex Tools</h1>
<p class="warning">只在你正在主动连接自己的 ChatGPT / MCP 客户端时批准。</p>
${error}
<dl><dt>客户端</dt><dd>${htmlEscape(options.clientName)}</dd><dt>权限</dt><dd>${htmlEscape(options.scopes.join(" ") || "mcp")}</dd><dt>资源</dt><dd>${htmlEscape(options.resource?.href ?? "Codex MCP")}</dd></dl>
<form method="post">${hidden}<label for="owner_token">Owner Password</label><input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required><button type="submit">批准连接</button></form>
</main></body></html>`;
}

class JsonOAuthStore implements OAuthRegisteredClientsStore {
  private state: PersistedOAuthState;

  constructor(private readonly statePath: string, private readonly allowedRedirectHosts: Set<string>) {
    this.state = this.load();
    this.cleanupExpired();
  }

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    return this.state.clients[clientId];
  }

  registerClient(clientInput: Omit<OAuthClientInformationFull, "client_id" | "client_id_issued_at">): OAuthClientInformationFull {
    const client = clientInput as OAuthClientInformationFull;
    const clientId = client.client_id || randomUUID();
    const issuedAt = client.client_id_issued_at || Math.floor(Date.now() / 1000);
    for (const redirect of client.redirect_uris ?? []) this.validateRedirectUri(redirect);
    const saved: OAuthClientInformationFull = { ...client, client_id: clientId, client_id_issued_at: issuedAt };
    this.state.clients[clientId] = saved;
    this.persist();
    return saved;
  }

  getAccessToken(tokenHash: string): TokenRecord | undefined {
    return this.state.accessTokens[tokenHash];
  }

  getRefreshToken(tokenHash: string): TokenRecord | undefined {
    return this.state.refreshTokens[tokenHash];
  }

  saveTokenPair(accessHash: string, access: TokenRecord, refreshHash: string, refresh: TokenRecord, consumedRefreshHash?: string): void {
    if (consumedRefreshHash) delete this.state.refreshTokens[consumedRefreshHash];
    this.state.accessTokens[accessHash] = access;
    this.state.refreshTokens[refreshHash] = refresh;
    this.cleanupExpired(false);
    this.persist();
  }

  revoke(tokenHash: string): void {
    delete this.state.accessTokens[tokenHash];
    delete this.state.refreshTokens[tokenHash];
    this.persist();
  }

  private validateRedirectUri(value: string): void {
    let url: URL;
    try { url = new URL(value); } catch { throw new InvalidClientMetadataError("Invalid redirect URI"); }
    const host = url.hostname.toLowerCase();
    if (!this.allowedRedirectHosts.has(host)) throw new InvalidClientMetadataError(`Redirect host is not allowed: ${host}`);
    const loopback = host === "localhost" || host === "127.0.0.1" || host === "::1";
    if (!loopback && url.protocol !== "https:") throw new InvalidClientMetadataError("Non-loopback redirect URIs must use HTTPS");
  }

  private load(): PersistedOAuthState {
    if (!existsSync(this.statePath)) return structuredClone(EMPTY_STATE);
    try {
      const parsed = JSON.parse(readFileSync(this.statePath, "utf8")) as Partial<PersistedOAuthState>;
      return {
        clients: parsed.clients ?? {},
        accessTokens: parsed.accessTokens ?? {},
        refreshTokens: parsed.refreshTokens ?? {},
      };
    } catch (error) {
      throw new Error(`Failed to load Tailscale OAuth state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private cleanupExpired(persist = true): void {
    const now = Math.floor(Date.now() / 1000);
    let changed = false;
    for (const [key, value] of Object.entries(this.state.accessTokens)) if (value.expiresAt < now) { delete this.state.accessTokens[key]; changed = true; }
    for (const [key, value] of Object.entries(this.state.refreshTokens)) if (value.expiresAt < now) { delete this.state.refreshTokens[key]; changed = true; }
    if (changed && persist) this.persist();
  }

  private persist(): void {
    const temp = `${this.statePath}.tmp`;
    writeFileSync(temp, `${JSON.stringify(this.state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    renameSync(temp, this.statePath);
  }
}

export class TailscaleOwnerOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: OAuthRegisteredClientsStore;
  private readonly codes = new Map<string, AuthorizationCodeRecord>();
  private readonly store: JsonOAuthStore;
  private readonly resourceServerUrl: URL;

  constructor(
    private readonly ownerToken: string,
    resourceServerUrl: URL,
    statePath: string,
    private readonly scopes = ["mcp", "offline_access"],
    allowedRedirectHosts = ["chatgpt.com", "localhost", "127.0.0.1", "::1"],
    private readonly accessTokenTtlSeconds = 10 * 365 * 24 * 60 * 60,
    private readonly refreshTokenTtlSeconds = 10 * 365 * 24 * 60 * 60,
  ) {
    this.resourceServerUrl = resourceUrlFromServerUrl(resourceServerUrl);
    this.store = new JsonOAuthStore(statePath, new Set(allowedRedirectHosts.map((host) => host.toLowerCase())));
    this.clientsStore = this.store;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    if (!params.resource || !checkResourceAllowed({ requestedResource: params.resource, configuredResource: this.resourceServerUrl })) {
      throw new InvalidRequestError("Invalid or missing OAuth resource");
    }
    if (!(params.scopes ?? []).every((scope) => this.scopes.includes(scope))) throw new InvalidRequestError("Requested scope is not supported");

    if (res.req.method !== "POST") {
      res.status(200).type("html").send(approvalPage({
        clientName: client.client_name ?? client.client_id,
        scopes: params.scopes?.length ? params.scopes : ["mcp"],
        resource: params.resource,
        fields: authorizationFields(client, params),
      }));
      return;
    }

    const provided = String(res.req.body?.owner_token ?? "");
    if (!safeEquals(provided, this.ownerToken)) {
      res.status(401).type("html").send(approvalPage({
        clientName: client.client_name ?? client.client_id,
        scopes: params.scopes?.length ? params.scopes : ["mcp"],
        resource: params.resource,
        fields: authorizationFields(client, params),
        error: "Owner Password 不正确。",
      }));
      return;
    }

    const code = `code-${randomUUID()}`;
    this.codes.set(code, { clientId: client.client_id, params, expiresAtMs: Date.now() + CODE_TTL_MS });
    const redirect = new URL(params.redirectUri);
    redirect.searchParams.set("code", code);
    if (params.state !== undefined) redirect.searchParams.set("state", params.state);
    res.redirect(302, redirect.href);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.validCode(client, authorizationCode).params.codeChallenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const record = this.validCode(client, authorizationCode);
    if (redirectUri && redirectUri !== record.params.redirectUri) throw new InvalidGrantError("redirect_uri does not match authorization request");
    if (!resource || !checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) throw new InvalidGrantError("Invalid or missing resource");
    this.codes.delete(authorizationCode);
    return this.issueTokens(client.client_id, record.params.scopes?.length ? record.params.scopes : ["mcp"], resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const consumedHash = hashToken(refreshToken);
    const record = this.store.getRefreshToken(consumedHash);
    const now = Math.floor(Date.now() / 1000);
    if (!record || record.clientId !== client.client_id || record.expiresAt < now) throw new InvalidGrantError("Invalid refresh token");
    const requestedScopes = scopes?.length ? scopes : record.scopes;
    if (!requestedScopes.every((scope) => record.scopes.includes(scope))) throw new AccessDeniedError("Refresh token cannot grant requested scopes");
    const targetResource = resource ?? (record.resource ? new URL(record.resource) : undefined);
    if (!targetResource || !checkResourceAllowed({ requestedResource: targetResource, configuredResource: this.resourceServerUrl })) throw new InvalidGrantError("Invalid or missing resource");
    return this.issueTokens(client.client_id, requestedScopes, targetResource, consumedHash);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const record = this.store.getAccessToken(hashToken(token));
    const now = Math.floor(Date.now() / 1000);
    if (!record || record.expiresAt < now || !record.resource) throw new InvalidTokenError("Invalid or expired access token");
    const resource = new URL(record.resource);
    if (!checkResourceAllowed({ requestedResource: resource, configuredResource: this.resourceServerUrl })) throw new InvalidTokenError("Access token is for a different resource");
    return { token, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expiresAt, resource };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    this.store.revoke(hashToken(request.token));
  }

  private validCode(client: OAuthClientInformationFull, code: string): AuthorizationCodeRecord {
    const record = this.codes.get(code);
    if (!record || record.clientId !== client.client_id || record.expiresAtMs < Date.now()) throw new InvalidGrantError("Invalid authorization code");
    return record;
  }

  private issueTokens(clientId: string, scopes: string[], resource: URL, consumedRefreshHash?: string): OAuthTokens {
    const now = Math.floor(Date.now() / 1000);
    const accessToken = randomToken();
    const refreshToken = randomToken();
    this.store.saveTokenPair(
      hashToken(accessToken),
      { clientId, scopes, expiresAt: now + this.accessTokenTtlSeconds, resource: resource.href },
      hashToken(refreshToken),
      { clientId, scopes, expiresAt: now + this.refreshTokenTtlSeconds, resource: resource.href },
      consumedRefreshHash,
    );
    return {
      access_token: accessToken,
      token_type: "bearer",
      expires_in: this.accessTokenTtlSeconds,
      refresh_token: refreshToken,
      scope: scopes.join(" "),
    };
  }
}
