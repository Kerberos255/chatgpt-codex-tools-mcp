import assert from "node:assert/strict";
import test from "node:test";
import { formatFetchedBody } from "../src/html-text.js";

test("optional HTML text mode removes non-content markup and decodes entities", () => {
  const html = [
    "<html><head><title>Example</title><style>.hidden{display:none}</style></head>",
    "<body><nav>MENU-DO-NOT-INCLUDE</nav>",
    "<main><h1>中文 &amp; English</h1>",
    "<p>Useful article <a href='https://example.org'>link</a> appears here.</p>",
    "<script>STEAL-DO-NOT-INCLUDE()</script></main><footer>FOOTER-DO-NOT-INCLUDE</footer>",
    "</body></html>",
  ].join("");
  const result = formatFetchedBody(html, "text/html; charset=utf-8", "text");
  assert.match(result, /中文 & English/i);
  assert.match(result, /Useful article/);
  assert.match(result, /link/);
  assert.doesNotMatch(result, /MENU-DO-NOT-INCLUDE|STEAL-DO-NOT-INCLUDE|FOOTER-DO-NOT-INCLUDE|hidden/);
  assert.ok(Buffer.byteLength(result, "utf8") < Buffer.byteLength(html, "utf8"));
  assert.equal(formatFetchedBody(html, "text/html", "raw"), html);
});

test("text conversion never mutates JSON, plaintext, or unknown content types", () => {
  const source = '{"html":"<p>data</p>"}';
  for (const type of ["application/json", "text/plain", "application/octet-stream"]) {
    assert.equal(formatFetchedBody(source, type, "text"), source);
  }
});
