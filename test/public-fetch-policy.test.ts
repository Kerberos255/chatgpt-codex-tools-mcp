import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { Agent } from "undici";
import { createPinnedAgent, isPrivateAddress, validatePublicUrl } from "../src/public-fetch-policy.js";

test("mapped IPv4 and translated IPv6 cannot bypass private-network checks", () => {
  for (const address of [
    "127.0.0.1", "10.2.3.4", "192.168.0.3", "169.254.169.254",
    "::1", "fc00::1", "fe90::1", "::ffff:7f00:1",
    "::ffff:192.168.1.1", "64:ff9b::7f00:1", "2002:7f00:1::1",
    "192.0.2.5", "198.51.100.3", "203.0.113.2",
  ]) assert.equal(isPrivateAddress(address), true, address);
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:808:808"]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("public URL validation blocks mixed DNS answers and URL credentials", async () => {
  await assert.rejects(validatePublicUrl("http://localhost/"), /localhost/);
  await assert.rejects(validatePublicUrl("http://[::ffff:7f00:1]/"), /private/);
  await assert.rejects(validatePublicUrl("https://name:secret@example.test"), /credentials/);
  await assert.rejects(validatePublicUrl("https://example.test", async () => [
    { address: "8.8.8.8", family: 4 },
    { address: "127.0.0.1", family: 4 },
  ]), /private/);
  const valid = await validatePublicUrl("https://example.test", async () => [
    { address: "8.8.8.8", family: 4 },
  ]);
  assert.equal(valid.addresses[0].address, "8.8.8.8");
});

test("pinned dispatcher connects to its validated address without re-resolving hostname", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("pinned");
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const dispatcher: Agent = createPinnedAgent([{ address: "127.0.0.1", family: 4 }]);
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const response = await fetch(`http://pin-test.invalid:${address.port}/`, {
      dispatcher,
    } as RequestInit & { dispatcher: Agent });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "pinned");
  } finally {
    dispatcher.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
