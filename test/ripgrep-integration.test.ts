import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { searchTextFiles } from "../src/workspace-files.js";

const available = spawnSync("rg", ["--version"], { windowsHide: true, timeout: 5000 }).status === 0;

test("actual ripgrep handles context, limits and canonical deny rules", { skip: !available }, async () => {
  const root = mkdtempSync(join(tmpdir(), "ctm-rg-test-"));
  try {
    function put(rel: string, content: string) {
      const path = join(root, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, content);
    }
    put("src/v1-2-fix.ts", "before\nneedle\nend\n");
    put("src/denied.ts", "needle EXCLUDED\n");
    put("src/RESTRICTED/file.ts", "needle DENIED_DIR\n");
    put("node_modules/dep.ts", "needle DEPENDENCY\n");
    put("src/many.ts", Array.from({ length: 4000 }, (_, i) => "needle row " + i + " " + "x".repeat(40)).join("\n"));
    symlinkSync(join(root, "src"), join(root, "alias"), "junction");
    const config = loadConfig({ CTM_CONFIG_PATH: join(root, "missing.json"), CTM_ALLOWED_ROOTS: root,
      CTM_DENY_GLOBS: "src/denied.ts,**/restricted/**", CTM_MAX_OUTPUT_BYTES: "8000" });
    const one = await searchTextFiles(config, root, join(root, "src", "v1-2-fix.ts"), "needle", false, 1, 20, undefined, undefined, null, null);
    assert.match(one, /src\/v1-2-fix\.ts:2:needle/);
    assert.match(one, /before/);
    assert.match(one, /end/);
    const filtered = await searchTextFiles(config, root, root, "needle", false, 0, 100, "**/*.ts", undefined, null, null);
    assert.doesNotMatch(filtered, /EXCLUDED|DENIED_DIR|DEPENDENCY/);
    const alias = await searchTextFiles(config, root, join(root, "alias"), "needle", false, 0, 100, undefined, undefined, null, null);
    assert.doesNotMatch(alias, /EXCLUDED|DENIED_DIR/);
    const capped = await searchTextFiles({ ...config, maxOutputBytes: 1000 }, root, join(root, "src", "many.ts"), "needle", true, 0, 500, undefined, undefined, null, null);
    assert.ok(Buffer.byteLength(capped) <= 1000);
    assert.match(capped, /truncated/);
    assert.match(capped, /src\/many\.ts:/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
