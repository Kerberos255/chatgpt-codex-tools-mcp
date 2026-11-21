import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { applyChanges, previewChanges, previewChangesWithFingerprints, type Change } from "../src/edit-store.js";

async function fixture(fn: (root: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "ctm-edit-acceptance-"));
  try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
}

test("normalized path spellings share one virtual edit state", async () => fixture(async root => {
  writeFileSync(join(root, "demo.txt"), "one");
  const changes: Change[] = [
    { type: "replace_text", path: "./demo.txt", oldText: "one", newText: "two" },
    { type: "replace_text", path: "other/../demo.txt", oldText: "two", newText: "three" },
  ];
  const preview = await previewChangesWithFingerprints(root, changes);
  assert.equal(preview.fingerprints.length, 1);
  await applyChanges(root, changes, { expectedFingerprints: preview.fingerprints });
  assert.equal(readFileSync(join(root, "demo.txt"), "utf8"), "three");
}));

test("binary rename preserves every byte; text mutation is rejected", async () => fixture(async root => {
  const bytes = Buffer.from([0, 255, 1, 128, 9, 10, 0, 240, 159, 153, 130]);
  writeFileSync(join(root, "before.bin"), bytes);
  await assert.rejects(previewChanges(root, [{ type: "append", path: "before.bin", text: "x" }]), /Binary or non-UTF-8/);
  const changes: Change[] = [{ type: "rename", path: "before.bin", newPath: "after.bin" }];
  const preview = await previewChangesWithFingerprints(root, changes);
  await applyChanges(root, changes, { expectedFingerprints: preview.fingerprints });
  assert.equal(existsSync(join(root, "before.bin")), false);
  assert.deepEqual(readFileSync(join(root, "after.bin")), bytes);
}));

test("rollback restores original bytes even when a binary file was deleted", async () => fixture(async root => {
  const bytes = Buffer.from([0, 255, 239, 191, 189, 42]);
  writeFileSync(join(root, "a.bin"), bytes);
  writeFileSync(join(root, "b.txt"), "before");
  await assert.rejects(applyChanges(root, [
    { type: "delete", path: "a.bin" },
    { type: "overwrite", path: "b.txt", newText: "after" },
  ], { beforeCommit: index => { if (index === 1) throw new Error("injected failure"); } }), /injected failure/);
  assert.deepEqual(readFileSync(join(root, "a.bin")), bytes);
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "before");
}));

test("confirmation is bound to the exact original preview content", async () => fixture(async root => {
  writeFileSync(join(root, "demo.txt"), "approved");
  const changes: Change[] = [{ type: "overwrite", path: "demo.txt", newText: "next" }];
  const preview = await previewChangesWithFingerprints(root, changes);
  writeFileSync(join(root, "demo.txt"), "changed after preview");
  await assert.rejects(applyChanges(root, changes, { expectedFingerprints: preview.fingerprints }), /changed since preview/);
  assert.equal(readFileSync(join(root, "demo.txt"), "utf8"), "changed after preview");
}));

test("internal aliases are rejected for writes without touching their targets", async () => fixture(async root => {
  mkdirSync(join(root, "actual"));
  writeFileSync(join(root, "actual", "demo.txt"), "original");
  symlinkSync(join(root, "actual"), join(root, "alias"), "junction");
  await assert.rejects(previewChanges(root, [
    { type: "overwrite", path: "alias/demo.txt", newText: "changed" },
  ]), /alias or junction/);
  assert.equal(readFileSync(join(root, "actual", "demo.txt"), "utf8"), "original");
}));

test("large line-count diffs are bounded without exceeding argument limits", async () => fixture(async root => {
  writeFileSync(join(root, "many.txt"), "old\n".repeat(150000));
  const changes: Change[] = [{ type: "overwrite", path: "many.txt", newText: "new" }];
  const diffs = await previewChanges(root, changes);
  assert.ok(Buffer.byteLength(diffs[0].diff) <= 32000);
  await applyChanges(root, changes);
  assert.equal(readFileSync(join(root, "many.txt"), "utf8"), "new");
}));
