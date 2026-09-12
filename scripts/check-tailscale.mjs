import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

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
const dnsName = String(status?.Self?.DNSName ?? "").trim().replace(/\.$/, "");
console.log(JSON.stringify({
  running: status.BackendState === "Running",
  dnsName,
  executable: tailscale,
}));
