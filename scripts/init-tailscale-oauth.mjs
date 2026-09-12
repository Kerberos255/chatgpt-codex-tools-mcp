import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const tunnelRoot = resolve(projectRoot, "tunnel", "tailscale");
const tokenPath = resolve(tunnelRoot, "owner-password.txt");
const statePath = resolve(tunnelRoot, "oauth-state.json");
const legacyTokenPath = resolve(projectRoot, ".tailscale-owner-token");
const legacyStatePath = resolve(projectRoot, ".tailscale-oauth-token-state.json");
mkdirSync(tunnelRoot, { recursive: true });

if (!existsSync(tokenPath) && existsSync(legacyTokenPath)) {
  copyFileSync(legacyTokenPath, tokenPath);
  console.log("Migrated legacy Tailscale Owner Password into tunnel/tailscale.");
}
if (!existsSync(statePath) && existsSync(legacyStatePath)) {
  copyFileSync(legacyStatePath, statePath);
  console.log("Migrated legacy Tailscale OAuth state into tunnel/tailscale.");
}

if (existsSync(tokenPath)) {
  console.log("Tailscale Owner Password already exists; leaving it unchanged.");
  process.exit(0);
}

writeFileSync(tokenPath, `${randomBytes(32).toString("base64url")}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
console.log("Created tunnel/tailscale/owner-password.txt.");
console.log("The password is not printed. Open that local file only when the OAuth approval page asks for it.");
