import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { Agent } from "undici";

export type PublicAddress = { address: string; family: number };
export type ValidatedPublicUrl = { url: URL; addresses: PublicAddress[] };
type Resolver = (host: string) => Promise<PublicAddress[]>;

// Conservative address policy: block non-global destinations and tunnel-like embedded IPv4.
const blockedIpv6 = new BlockList();
for (const [network, bits] of [
  ["::", 128], ["::1", 128], ["::", 96], ["::ffff:0:0", 96],
  ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ["64:ff9b::", 96], ["64:ff9b:1::", 48],
  ["2001::", 32], ["2001:db8::", 32], ["2002::", 16],
] as const) blockedIpv6.addSubnet(network, bits, "ipv6");

function embeddedIpv4(address: string): string | null {
  const value = address.toLowerCase();
  const dotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (dotted) return dotted[1];
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(value);
  if (!hex) return null;
  const high = parseInt(hex[1], 16), low = parseInt(hex[2], 16);
  return [high >>> 8, high & 255, low >>> 8, low & 255].join(".");
}

function privateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b, c] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && (b === 168 || (b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99))) return true;
  if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return false;
}

export function isPrivateAddress(address: string): boolean {
  const value = address.replace(/^\[|\]$/g, "");
  const mapped = embeddedIpv4(value);
  if (mapped) return privateIpv4(mapped);
  const family = isIP(value);
  if (family === 4) return privateIpv4(value);
  if (family === 6) return blockedIpv6.check(value, "ipv6");
  return true;
}

export async function validatePublicUrl(inputUrl: string, resolveHost: Resolver =
  host => lookup(host, { all: true, verbatim: false })): Promise<ValidatedPublicUrl> {
  const url = new URL(inputUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) URLs can be fetched.");
  if (url.username || url.password) throw new Error("URL credentials are prohibited.");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost")) throw new Error("Cannot fetch localhost.");
  const family = isIP(host);
  const addresses = family ? [{ address: host, family }] : await resolveHost(host);
  if (addresses.length === 0) throw new Error(`Unable to resolve host: ${host}`);
  if (addresses.some(item => isPrivateAddress(item.address))) {
    throw new Error("Cannot fetch private, reserved or local network addresses.");
  }
  return { url, addresses };
}

/** Connect using only addresses already checked by validatePublicUrl. */
export function createPinnedAgent(addresses: PublicAddress[]): Agent {
  if (addresses.length === 0 || addresses.some(item => ![4, 6].includes(item.family))) {
    throw new Error("A verified address is required.");
  }
  return new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        const permitted = addresses.filter(item => !options.family || options.family === item.family);
        if (permitted.length === 0) {
          callback(new Error("No validated address for requested IP family"), "", 0);
          return;
        }
        if (options.all) callback(null, permitted);
        else callback(null, permitted[0].address, permitted[0].family);
      },
    },
  });
}
