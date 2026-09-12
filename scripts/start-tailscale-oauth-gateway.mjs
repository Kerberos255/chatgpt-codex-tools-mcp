import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const tunnelRoot = resolve(projectRoot, "tunnel", "tailscale");
mkdirSync(tunnelRoot, { recursive: true });

function findTailscale() {
  const configured = String(process.env.CTM_TAILSCALE_EXE || "").trim();
  if (configured && existsSync(configured)) return configured;

  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  const installed = resolve(programFiles, "Tailscale", "tailscale.exe");
  if (existsSync(installed)) return installed;

  try {
    const located = execFileSync("where.exe", ["tailscale.exe"], { encoding: "utf8" })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    if (located) return located;
  } catch {}
  throw new Error("Tailscale is not installed or tailscale.exe could not be found.");
}

const tailscale = findTailscale();
const status = JSON.parse(execFileSync(tailscale, ["status", "--json"], { encoding: "utf8" }));
if (status.BackendState !== "Running") throw new Error("Tailscale is not connected.");
const dnsName = String(status?.Self?.DNSName ?? "").trim().replace(/\.$/, "");
if (!dnsName) throw new Error("Tailscale DNS name is unavailable. Ensure MagicDNS is enabled.");

process.env.CTM_TAILSCALE_PUBLIC_BASE_URL ||= `https://${dnsName}`;
process.env.CTM_TAILSCALE_GATEWAY_PORT ||= "3334";
process.env.CTM_TAILSCALE_TARGET_PORT ||= "3333";
process.env.CTM_TAILSCALE_OWNER_TOKEN_FILE ||= "tunnel/tailscale/owner-password.txt";
process.env.CTM_TAILSCALE_OAUTH_STATE_FILE ||= "tunnel/tailscale/oauth-state.json";

console.log(`Tailscale public base: ${process.env.CTM_TAILSCALE_PUBLIC_BASE_URL}`);
console.log(`OAuth gateway: http://127.0.0.1:${process.env.CTM_TAILSCALE_GATEWAY_PORT}`);
console.log("Owner Password is stored in tunnel/tailscale/owner-password.txt and is not printed.");
console.log("Keep this window open while using the Tailscale MCP connection.");
process.chdir(projectRoot);
await import("../dist/tailscale-gateway.js");
