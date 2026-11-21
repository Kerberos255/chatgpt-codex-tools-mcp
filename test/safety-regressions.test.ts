import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import test from "node:test";

import { applyChanges, previewChanges, type Change } from "../src/edit-store.js";
import { assertNotDenied, assertRealWorkspacePath } from "../src/paths.js";
import { normalizeRipgrepOutputLine, parseRipgrepOutputPath } from "../src/ripgrep-output.js";
import { SqliteChangeStore } from "../src/sqlite-tools.js";
import { capText, truncateUtf8 } from "../src/text.js";
import { withAbortDeadline } from "../src/web.js";

function withTemp(fn: (root: string) => Promise<void>) {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), "ctm-regression-"));
    try { await fn(root); } finally { rmSync(root, { recursive: true, force: true }); }
  };
}

test("replace_text inserts dollar substitution tokens literally", withTemp(async root => {
  const file = join(root, "main.txt");
  writeFileSync(file, "before VALUE after", "utf8");
  const newText = 'echo "$1 $& $$"';
  const changes: Change[] = [{ type: "replace_text", path: "main.txt", oldText: "VALUE", newText }];
  await previewChanges(root, changes);
  await applyChanges(root, changes);
  assert.equal(readFileSync(file, "utf8"), `before ${newText} after`);
}));

test("empty oldText rejects existing file, remains compatible for new file", withTemp(async root => {
  writeFileSync(join(root, "exists.txt"), "original", "utf8");
  await assert.rejects(previewChanges(root, [
    { type: "replace_text", path: "exists.txt", oldText: "", newText: "x" },
  ]), /oldText cannot be empty/);
  assert.equal(readFileSync(join(root, "exists.txt"), "utf8"), "original");
  const create: Change[] = [{ type: "replace_text", path: "new.txt", oldText: "", newText: "new" }];
  await previewChanges(root, create);
  await applyChanges(root, create);
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "new");
}));

test("replace_text rejects repeated or overlapping matches", withTemp(async root => {
  writeFileSync(join(root, "repeated.txt"), "foo x foo", "utf8");
  await assert.rejects(previewChanges(root, [
    { type: "replace_text", path: "repeated.txt", oldText: "foo", newText: "bar" },
  ]), /ambiguous/);
  writeFileSync(join(root, "repeated.txt"), "aaa", "utf8");
  await assert.rejects(previewChanges(root, [
    { type: "replace_text", path: "repeated.txt", oldText: "aa", newText: "b" },
  ]), /ambiguous/);
}));

test("ripgrep NUL path separator preserves dashed numeric filenames", () => {
  const hit = "src/v1-2-fix.ts\0" + "10:hello";
  assert.equal(parseRipgrepOutputPath(hit), "src/v1-2-fix.ts");
  assert.equal(normalizeRipgrepOutputLine(hit), "src/v1-2-fix.ts:10:hello");
  const context = "src/v1-2-fix.ts\0" + "9-before";
  assert.equal(parseRipgrepOutputPath(context), "src/v1-2-fix.ts");
  assert.equal(normalizeRipgrepOutputLine(context), "src/v1-2-fix.ts:9-before");
  assert.equal(parseRipgrepOutputPath("--"), null);
});

test("deny matcher checks the entire NUL-delimited filename", () => {
  const root = join(tmpdir(), "ctm-test-root");
  const secret = parseRipgrepOutputPath("my-1-secret.txt\0" + "12:example");
  assert.ok(secret);
  assert.throws(() => assertNotDenied(join(root, secret), root, ["my-1-secret.txt"]), /blocked/);
});

test("SQLite pending changes are bounded and expire", () => {
  let now = 1000;
  const store = new SqliteChangeStore(2, 10, () => now);
  const make = () => store.create({
    dbPath: "test.sqlite",
    change: { type: "insert", table: "test", columns: ["name"], values: ["value"] },
    beforeRows: [],
    diff: "+ value",
  });
  const first = make();
  const second = make();
  assert.throws(() => make(), /Too many pending/);
  assert.equal(store.take(first.id).id, first.id);
  now += 11;
  assert.throws(() => store.take(second.id), /Unknown or expired/);
  assert.ok(make().id.startsWith("sqlite_"));
});

test("UTF-8 capping never introduces a replacement character", () => {
  const value = "A汉🙂B多字节";
  const buffer = Buffer.from(value, "utf8");
  for (let limit = 0; limit <= 45; limit++) {
    for (const output of [truncateUtf8(buffer, limit), capText(value, limit)]) {
      assert.equal(output.includes("\uFFFD"), false, `invalid UTF-8 at budget ${limit}`);
      assert.ok(Buffer.byteLength(output, "utf8") <= limit);
    }
  }
});

test("HTTP deadline covers a stalled streaming response body", async () => {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/plain" });
    res.write("started");
    // Deliberately leave the response body open.
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const started = Date.now();
    await assert.rejects(
      withAbortDeadline(250, async signal => {
        const response = await fetch(`http://127.0.0.1:${address.port}/`, { signal });
        return response.text();
      }),
      /abort/i,
    );
    assert.ok(Date.now() - started < 1500, "response-body timeout exceeded reasonable grace");
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});

test("batch edits plan sequentially against the virtual file", withTemp(async root => {
  const file = join(root, "batch.txt");
  writeFileSync(file, "foo\n", "utf8");
  const valid: Change[] = [
    { type: "replace_text", path: "batch.txt", oldText: "foo", newText: "bar" },
    { type: "insert_after", path: "batch.txt", anchorAfter: "bar", text: "-after" },
  ];
  const diffs = await previewChanges(root, valid);
  assert.equal(diffs.length, 2);
  assert.match(diffs[1].diff, /\+bar-after/);
  assert.equal(readFileSync(file, "utf8"), "foo\n", "preview must not write");
  await applyChanges(root, valid);
  assert.equal(readFileSync(file, "utf8"), "bar-after\n");
}));

test("invalid second batch edit fails preview before any disk mutation", withTemp(async root => {
  const file = join(root, "batch.txt");
  writeFileSync(file, "foo", "utf8");
  const invalid: Change[] = [
    { type: "replace_text", path: "batch.txt", oldText: "foo", newText: "bar" },
    { type: "insert_after", path: "batch.txt", anchorAfter: "foo", text: "extra" },
  ];
  await assert.rejects(previewChanges(root, invalid), /anchor not found/);
  await assert.rejects(applyChanges(root, invalid), /anchor not found/);
  assert.equal(readFileSync(file, "utf8"), "foo");
}));

test("replace_range preserves CRLF and overwrite previews actual content", withTemp(async root => {
  const file = join(root, "crlf.txt");
  writeFileSync(file, "one\r\ntwo\r\nthree\r\n", "utf8");
  const changes: Change[] = [
    { type: "replace_range", path: "crlf.txt", startLine: 2, endLine: 2, newText: "second\nline" },
  ];
  await previewChanges(root, changes);
  await applyChanges(root, changes);
  assert.equal(readFileSync(file, "utf8"), "one\r\nsecond\r\nline\r\nthree\r\n");
  const overwrite = await previewChanges(root, [
    { type: "overwrite", path: "crlf.txt", newText: "entire replacement" },
  ]);
  assert.match(overwrite[0].diff, /\+entire replacement/);
}));

test("rename and subsequent edits use the new virtual path", withTemp(async root => {
  writeFileSync(join(root, "old.txt"), "alpha", "utf8");
  const changes: Change[] = [
    { type: "rename", path: "old.txt", newPath: "new.txt" },
    { type: "replace_text", path: "new.txt", oldText: "alpha", newText: "beta" },
  ];
  await previewChanges(root, changes);
  await applyChanges(root, changes);
  assert.equal(readFileSync(join(root, "new.txt"), "utf8"), "beta");
  assert.equal(existsSync(join(root, "old.txt")), false);
}));

test("directory-deny glob rejects its directory and descendants", () => {
  const root = join(tmpdir(), "ctm-test-root");
  const globs = ["**/secrets/**"];
  assert.throws(() => assertNotDenied(join(root, "secrets"), root, globs), /blocked/);
  assert.throws(() => assertNotDenied(join(root, "src", "secrets", "key.txt"), root, globs), /blocked/);
  assert.doesNotThrow(() => assertNotDenied(join(root, "src", "public.ts"), root, globs));
});

test("failed second commit restores first file and removes staged temporary files", withTemp(async root => {
  const first = join(root, "first.txt"), second = join(root, "second.txt");
  writeFileSync(first, "ONE");
  writeFileSync(second, "TWO");
  const changes: Change[] = [
    { type: "overwrite", path: "first.txt", newText: "1" },
    { type: "overwrite", path: "second.txt", newText: "2" },
  ];
  await assert.rejects(
    applyChanges(root, changes, { beforeCommit: index => {
      if (index === 1) throw new Error("injected commit failure");
    }}),
    /injected commit failure/,
  );
  assert.equal(readFileSync(first, "utf8"), "ONE");
  assert.equal(readFileSync(second, "utf8"), "TWO");
  assert.equal(readdirSync(root).filter(name => name.includes(".ctm-tmp-")).length, 0);
}));

test("rollback refuses to overwrite external writes after a partial commit", withTemp(async root => {
  const first = join(root, "first.txt");
  writeFileSync(first, "ONE");
  writeFileSync(join(root, "second.txt"), "TWO");
  const changes: Change[] = [
    { type: "overwrite", path: "first.txt", newText: "changed" },
    { type: "overwrite", path: "second.txt", newText: "two" },
  ];
  await assert.rejects(
    applyChanges(root, changes, { beforeCommit: index => {
      if (index === 1) {
        writeFileSync(first, "EXTERNAL");
        throw new Error("injected failure");
      }
    }}),
    /rollback incomplete/,
  );
  assert.equal(readFileSync(first, "utf8"), "EXTERNAL");
  assert.equal(readFileSync(join(root, "second.txt"), "utf8"), "TWO");
  assert.equal(readdirSync(root).filter(name => name.includes(".ctm-tmp-")).length, 0);
}));

test("concurrent change to an uncommitted file aborts and restores prior commits", withTemp(async root => {
  writeFileSync(join(root, "first.txt"), "ONE");
  const second = join(root, "second.txt");
  writeFileSync(second, "TWO");
  const changes: Change[] = [
    { type: "overwrite", path: "first.txt", newText: "one" },
    { type: "overwrite", path: "second.txt", newText: "two" },
  ];
  await assert.rejects(
    applyChanges(root, changes, { beforeCommit: index => {
      if (index === 1) writeFileSync(second, "EXTERNAL");
    }}),
    /File changed during commit/,
  );
  assert.equal(readFileSync(join(root, "first.txt"), "utf8"), "ONE");
  assert.equal(readFileSync(second, "utf8"), "EXTERNAL");
}));

test("edit commit and rollback retain existing POSIX file permissions", {
  skip: process.platform === "win32",
}, withTemp(async root => {
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  writeFileSync(first, "original");
  writeFileSync(second, "other");
  chmodSync(first, 0o640);
  const change: Change[] = [
    { type: "overwrite", path: "first.txt", newText: "new" },
  ];
  await applyChanges(root, change);
  assert.equal(statSync(first).mode & 0o777, 0o640);
  await assert.rejects(
    applyChanges(root, [
      { type: "overwrite", path: "first.txt", newText: "temporary" },
      { type: "overwrite", path: "second.txt", newText: "other-new" },
    ], { beforeCommit: index => {
      if (index === 1) throw new Error("injected");
    }}),
    /injected/,
  );
  assert.equal(readFileSync(first, "utf8"), "new");
  assert.equal(statSync(first).mode & 0o777, 0o640);
}));

test("commit rechecks canonical paths after a directory becomes a junction", withTemp(async root => {
  const external = mkdtempSync(join(tmpdir(), "ctm-junction-target-"));
  const dir = join(root, "editable");
  const moved = join(root, "moved");
  mkdirSync(dir);
  writeFileSync(join(dir, "file.txt"), "ORIGINAL");
  writeFileSync(join(external, "file.txt"), "OUTSIDE");
  let movedDirectory = false;
  try {
    await assert.rejects(applyChanges(root, [
      { type: "overwrite", path: "editable/file.txt", newText: "CHANGED" },
    ], {
      validatePath: async name => {
        await assertRealWorkspacePath(resolve(root, name), root, [root], []);
      },
      beforeCommit: () => {
        renameSync(dir, moved);
        movedDirectory = true;
        symlinkSync(external, dir, "junction");
      },
    }), /Symlink or junction escapes/);
    assert.equal(readFileSync(join(external, "file.txt"), "utf8"), "OUTSIDE");
    assert.equal(readFileSync(join(moved, "file.txt"), "utf8"), "ORIGINAL");
  } finally {
    if (movedDirectory) rmSync(dir, { force: true, recursive: true });
    rmSync(external, { force: true, recursive: true });
  }
}));
