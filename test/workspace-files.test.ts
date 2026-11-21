import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.js";
import { createGlobMatcher } from "../src/globs.js";
import { buildProjectTree, findFilesByGlob, readFileCapped, searchTextFilesFallback } from "../src/workspace-files.js";
import { sqliteChanges, sqliteConfirmChange } from "../src/sqlite-tools.js";
import { WorkspaceRegistry } from "../src/workspaces.js";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "ctm-file-tools-"));
  const external = mkdtempSync(join(tmpdir(), "ctm-outside-"));
  const config = loadConfig({ CTM_CONFIG_PATH: join(root, "absent.json"), CTM_ALLOWED_ROOTS: root,
    CTM_DENY_GLOBS: "**/restricted/**", CTM_MAX_READ_BYTES: "1024", CTM_MAX_OUTPUT_BYTES: "4096" });
  const put = (rel: string, body: string) => { const target = join(root, rel); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, body); };
  put("src/one.ts", "first\nneedle\nlast");
  put("src/two.TS", "NEEDLE");
  put("src/ignored.ts", "needle");
  put(".hidden.ts", "needle");
  put(".gitignore", "src/ignored.ts\n");
  put("node_modules/ignore.ts", "needle");
  put("src/dist/ignore.ts", "needle");
  put("src/restricted/excluded.ts", "needle");
  writeFileSync(join(external, "outside.ts"), "needle");
  symlinkSync(external, join(root, "outside-junction"), "junction");
  symlinkSync(join(root, "src"), join(root, "inside-junction"), "junction");
  return { root, external, config, put, clean: () => {
    rmSync(root, { recursive: true, force: true }); rmSync(external, { recursive: true, force: true });
  }};
}
const tsMatcher = createGlobMatcher("**/*.ts", { matchBasename: true });

test("streaming find preserves glob, hidden and ignored-file semantics and skips junctions", async () => {
  const f = fixture();
  try {
    const paths = await findFilesByGlob(f.config, f.root, f.root, tsMatcher, 100);
    assert.deepEqual([...paths].sort(), [".hidden.ts", "src/ignored.ts", "src/one.ts", "src/two.TS"].sort());
    assert.equal((await findFilesByGlob(f.config, f.root, f.root, tsMatcher, 1)).length, 1);
    const selected = await findFilesByGlob(f.config, f.root, join(f.root, "src", "one.ts"), tsMatcher, 10);
    assert.deepEqual(selected, ["src/one.ts"]);
    assert.deepEqual(await findFilesByGlob(f.config, f.root, join(f.root, "outside-junction"), tsMatcher, 10), []);
  } finally { f.clean(); }
});

test("validated internal aliases do not bypass canonical-path deny rules", async () => {
  const f = fixture();
  try {
    f.config.denyGlobs = ["src/one.ts"];
    const paths = await findFilesByGlob(f.config, f.root, join(f.root, "inside-junction"), tsMatcher, 100);
    assert.ok(paths.includes("inside-junction/two.TS"));
    assert.ok(!paths.includes("inside-junction/one.ts"));
    const tree = await buildProjectTree(f.config, f.root, join(f.root, "inside-junction"), 0, 2);
    assert.match(tree, /two\.TS/);
    assert.doesNotMatch(tree, /one\.ts/);
  } finally { f.clean(); }
});

test("fallback search respects includes, excludes, case sensitivity, and entry limits", async () => {
  const f = fixture();
  try {
    const result = await searchTextFilesFallback(f.config, f.root, f.root, "needle", true, 0, 100,
      createGlobMatcher("src/**/*.ts", { matchBasename: true }),
      createGlobMatcher("**/ignored.ts", { matchBasename: true }));
    assert.equal(result, "src/one.ts:2: needle");
    const insensitive = await searchTextFilesFallback(f.config, f.root, f.root, "needle", false, 0, 100, null, null);
    assert.match(insensitive, /src\/two\.TS:1: NEEDLE/);
    assert.doesNotMatch(insensitive, /outside-junction|inside-junction|restricted|node_modules|\/dist\//);
    const limited = await searchTextFilesFallback(f.config, f.root, f.root, "needle", false, 0, 1, null, null);
    assert.equal(limited.split("\n").length, 1);
  } finally { f.clean(); }
});

test("project tree retains directory pruning and depth conventions", async () => {
  const f = fixture();
  try {
    const tree = await buildProjectTree(f.config, f.root, f.root, 0, 2);
    assert.match(tree, /src\//);
    assert.match(tree, /one\.ts/);
    assert.match(tree, /\.hidden\.ts/);
    assert.doesNotMatch(tree, /outside-junction|inside-junction|restricted|node_modules|dist\//);
  } finally { f.clean(); }
});

test("capped read never breaks UTF-8 when the byte limit cuts a code point", async () => {
  const f = fixture();
  try {
    f.put("unicode.txt", "A汉🙂B");
    for (const cap of [2, 3, 5, 6, 7]) {
      const value = await readFileCapped(join(f.root, "unicode.txt"), cap);
      assert.equal(value.truncated, true);
      assert.doesNotMatch(value.text, /\uFFFD/);
    }
  } finally { f.clean(); }
});

test("SQLite confirmation rechecks the current allowlist before opening a database", () => {
  const f = fixture();
  try {
    const pending = sqliteChanges.create({ dbPath: join(f.root, "not-allowed.sqlite"),
      change: { type: "insert", table: "example", columns: ["value"], values: ["x"] },
      diff: "+ x", beforeRows: [] });
    assert.throws(() => sqliteConfirmChange({ ...f.config, sqliteToolsEnabled: true,
      sqliteAllowedDbs: [join(f.root, "allowed.sqlite")] }, pending.id), /not in CTM_SQLITE_ALLOWED_DBS/);
  } finally { f.clean(); }
});

test("workspace validation resolves paths afresh after a junction changes", async () => {
  const f = fixture();
  try {
    const registry = new WorkspaceRegistry(f.config);
    const workspace = await registry.open(f.root);
    await registry.resolveSafe(workspace.id, "inside-junction/one.ts");
    rmSync(join(f.root, "inside-junction"), { recursive: true, force: true });
    symlinkSync(f.external, join(f.root, "inside-junction"), "junction");
    await assert.rejects(registry.resolveSafe(workspace.id, "inside-junction/outside.ts"), /escapes the workspace/);
  } finally { f.clean(); }
});
