import assert from "node:assert/strict";
import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

const stubModules = new Map([
  ["@earendil-works/pi-coding-agent", `
    export function keyHint(_key, description) { return description; }
    export function renderDiff(value) { return value; }
    export async function withFileMutationQueue(_path, fn) { return fn(); }
    export function generateDiffString(oldText, newText) {
      return { diff: oldText === newText ? "" : "- " + oldText + "\\n+ " + newText, firstChangedLine: 1 };
    }
    export function generateUnifiedPatch(path, oldText, newText) {
      return oldText === newText ? "" : "--- " + path + "\\n+++ " + path + "\\n-" + oldText + "\\n+" + newText;
    }
  `],
  ["@earendil-works/pi-tui", `
    export class Text {
      constructor(value = "") { this.value = value; }
      render() { return String(this.value).split(/\\r?\\n/); }
      invalidate() {}
    }
    export class Container {
      constructor() { this.children = []; }
      addChild(child) { this.children.push(child); }
      clear() { this.children = []; }
      render(width) { return this.children.flatMap((child) => child.render(width)); }
      invalidate() { for (const child of this.children) child.invalidate?.(); }
    }
    export class Box extends Container {
      constructor(...args) { super(); this.args = args; }
      setBgFn(fn) { this.bgFn = fn; }
    }
    export class Spacer {
      constructor(lines = 1) { this.lines = lines; }
      render() { return Array(this.lines).fill(""); }
      invalidate() {}
    }
    export function visibleWidth(value) { return String(value).length; }
    export function truncateToWidth(value, width, marker = "…") {
      const text = String(value);
      return text.length <= width ? text : text.slice(0, Math.max(0, width - marker.length)) + marker;
    }
    export function wrapTextWithAnsi(value, width) {
      const text = String(value);
      if (!text) return [""];
      const rows = [];
      for (let index = 0; index < text.length; index += Math.max(1, width)) rows.push(text.slice(index, index + Math.max(1, width)));
      return rows;
    }
  `],
]);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (stubModules.has(specifier)) return { url: `stub:${specifier}`, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith("stub:")) return { format: "module", source: stubModules.get(url.slice("stub:".length)), shortCircuit: true };
    return nextLoad(url, context);
  },
});

const { applyPatch, computeApplyPatchPreview } = await import("./apply-patch.ts");
const { renderApplyPatchCall, renderApplyPatchResult } = await import("./apply-patch-renderer.ts");
const { createApplyPatchToolDefinition } = await import("./apply-patch-tool.ts");
const { parseApplyPatch } = await import("./apply-patch-parser.ts");
const { isGptLikeModel, registerApplyPatchVisibility, syncApplyPatchVisibility } = await import("./model-gating.ts");
const { WORKSPACE_ACCESS_QUERY_V1, WORKSPACE_ACCESS_QUERY_V2 } = await import("./workspace-files.ts");

function tempDir() {
  return mkdtempSync(join(tmpdir(), "codex-tools-apply-patch-"));
}

function patch(body) {
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

test("parser handles add/update/delete/move actions and rejects malformed envelopes", () => {
  const parsed = parseApplyPatch(patch(`*** Add File: a.txt\n+hello\n*** Update File: b.txt\n*** Move to: c.txt\n@@\n-old\n+new\n*** Delete File: d.txt`));
  assert.deepEqual(parsed.actions.map((action) => [action.kind, action.path, action.moveTo]), [
    ["add", "a.txt", undefined],
    ["update", "b.txt", "c.txt"],
    ["delete", "d.txt", undefined],
  ]);
  assert.throws(() => parseApplyPatch("*** Begin Patch\n*** Add File: x\n+bad"), /must end/);
  assert.throws(() => parseApplyPatch(patch("*** Add File: x\nnot-added")), /must start with '\+'/);
  assert.throws(() => parseApplyPatch(patch("*** Add File: empty.txt\n@@ section only")), /must not use.*hunk|only.*'\+'/i);
  assert.throws(() => parseApplyPatch(patch("*** Add File: x\n@@\n+bad")), /must not use.*hunk|only.*'\+'/i);
  assert.throws(
    () => parseApplyPatch(patch("*** Update File: old.txt\n@@\n-old\n+new\n*** Move to: new.txt")),
    /Move to.*before.*hunk/i,
  );
  assert.throws(() => parseApplyPatch(`${patch("*** Add File: x\n+x")}\ntrailing`), /after/);
  assert.throws(() => parseApplyPatch(patch("*** Delete File: x\n@@\n-old")), /must not include hunks/);
  assert.throws(() => parseApplyPatch(patch("*** Update File: x\n@@\n-old\n+new\n\\ No newline at end of file")), /does not support the no-newline marker/);
});

test("parser retains section and EOF hunk metadata and validates EOF markers", () => {
  const parsed = parseApplyPatch(patch(`*** Update File: x.txt
@@ function foo  
-old
+new
@@
-last
+final
*** End of File`));
  assert.equal(parsed.actions[0].hunks[0].section, "function foo  ");
  assert.equal(parsed.actions[0].hunks[0].endOfFile, undefined);
  assert.equal(parsed.actions[0].hunks[1].section, undefined);
  assert.equal(parsed.actions[0].hunks[1].endOfFile, true);
  const indented = parseApplyPatch(patch("*** Update File: x.txt\n@@   indented anchor\n-old\n+new"));
  assert.equal(indented.actions[0].hunks[0].section, "  indented anchor");
  const nested = parseApplyPatch(patch("*** Update File: x.txt\n@@ class BaseClass\n@@ \tdef method():\n-old\n+new"));
  assert.deepEqual(nested.actions[0].hunks.map((hunk) => ({ section: hunk.section, lines: hunk.lines })), [
    { section: "class BaseClass", lines: [] },
    { section: "\tdef method():", lines: ["-old", "+new"] },
  ]);

  assert.throws(() => parseApplyPatch(patch("*** Add File: x.txt\n*** End of File")), /only.*update|patch line/i);
  assert.throws(() => parseApplyPatch(patch("*** Update File: x.txt\n*** End of File")), /hunk|patch line/i);
  assert.throws(() => parseApplyPatch(patch("*** Update File: x.txt\n@@\n-old\n+new\n*** End of File\n+later")), /file header|End Patch/i);
  assert.throws(() => parseApplyPatch(patch("*** Update File: x.txt\n@@\n-old\n+new\n*** End of File\n*** End of File")), /file header|End Patch/i);
});

test("section anchors select repeated blocks and missing sections leave files unchanged", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "sections.txt");
  writeFileSync(path, "function first\nsame\nfunction second\nsame\n");

  await applyPatch(patch(`*** Update File: sections.txt
@@ function second
-same
+changed`), { cwd });
  assert.equal(readFileSync(path, "utf8"), "function first\nsame\nfunction second\nchanged\n");

  const before = readFileSync(path);
  await assert.rejects(
    () => applyPatch(patch(`*** Update File: sections.txt
@@ function missing
-same
+nope`), { cwd }),
    (error) => {
      assert.match(error.message, /section.*not found/i);
      assert.match(error.message, /No files were changed/);
      return true;
    },
  );
  assert.deepEqual(readFileSync(path), before);

  const indentedPath = join(cwd, "indented-section.txt");
  writeFileSync(indentedPath, "header\n  anchor\nold\n");
  await applyPatch(patch(`*** Update File: indented-section.txt
@@   anchor
-old
+new`), { cwd });
  assert.equal(readFileSync(indentedPath, "utf8"), "header\n  anchor\nnew\n");

  const repeatedPath = join(cwd, "repeated-sections.txt");
  writeFileSync(repeatedPath, "one\nanchor\nthree\nanchor\nfive\n");
  await assert.rejects(
    () => applyPatch(patch(`*** Update File: repeated-sections.txt
@@ anchor
+inserted`), { cwd }),
    /Found 2 occurrences of section.*must be unique/i,
  );
  assert.equal(readFileSync(repeatedPath, "utf8"), "one\nanchor\nthree\nanchor\nfive\n");
});

test("multiple section headers navigate nested repeated contexts", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "nested-sections.py");
  writeFileSync(path, "class First\n  def method():\n    old\nclass BaseClass\n  def method():\n    old\n");

  const result = await applyPatch(patch(`*** Update File: nested-sections.py
@@ class BaseClass
@@   def method():
-    old
+    new`), { cwd });
  assert.equal(readFileSync(path, "utf8"), "class First\n  def method():\n    old\nclass BaseClass\n  def method():\n    new\n");
  assert.deepEqual(result.noops, []);
  assert.deepEqual(result.changedFiles, ["nested-sections.py"]);
});

test("update hunks advance monotonically through repeated patterns", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "sequential-repeated.txt");
  writeFileSync(path, "start\nrepeat\none\nrepeat\ntwo\n");

  await applyPatch(patch(`*** Update File: sequential-repeated.txt
@@
-start
+intro
 repeat
 one
@@
-repeat
+changed`), { cwd });
  assert.equal(readFileSync(path, "utf8"), "intro\nrepeat\none\nchanged\ntwo\n");
});

test("matching tolerates whitespace in tiers while preserving context bytes", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));

  const trailingPath = join(cwd, "trailing-space.txt");
  writeFileSync(trailingPath, "before  \nold\t \nafter  \n");
  await applyPatch(patch(`*** Update File: trailing-space.txt
@@
 before
-old
+new
 after`), { cwd });
  assert.equal(readFileSync(trailingPath, "utf8"), "before  \nnew\nafter  \n");

  const sectionPath = join(cwd, "section-whitespace.txt");
  writeFileSync(sectionPath, "class Base  \n\told\n\tcontext\n");
  await applyPatch(patch(`*** Update File: section-whitespace.txt
@@ class Base
-old
+\tnew
 context`), { cwd });
  assert.equal(readFileSync(sectionPath, "utf8"), "class Base  \n\tnew\n\tcontext\n");

  const exactPath = join(cwd, "exact-first.txt");
  writeFileSync(exactPath, "same\nsame  \n");
  await applyPatch(patch("*** Update File: exact-first.txt\n@@\n-same\n+changed"), { cwd });
  assert.equal(readFileSync(exactPath, "utf8"), "changed\nsame  \n");

  const ambiguousPath = join(cwd, "whitespace-ambiguous.txt");
  writeFileSync(ambiguousPath, "same \nsame\t\n");
  await assert.rejects(
    () => applyPatch(patch("*** Update File: whitespace-ambiguous.txt\n@@\n-same\n+changed"), { cwd }),
    (error) => {
      assert.match(error.message, /Found 2 occurrences/);
      assert.match(error.message, /ignoring trailing whitespace/);
      return true;
    },
  );
});

test("tolerant explicit replacements are not misclassified as no-ops", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "normalize-explicit.txt");
  writeFileSync(path, "old  \n");

  const result = await applyPatch(patch("*** Update File: normalize-explicit.txt\n@@\n-old\n+old"), { cwd });

  assert.equal(readFileSync(path, "utf8"), "old\n");
  assert.deepEqual(result.noops, []);
  assert.deepEqual(result.changedFiles, ["normalize-explicit.txt"]);
});

test("EOF hunks select the last repeated block and reject non-EOF matches unchanged", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "eof.txt");
  writeFileSync(path, "same\nmiddle\nsame\n");

  await applyPatch(patch(`*** Update File: eof.txt
@@
-same
+last
*** End of File`), { cwd });
  assert.equal(readFileSync(path, "utf8"), "same\nmiddle\nlast\n");

  writeFileSync(path, "same\nmiddle\nsame\ntrailer\n");
  const before = readFileSync(path);
  await assert.rejects(
    () => applyPatch(patch(`*** Update File: eof.txt
@@
-same
+last
*** End of File`), { cwd }),
    (error) => {
      assert.match(error.message, /EOF|end of file/i);
      assert.match(error.message, /No files were changed/);
      return true;
    },
  );
  assert.deepEqual(readFileSync(path), before);
});

test("section plus-only inserts after its anchor while bare plus-only appends", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const sectionPath = join(cwd, "section-insert.txt");
  const barePath = join(cwd, "bare-insert.txt");
  writeFileSync(sectionPath, "one\nanchor\nthree\n");
  writeFileSync(barePath, "one\nanchor\nthree\n");

  await applyPatch(patch(`*** Update File: section-insert.txt
@@ anchor
+inserted`), { cwd });
  await applyPatch(patch(`*** Update File: bare-insert.txt
@@
+appended`), { cwd });
  assert.equal(readFileSync(sectionPath, "utf8"), "one\nanchor\ninserted\nthree\n");
  assert.equal(readFileSync(barePath, "utf8"), "one\nanchor\nthree\nappended\n");
});

test("section and EOF matching preserve BOM and CRLF", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "section-eof-crlf.txt");
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  writeFileSync(path, Buffer.concat([bom, Buffer.from("anchor\r\nold\r\nsame\r\n", "utf8")]));

  await applyPatch(patch(`*** Update File: section-eof-crlf.txt
@@ anchor
-old
+new
@@
-same
+last
*** End of File`), { cwd });
  assert.deepEqual(readFileSync(path), Buffer.concat([bom, Buffer.from("anchor\r\nnew\r\nlast\r\n", "utf8")]));
});

test("applies add/update/delete/move actions transactionally", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "update.txt"), "alpha\nold\nomega");
  writeFileSync(join(cwd, "delete.txt"), "remove");
  const result = await applyPatch(patch(`*** Add File: nested/added.txt\n+hello\n+world\n*** Update File: update.txt\n@@\n alpha\n-old\n+new\n omega\n*** Delete File: delete.txt\n*** Update File: update.txt\n*** Move to: moved.txt\n@@\n alpha\n-new\n+newer\n omega`), { cwd });
  assert.equal(readFileSync(join(cwd, "nested/added.txt"), "utf8"), "hello\nworld\n");
  assert.equal(readFileSync(join(cwd, "moved.txt"), "utf8"), "alpha\nnewer\nomega");
  assert.equal(existsSync(join(cwd, "update.txt")), false);
  assert.equal(existsSync(join(cwd, "delete.txt")), false);
  assert.equal(result.files.length, 4);
  assert.ok(result.changedFiles.includes("moved.txt"));
  assert.equal(typeof result.diff, "string");
  assert.equal(typeof result.patch, "string");
});

test("delete then add performs a real replacement even when bytes are unchanged", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "replace.txt");
  writeFileSync(path, "same\n");
  chmodSync(path, 0o700);
  const operations = [];

  const result = await applyPatch(patch("*** Delete File: replace.txt\n*** Add File: replace.txt\n+same"), {
    cwd,
    afterMutation(_path, operation) { operations.push(operation); },
  });

  assert.equal(readFileSync(path, "utf8"), "same\n");
  assert.equal(statSync(path).mode & 0o111, 0);
  assert.deepEqual(operations, ["delete", "add"]);
  assert.deepEqual(result.changedFiles, ["replace.txt"]);
});

test("preserves CRLF when the patch uses LF", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "crlf.txt"), "alpha\r\nold\r\nomega\r\n");
  await applyPatch(patch(`*** Update File: crlf.txt\n@@\n alpha\n-old\n+new\n omega`), { cwd });
  assert.equal(readFileSync(join(cwd, "crlf.txt"), "utf8"), "alpha\r\nnew\r\nomega\r\n");
});

test("preserves a UTF-8 BOM while matching the first logical line", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const lfPath = join(cwd, "bom-lf.txt");
  const crlfPath = join(cwd, "bom-crlf.txt");
  writeFileSync(lfPath, Buffer.concat([bom, Buffer.from("alpha\nold\n", "utf8")]));
  writeFileSync(crlfPath, Buffer.concat([bom, Buffer.from("alpha\r\nold\r\n", "utf8")]));

  await applyPatch(patch(`*** Update File: bom-lf.txt\n@@\n-alpha\n+beta\n old`), { cwd });
  await applyPatch(patch(`*** Update File: bom-crlf.txt\n@@\n-alpha\n+beta\n old`), { cwd });

  assert.deepEqual(readFileSync(lfPath), Buffer.concat([bom, Buffer.from("beta\nold\n", "utf8")]));
  assert.deepEqual(readFileSync(crlfPath), Buffer.concat([bom, Buffer.from("beta\r\nold\r\n", "utf8")]));
});

test("rejects existing invalid UTF-8 before planning or mutation", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "invalid.txt");
  const bytes = Buffer.from([0xc3, 0x28, 0x00, 0xff]);
  writeFileSync(path, bytes);

  const input = patch(`*** Update File: invalid.txt
@@
-ignored
+changed`);
  const preview = await computeApplyPatchPreview(input, { cwd });
  assert.match(preview.error, /invalid UTF-8/i);
  await assert.rejects(() => applyPatch(input, { cwd }), /invalid UTF-8/i);
  assert.deepEqual(readFileSync(path), bytes);
});

test("rejects mixed and CR-only line endings before mutation", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const mixedPath = join(cwd, "mixed.txt");
  const crOnlyPath = join(cwd, "cr-only.txt");
  const mixedBytes = Buffer.from("one\r\ntwo\n", "utf8");
  const crOnlyBytes = Buffer.from("one\rtwo", "utf8");
  writeFileSync(mixedPath, mixedBytes);
  writeFileSync(crOnlyPath, crOnlyBytes);

  const mixedInput = patch(`*** Update File: mixed.txt
@@
-one
+changed`);
  const crOnlyInput = patch(`*** Update File: cr-only.txt
@@
-one
+changed`);
  const mixedPreview = await computeApplyPatchPreview(mixedInput, { cwd });
  assert.match(mixedPreview.error, /mixed.*line ending/i);
  await assert.rejects(() => applyPatch(mixedInput, { cwd }), /mixed.*line ending/i);
  const crOnlyPreview = await computeApplyPatchPreview(crOnlyInput, { cwd });
  assert.match(crOnlyPreview.error, /CR-only.*line ending/i);
  await assert.rejects(() => applyPatch(crOnlyInput, { cwd }), /CR-only.*line ending/i);
  assert.deepEqual(readFileSync(mixedPath), mixedBytes);
  assert.deepEqual(readFileSync(crOnlyPath), crOnlyBytes);
});

test("matches blank logical lines and appends with a missing separator safely", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const blankPath = join(cwd, "blank.txt");
  const noTrailingPath = join(cwd, "append-no-trailing.txt");
  const trailingPath = join(cwd, "append-trailing.txt");
  writeFileSync(blankPath, Buffer.from("before\n\nafter", "utf8"));
  writeFileSync(noTrailingPath, Buffer.from("alpha", "utf8"));
  writeFileSync(trailingPath, Buffer.from("alpha\n", "utf8"));

  await applyPatch(patch(`*** Update File: blank.txt
@@
-
+filled`), { cwd });
  await applyPatch(patch(`*** Update File: append-no-trailing.txt
@@
+beta`), { cwd });
  await applyPatch(patch(`*** Update File: append-trailing.txt
@@
+beta`), { cwd });

  assert.deepEqual(readFileSync(blankPath), Buffer.from("before\nfilled\nafter", "utf8"));
  assert.deepEqual(readFileSync(noTrailingPath), Buffer.from("alpha\nbeta", "utf8"));
  assert.deepEqual(readFileSync(trailingPath), Buffer.from("alpha\nbeta\n", "utf8"));
});

test("rejects ambiguity, traversal, symlink escape, existing add/move destinations, and missing delete", async (t) => {
  const cwd = tempDir();
  const outside = tempDir();
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
  writeFileSync(join(cwd, "ambiguous.txt"), "same\nsame\n");
  writeFileSync(join(cwd, "source.txt"), "source");
  writeFileSync(join(cwd, "destination.txt"), "existing");
  writeFileSync(join(cwd, "substring.txt"), "prefixold\n");
  symlinkSync(outside, join(cwd, "link"), "dir");
  symlinkSync(".", join(cwd, "alias"), "dir");
  await assert.rejects(() => applyPatch(patch("*** Update File: ambiguous.txt\n@@\n-same\n+different"), { cwd }), /ambiguous/);
  await assert.rejects(() => applyPatch(patch("*** Update File: substring.txt\n@@\n-old\n+new"), { cwd }), /not found/);
  assert.equal(readFileSync(join(cwd, "substring.txt"), "utf8"), "prefixold\n");
  await assert.rejects(() => applyPatch(patch("*** Add File: ../escape.txt\n+nope"), { cwd }), /escapes cwd/);
  await assert.rejects(
    () => applyPatch(patch("*** Add File: safe.txt\n+safe\n*** Add File: ../escape.txt\n+nope"), { cwd }),
    (error) => error.message === "Rejected actions[1] path (../escape.txt): Patch path escapes cwd: ../escape.txt\nNo files were changed.",
  );
  assert.equal(existsSync(join(cwd, "safe.txt")), false);
  await assert.rejects(() => applyPatch(patch("*** Add File: link/escape.txt\n+nope"), { cwd }), /symlink/);
  await assert.rejects(() => applyPatch(patch("*** Add File: alias/new.txt\n+nope"), { cwd }), /symlink/);
  await assert.rejects(() => applyPatch(patch("*** Add File: destination.txt\n+nope"), { cwd }), /already exists/);
  await assert.rejects(() => applyPatch(patch("*** Update File: source.txt\n*** Move to: destination.txt\n@@\n-source\n+new"), { cwd }), /destination already exists/);
  await assert.rejects(
    () => applyPatch(patch("*** Update File: source.txt\n*** Move to: source.txt/nested.txt\n@@\n-source\n+new"), { cwd }),
    /destination cannot be inside the source path/,
  );
  assert.equal(readFileSync(join(cwd, "source.txt"), "utf8"), "source");
  await assert.rejects(
    () => applyPatch(patch("*** Delete File: missing.txt"), { cwd }),
    (error) => error.message === "Cannot delete actions[0] (missing.txt): path does not exist.\nNo files were changed.",
  );
  assert.equal(lstatSync(join(cwd, "link")).isSymbolicLink(), true);
});

test("uses patch paths literally, rejects absolute paths, and refuses hard-linked files", async (t) => {
  const cwd = tempDir();
  const outside = tempDir();
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  mkdirSync(join(cwd, "@scope"));
  mkdirSync(join(cwd, "scope"));
  writeFileSync(join(cwd, "@scope", "file.ts"), "old\n");
  writeFileSync(join(cwd, "scope", "file.ts"), "untouched\n");
  await applyPatch(patch("*** Update File: @scope/file.ts\n@@\n-old\n+new"), { cwd });
  assert.equal(readFileSync(join(cwd, "@scope", "file.ts"), "utf8"), "new\n");
  assert.equal(readFileSync(join(cwd, "scope", "file.ts"), "utf8"), "untouched\n");

  const quotedPath = join(cwd, '"quoted.txt"');
  writeFileSync(quotedPath, "old\n");
  await applyPatch(patch('*** Update File: "quoted.txt"\n@@\n-old\n+new'), { cwd });
  assert.equal(readFileSync(quotedPath, "utf8"), "new\n");
  assert.equal(existsSync(join(cwd, "quoted.txt")), false);

  const absolutePath = join(cwd, "absolute.txt");
  writeFileSync(absolutePath, "old\n");
  await assert.rejects(
    () => applyPatch(patch(`*** Update File: ${absolutePath}\n@@\n-old\n+new`), { cwd }),
    /absolute paths are not allowed/i,
  );
  assert.equal(readFileSync(absolutePath, "utf8"), "old\n");

  const outsidePath = join(outside, "shared.txt");
  const insidePath = join(cwd, "shared.txt");
  writeFileSync(outsidePath, "old\n");
  linkSync(outsidePath, insidePath);
  const hardLinkInput = patch("*** Update File: shared.txt\n@@\n-old\n+new");
  const preview = await computeApplyPatchPreview(hardLinkInput, { cwd });
  assert.match(preview.error, /hard-linked file/i);
  await assert.rejects(() => applyPatch(hardLinkInput, { cwd }), /hard-linked file/i);
  assert.equal(readFileSync(outsidePath, "utf8"), "old\n");
  assert.equal(readFileSync(insidePath, "utf8"), "old\n");
});

test("rolls back all touched paths and honors abort", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => applyPatch(patch("*** Add File: aborted.txt\n+nope"), { cwd, signal: controller.signal }), /aborted/);
  writeFileSync(join(cwd, "z-parent"), "not a directory");
  await assert.rejects(() => applyPatch(patch("*** Add File: nested/ok.txt\n+ok\n*** Add File: z-parent/child.txt\n+fail"), { cwd }), /Rolled back all touched files/);
  assert.equal(existsSync(join(cwd, "nested/ok.txt")), false);
  assert.equal(existsSync(join(cwd, "nested")), false);
});

test("rollback restores original file permissions", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const protectedPath = join(cwd, "protected.txt");
  writeFileSync(protectedPath, "secret");
  chmodSync(protectedPath, 0o600);
  writeFileSync(join(cwd, "z-parent"), "not a directory");
  await assert.rejects(() => applyPatch(patch("*** Delete File: protected.txt\n*** Add File: z-parent/child.txt\n+fail"), { cwd }), /Rolled back all touched files/);
  assert.equal(readFileSync(protectedPath, "utf8"), "secret");
  assert.equal(statSync(protectedPath).mode & 0o777, 0o600);
});

test("rollback restores a normal update by its post-restore identity", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const bom = Buffer.from([0xef, 0xbb, 0xbf]);
  const firstPath = join(cwd, "first.txt");
  const original = Buffer.concat([bom, Buffer.from("old\n", "utf8")]);
  writeFileSync(firstPath, original);
  chmodSync(firstPath, 0o640);
  writeFileSync(join(cwd, "z-parent"), "not a directory");

  await assert.rejects(
    () => applyPatch(patch("*** Update File: first.txt\n@@\n-old\n+new\n*** Add File: z-parent/child.txt\n+fail"), { cwd }),
    (error) => {
      assert.match(error.message, /Rolled back all touched files/);
      assert.doesNotMatch(error.message, /rollback conflict/i);
      return true;
    },
  );
  assert.deepEqual(readFileSync(firstPath), original);
  assert.equal(statSync(firstPath).mode & 0o777, 0o640);
});

test("does not claim rollback after a post-mutation verification failure", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "indeterminate.txt");
  const input = patch("*** Add File: indeterminate.txt\n+owned");

  await assert.rejects(
    () => applyPatch(input, {
      cwd,
      afterMutation: (mutationPath, operation) => {
        if (mutationPath.endsWith("/indeterminate.txt") && operation === "add") writeFileSync(path, "external");
      },
    }),
    (error) => {
      assert.match(error.message, /post-mutation verification/i);
      assert.match(error.message, /rollback conflict/i);
      assert.doesNotMatch(error.message, /Rolled back all touched files\./);
      return true;
    },
  );
  assert.equal(readFileSync(path, "utf8"), "external");
});

test("update errors identify action and hunk indexes with exact complete-line guidance", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "target.txt"), "same\nsame\n");
  writeFileSync(join(cwd, "first.txt"), "present\n");
  await assert.rejects(
    () => applyPatch(patch("*** Update File: first.txt\n@@\n-missing\n+new\n*** Update File: target.txt\n@@\n-same\n+new"), { cwd }),
    (error) => {
      assert.match(error.message, /actions\[0\]\.hunks\[0\]/);
      assert.match(error.message, /first\.txt/);
      assert.match(error.message, /hunk not found/);
      assert.match(error.message, /exact and whitespace-tolerant/);
      assert.match(error.message, /complete lines/);
      return true;
    },
  );
  await assert.rejects(
    () => applyPatch(patch("*** Update File: target.txt\n@@\n-same\n+new"), { cwd }),
    (error) => {
      assert.match(error.message, /actions\[0\]\.hunks\[0\]/);
      assert.match(error.message, /target\.txt/);
      assert.match(error.message, /Found 2 occurrences/);
      assert.match(error.message, /3 complete lines immediately above and 3 complete lines immediately below/);
      assert.match(error.message, /@@.*class.*function.*method.*test/i);
      assert.match(error.message, /Current source candidates/);
      assert.match(error.message, /Candidate 1: matched lines 1-1/);
      assert.match(error.message, />\s+1 \| same/);
      assert.match(error.message, /Candidate 2: matched lines 2-2/);
      return true;
    },
  );

  writeFileSync(join(cwd, "tests.ts"), "test('one', () => {\n});\ntest('two', () => {\n});\n");
  await assert.rejects(
    () => applyPatch(patch("*** Update File: tests.ts\n@@\n });\n+\n+test('three', () => {});"), { cwd }),
    (error) => {
      assert.match(error.message, /repeated closing line [`\"]?\}\);[`\"]?/i);
      assert.match(error.message, /do not retry with that line alone/i);
      return true;
    },
  );
});

test("unique identical hunks are successful no-ops without writing", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "same.txt");
  writeFileSync(path, "same\n");
  const before = lstatSync(path);
  const input = patch("*** Update File: same.txt\n@@\n same");

  const result = await applyPatch(input, { cwd });
  const after = lstatSync(path);
  assert.deepEqual(result.changedFiles, []);
  assert.equal(result.diff, "");
  assert.equal(result.patch, "");
  assert.deepEqual(result.noops, [{ path: "same.txt", actionIndex: 0, hunkIndex: 0, startLine: 1, endLine: 1, reason: "already_satisfied" }]);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeNs, before.mtimeNs);
  assert.match(result.summary, /Patch already satisfied: 1 hunk required no change\./);

  const preview = await computeApplyPatchPreview(input, { cwd });
  assert.deepEqual(preview.files, []);
  assert.equal(preview.diff, "");
  assert.equal(preview.patch, "");
  assert.deepEqual(preview.noops, result.noops);
});

test("all-noop tool execution and rendering report already-satisfied success", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "same.txt"), "same\n");
  const input = patch("*** Update File: same.txt\n@@\n same");
  const tool = createApplyPatchToolDefinition();
  const result = await tool.execute("call-noop", { input }, undefined, undefined, { cwd });

  assert.equal("isError" in result, false);
  assert.match(result.content[0].text, /already satisfied/i);
  assert.match(result.content[0].text, /Files changed: none/);
  assert.equal(result.details.changedFiles.length, 0);
  assert.equal(result.details.diff, "");
  assert.equal(result.details.noops.length, 1);

  const rendered = render(renderApplyPatchResult(result, { expanded: false, isPartial: false }, theme, { isError: false }));
  assert.match(rendered, /already satisfied/i);
  assert.doesNotMatch(rendered, /0 files applied/i);
});

test("identical hunks can precede real changes, and advance the cursor", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "mixed.txt");
  writeFileSync(path, "old\nsame\nold\n");
  const result = await applyPatch(patch(`*** Update File: mixed.txt
@@
 same
@@
-old
+new`), { cwd });
  assert.equal(readFileSync(path, "utf8"), "old\nsame\nnew\n");
  assert.equal(result.noops.length, 1);
  assert.deepEqual(result.changedFiles, ["mixed.txt"]);

  const fallback = render(renderApplyPatchResult({ details: result }, { expanded: false, isPartial: false }, theme, { isError: false }));
  assert.match(fallback, /1 hunk already satisfied/i);

  const state = {};
  const args = { input: patch(`*** Update File: mixed.txt
@@
 same
@@
-new
+newer`) };
  renderApplyPatchCall(args, theme, { cwd, argsComplete: false, invalidate() {}, state });
  renderApplyPatchResult({ details: result }, { expanded: false, isPartial: false }, theme, { isError: false, args, cwd, state });
  assert.match(render(state.callComponent), /1 hunk already satisfied/i);
});

test("ambiguous and missing identical hunks still fail before mutation", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "ambiguous-same.txt"), "same\nsame\n");
  await assert.rejects(
    () => applyPatch(patch("*** Update File: ambiguous-same.txt\n@@\n same"), { cwd }),
    (error) => {
      assert.match(error.message, /Found 2 occurrences/);
      assert.match(error.message, /Current source candidates/);
      assert.doesNotMatch(error.message, /already satisfied/);
      return true;
    },
  );

  const missingPath = join(cwd, "missing-same.txt");
  writeFileSync(missingPath, "other\n");
  await assert.rejects(
    () => applyPatch(patch("*** Update File: missing-same.txt\n@@\n-missing\n+missing"), { cwd }),
    /hunk not found/,
  );
});

test("identical update hunks plus moves still move the file", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "source.txt"), "same\n");
  const result = await applyPatch(patch("*** Update File: source.txt\n*** Move to: moved.txt\n@@\n same"), { cwd });
  assert.equal(existsSync(join(cwd, "source.txt")), false);
  assert.equal(readFileSync(join(cwd, "moved.txt"), "utf8"), "same\n");
  assert.equal(result.noops.length, 1);
  assert.deepEqual(result.changedFiles.sort(), ["moved.txt", "source.txt"]);
});

test("non-no-op cycles that net to the original content still fail", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "cycle.txt");
  writeFileSync(path, "one\n");
  await assert.rejects(
    () => applyPatch(patch("*** Update File: cycle.txt\n@@\n-one\n+two\n*** Update File: cycle.txt\n@@\n-two\n+one"), { cwd }),
    /Patch made no filesystem changes/,
  );
  assert.equal(readFileSync(path, "utf8"), "one\n");
});

test("retry diagnostics use current virtual content and remain bounded", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "sequential.txt"), "before\nold\nrepeat\nrepeat\nafter\n");
  await assert.rejects(
    () => applyPatch(patch("*** Update File: sequential.txt\n@@\n+inserted\n before\n@@\n-repeat\n+changed"), { cwd }),
    (error) => {
      assert.match(error.message, /Found 2 occurrences/);
      assert.match(error.message, /2 \| before/);
      assert.match(error.message, /4 \| repeat/);
      assert.match(error.message, /5 \| repeat/);
      return true;
    },
  );

  writeFileSync(join(cwd, "many.txt"), Array.from({ length: 100 }, () => "same").join("\n"));
  await assert.rejects(
    () => applyPatch(patch("*** Update File: many.txt\n@@\n-same\n+different"), { cwd }),
    (error) => {
      assert.match(error.message, /Found 100 occurrences/);
      assert.match(error.message, /97 more candidates omitted/);
      assert.ok(error.message.length <= 8_500, `diagnostic too large: ${error.message.length}`);
      return true;
    },
  );

  const longLine = "x".repeat(300);
  const longBlock = Array.from({ length: 30 }, () => longLine).join("\n");
  writeFileSync(join(cwd, "long-many.txt"), Array.from({ length: 4 }, () => longBlock).join("\n"));
  await assert.rejects(
    () => applyPatch(patch(`*** Update File: long-many.txt\n@@\n${longBlock.split("\n").map((line) => `-${line}`).join("\n")}\n+different`), { cwd }),
    (error) => {
      assert.match(error.message, /source context truncated by character limit/);
      assert.match(error.message, /more candidates omitted/);
      assert.ok(error.message.length <= 8_500, `diagnostic too large: ${error.message.length}`);
      return true;
    },
  );

  writeFileSync(join(cwd, "crlf-ambiguous.txt"), "same\r\nsame\r\n");
  await assert.rejects(
    () => applyPatch(patch("*** Update File: crlf-ambiguous.txt\n@@\n-same\n+different"), { cwd }),
    (error) => {
      assert.doesNotMatch(error.message, /\r/);
      assert.match(error.message, /matched lines 1-1/);
      assert.match(error.message, /matched lines 2-2/);
      return true;
    },
  );
});

test("escapes terminal controls in retry diagnostics without changing matching", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "controls.txt");
  const sourceLine = "\x1b]0;title\x07";
  writeFileSync(path, `${sourceLine}\n${sourceLine}\n`);
  const input = patch(`*** Update File: controls.txt
@@
-${sourceLine}
+changed`);

  await assert.rejects(() => applyPatch(input, { cwd }), (error) => {
    assert.match(error.message, /Found 2 occurrences/);
    assert.match(error.message, /\\x1B/);
    assert.match(error.message, /\\x07/);
    assert.equal(error.message.includes("\x1b"), false);
    assert.equal(readFileSync(path, "utf8"), `${sourceLine}\n${sourceLine}\n`);
    return true;
  });
});

test("normalizes filesystem errors and abort wording", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const missingCwd = join(cwd, "missing-cwd");
  await assert.rejects(
    () => applyPatch(patch("*** Add File: created.txt\n+hello"), { cwd: missingCwd }),
    (error) => {
      assert.match(error.message, /Could not resolve cwd/);
      assert.match(error.message, /missing-cwd/);
      assert.match(error.message, /ENOENT/);
      return true;
    },
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => applyPatch(patch("*** Add File: aborted.txt\n+nope"), { cwd, signal: controller.signal }), /Operation aborted\./);
});

test("preview is read-only, and live execution revalidates stale files", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const input = patch("*** Update File: preview.txt\n@@\n-old\n+new");
  const path = join(cwd, "preview.txt");
  writeFileSync(path, "old");
  const preview = await computeApplyPatchPreview(input, { cwd });
  assert.deepEqual(preview.files, ["preview.txt"]);
  assert.match(preview.diff, /old/);
  assert.match(preview.diff, /new/);
  assert.equal(readFileSync(path, "utf8"), "old");

  writeFileSync(path, "changed");
  await assert.rejects(() => applyPatch(input, { cwd }), /actions\[0\]\.hunks\[0\].*hunk not found/);
  assert.equal(readFileSync(path, "utf8"), "changed");
  const errorPreview = await computeApplyPatchPreview(input, { cwd });
  assert.match(errorPreview.error, /actions\[0\]\.hunks\[0\]/);
  assert.doesNotMatch(errorPreview.error, /Current source/, "not-found errors do not invent match context");
});

test("rechecks the live path immediately before mutation", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const path = join(cwd, "race.txt");
  writeFileSync(path, "old");
  const input = patch("*** Update File: race.txt\n@@\n-old\n+new");
  let raced = false;
  await assert.rejects(
    () => applyPatch(input, {
      cwd,
      beforeMutation: (mutationPath) => {
        if (!raced && mutationPath.endsWith("/race.txt")) {
          raced = true;
          writeFileSync(path, "external");
        }
      },
    }),
    /concurrent change/i,
  );
  assert.equal(readFileSync(path, "utf8"), "external");
});

test("does not overwrite an externally changed path during rollback", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const aPath = join(cwd, "a.txt");
  const bPath = join(cwd, "b.txt");
  writeFileSync(aPath, "a-old");
  writeFileSync(bPath, "b-old");
  const input = patch(`*** Update File: a.txt
@@
-a-old
+a-new
*** Update File: b.txt
@@
-b-old
+b-new`);
  let raced = false;
  await assert.rejects(
    () => applyPatch(input, {
      cwd,
      beforeMutation: (mutationPath) => {
        if (!raced && mutationPath.endsWith("/b.txt")) {
          raced = true;
          writeFileSync(aPath, "external-a");
          writeFileSync(bPath, "external-b");
        }
      },
    }),
    (error) => {
      assert.match(error.message, /concurrent change/i);
      assert.match(error.message, /rollback conflict/i);
      return true;
    },
  );
  assert.equal(readFileSync(aPath, "utf8"), "external-a");
  assert.equal(readFileSync(bPath, "utf8"), "external-b");
});

test("renderer previews asynchronously and suppresses duplicate final output", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const input = patch("*** Update File: rendered.txt\n@@\n-old\n+new");
  writeFileSync(join(cwd, "rendered.txt"), "old");
  const state = {};
  let invalidations = 0;
  const args = { input };
  const context = { cwd, argsComplete: true, invalidate: () => invalidations++, lastComponent: undefined, state, allowHostPreview: true };
  renderApplyPatchCall(args, theme, context);
  for (let attempt = 0; attempt < 50 && !state.callComponent?.preview; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(state.callComponent?.preview, "preview resolves asynchronously");
  const call = renderApplyPatchCall(args, theme, { ...context, lastComponent: state.callComponent, allowHostPreview: true });
  assert.match(render(call), /old/);
  assert.match(render(call), /new/);
  assert.ok(invalidations > 0);

  const details = { changedFiles: ["rendered.txt"], files: [{ path: "rendered.txt" }], diff: state.callComponent.preview.diff, patch: "" };
  const duplicate = renderApplyPatchResult({ details }, { expanded: false, isPartial: false }, theme, { ...context, args, lastComponent: call, isError: false });
  assert.equal(typeof duplicate.render, "function", "result component is renderable");
  assert.equal(duplicate.render(120).join(""), "", "identical final diff is not duplicated below the call");

  const final = renderApplyPatchResult({ details: { ...details, diff: "changed final" } }, { expanded: false, isPartial: false }, theme, { ...context, args, lastComponent: call, isError: false });
  assert.equal(final.render(120).join(""), "", "updated final diff remains in the call shell");
  assert.match(render(state.callComponent), /changed final/);
  const racingState = {};
  const racingContext = { cwd, argsComplete: true, invalidate: () => {}, lastComponent: undefined, state: racingState };
  renderApplyPatchCall(args, theme, racingContext);
  renderApplyPatchResult(
    { content: [{ type: "text", text: "authoritative apply failure" }] },
    { expanded: false, isPartial: false },
    theme,
    { ...racingContext, args, isError: true },
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(render(racingState.callComponent), /authoritative apply failure/);
  assert.doesNotMatch(render(racingState.callComponent), /old/, "late preview cannot overwrite the final error");
});

test("GPT/OpenAI/Codex gating preserves unrelated tools and explicit disablement", () => {
  assert.equal(isGptLikeModel({ provider: "openai", id: "gpt-5.6-sol" }), true);
  assert.equal(isGptLikeModel({ provider: "openrouter", id: "openai/gpt-4.1" }), true);
  assert.equal(isGptLikeModel({ provider: "local", id: "gpt-5" }), true);
  assert.equal(isGptLikeModel({ provider: "local", id: "gpt_5" }), true);
  assert.equal(isGptLikeModel({ provider: "local", id: "o3-mini" }), true);
  assert.equal(isGptLikeModel({ provider: "local", id: "codex-runner" }), true);
  assert.equal(isGptLikeModel({ provider: "opencode", id: "claude-opus-4-6" }), false);
  assert.equal(isGptLikeModel({ provider: "anthropic", id: "claude-4" }), false);
  assert.deepEqual(syncApplyPatchVisibility(["read", "apply_patch", "write"], { provider: "anthropic", id: "claude-4" }), { activeTools: ["read", "write"], state: { removedByGate: true, removedToolIndex: 1 } });
  assert.deepEqual(syncApplyPatchVisibility(["read", "write"], { provider: "openai", id: "gpt-5.6" }), { activeTools: ["read", "write"], state: { preference: undefined, removedByGate: false } });
  assert.deepEqual(syncApplyPatchVisibility(["read", "write"], { provider: "openai", id: "gpt-5.6" }, { preference: true, removedByGate: true }), { activeTools: ["read", "write", "apply_patch"], state: { preference: true, removedByGate: false } });
});

test("visibility round trips restore the original position without changing other tools", () => {
  const gpt = { id: "gpt-5.6" };
  const claude = { id: "claude" };
  for (const original of [
    ["apply_patch", "read", "write"],
    ["read", "apply_patch", "write"],
    ["read", "write", "apply_patch"],
    ["apply_patch"],
  ]) {
    let current = { activeTools: original, state: { removedByGate: false } };
    for (let attempt = 0; attempt < 3; attempt++) {
      current = syncApplyPatchVisibility(current.activeTools, claude, current.state);
      current = syncApplyPatchVisibility(current.activeTools, claude, current.state);
      current = syncApplyPatchVisibility(current.activeTools, gpt, current.state);
      assert.deepEqual(current.activeTools, original);
    }
    assert.deepEqual(original.filter((name) => name !== "apply_patch"), syncApplyPatchVisibility(original, claude).activeTools);
  }

  const hidden = syncApplyPatchVisibility(["read", "apply_patch", "write"], claude);
  assert.deepEqual(syncApplyPatchVisibility(["read", "write", "extra"], gpt, hidden.state).activeTools, ["read", "apply_patch", "write", "extra"]);
  assert.deepEqual(syncApplyPatchVisibility([], gpt, hidden.state).activeTools, ["apply_patch"], "saved position clamps to a shortened list");
  assert.deepEqual(syncApplyPatchVisibility(["read", "apply_patch", "write"], gpt, hidden.state).activeTools, ["read", "apply_patch", "write"], "already restored tools are not duplicated or moved");
});

test("visibility restores the saved position after extension reload while gated", async () => {
  let activeTools = ["read", "apply_patch", "write"];
  const ctx = { model: { id: "claude" }, sessionManager: { getSessionId: () => "order-reload" } };
  const load = () => {
    const handlers = new Map();
    registerApplyPatchVisibility({
      getActiveTools() { return activeTools; },
      setActiveTools(next) { activeTools = next; },
      on(event, handler) { handlers.set(event, handler); },
    });
    return handlers;
  };
  await load().get("session_start")({}, ctx);
  assert.deepEqual(activeTools, ["read", "write"]);
  const reloaded = load();
  await reloaded.get("session_start")({}, ctx);
  await reloaded.get("model_select")({ previousModel: ctx.model }, { ...ctx, model: { id: "gpt-5.6" } });
  assert.deepEqual(activeTools, ["read", "apply_patch", "write"]);
});

test("visibility lifecycle isolates state by session ID and blocks unsupported calls", async () => {
  let activeTools = ["read", "apply_patch", "write"];
  let sessionId = "session-a";
  const handlers = new Map();
  const context = (model) => ({ model, sessionManager: { getSessionId: () => sessionId } });
  const pi = {
    getActiveTools() { return activeTools; },
    setActiveTools(next) { activeTools = next; },
    on(event, handler) { handlers.set(event, handler); },
  };
  registerApplyPatchVisibility(pi);

  await handlers.get("session_start")({}, context({ provider: "anthropic", id: "claude" }));
  assert.deepEqual(activeTools, ["read", "write"]);
  await handlers.get("model_select")({}, context({ provider: "newapi", id: "gpt-5.6-sol" }));
  assert.deepEqual(activeTools, ["read", "apply_patch", "write"]);

  for (let attempt = 0; attempt < 3; attempt++) {
    await handlers.get("model_select")({ previousModel: { id: "gpt-5.6" } }, context({ id: "claude" }));
    await handlers.get("before_agent_start")({}, context({ id: "claude" }));
    await handlers.get("model_select")({ previousModel: { id: "claude" } }, context({ id: "gpt-5.6" }));
    assert.deepEqual(activeTools, ["read", "apply_patch", "write"]);
    await handlers.get("session_tree")({}, context({ id: "gpt-5.6" }));
    await handlers.get("before_agent_start")({}, context({ id: "gpt-5.6" }));
    assert.deepEqual(activeTools, ["read", "apply_patch", "write"], "branch navigation does not change restored order");
  }

  activeTools = ["read", "write"];
  await handlers.get("before_agent_start")({}, context({ provider: "newapi", id: "gpt-5.6-sol" }));
  assert.deepEqual(activeTools, ["read", "write"], "session A explicitly disables apply_patch");
  await handlers.get("model_select")({ previousModel: { provider: "newapi", id: "gpt-5.6-sol" } }, context({ provider: "anthropic", id: "claude" }));
  await handlers.get("model_select")({ previousModel: { provider: "anthropic", id: "claude" } }, context({ provider: "newapi", id: "gpt-5.6-sol" }));
  assert.deepEqual(activeTools, ["read", "write"], "session A preserves explicit disablement across model changes");
  await handlers.get("session_shutdown")({}, context({ provider: "newapi", id: "gpt-5.6-sol" }));

  sessionId = "session-b";
  activeTools = ["read", "apply_patch", "write"];
  await handlers.get("session_start")({}, context({ provider: "newapi", id: "gpt-5.6-sol" }));
  assert.deepEqual(activeTools, ["read", "apply_patch", "write"], "session A preference does not alter session B");

  activeTools = ["read", "write"];
  await handlers.get("before_agent_start")({}, context({ provider: "newapi", id: "gpt-5.6-sol" }));
  let reloadedActiveTools = ["read", "apply_patch", "write"];
  const reloadedHandlers = new Map();
  registerApplyPatchVisibility({
    getActiveTools() { return reloadedActiveTools; },
    setActiveTools(next) { reloadedActiveTools = next; },
    on(event, handler) { reloadedHandlers.set(event, handler); },
  });
  await reloadedHandlers.get("session_start")({}, context({ provider: "newapi", id: "gpt-5.6-sol" }));
  assert.deepEqual(reloadedActiveTools, ["read", "write"], "session B explicit disablement survives extension reload");
  reloadedActiveTools = ["read", "apply_patch", "write"];
  await reloadedHandlers.get("before_agent_start")({}, context({ provider: "newapi", id: "gpt-5.6-sol" }));
  assert.deepEqual(reloadedActiveTools, ["read", "apply_patch", "write"], "session B explicit re-enable survives the next turn");

  const blocked = await handlers.get("tool_call")({ toolName: "apply_patch" }, context({ provider: "anthropic", id: "claude" }));
  assert.equal(blocked.block, true);
  const allowed = await handlers.get("tool_call")({ toolName: "apply_patch" }, context({ provider: "newapi", id: "gpt-5.6-sol" }));
  assert.equal(allowed, undefined);
});

const theme = {
  bg(_name, value) { return value; },
  fg(_name, value) { return value; },
  bold(value) { return value; },
};

function render(component, width = 120) {
  return component.render(width).join("\n");
}

test("tool definition is strict, streams progress, and applies patches", async (t) => {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const tool = createApplyPatchToolDefinition();
  assert.equal(tool.name, "apply_patch");
  assert.equal(tool.description, "Use the `apply_patch` tool to edit files. Pass the complete patch payload in the `input` field.");
  assert.equal(tool.promptSnippet, "Use apply_patch to edit files with its stripped-down, file-oriented patch format.");
  assert.match(tool.promptGuidelines.join("\n"), /3 complete lines immediately above and 3 complete lines immediately below/);
  assert.match(tool.promptGuidelines.join("\n"), /multiple @@ section headers/);
  assert.match(tool.promptGuidelines.join("\n"), /literal relative file paths only/i);
  assert.match(tool.promptGuidelines.join("\n"), /Move to.*immediately after.*before all hunks/i);
  assert.match(tool.promptGuidelines.join("\n"), /Add File.*no @@ headers.*final newline/i);
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.parameters.required, ["input"]);
  assert.equal(tool.parameters.properties.input.minLength, 1);
  assert.match(tool.parameters.properties.input.description, /Complete apply_patch payload/);
  const updates = [];
  const result = await tool.execute("call-1", { input: patch("*** Add File: created.txt\n+hello") }, undefined, (update) => updates.push(update), { cwd });
  assert.equal(readFileSync(join(cwd, "created.txt"), "utf8"), "hello\n");
  assert.equal(updates.length, 1);
  assert.equal(updates[0].details.phase, "applying");
  assert.match(result.content[0].text, /Files changed: created\.txt/);
});

test("renderer follows compact, expanded, error, and narrow-width conventions", () => {
  const input = patch("*** Update File: src/example.ts\n@@\n-old\n+new");
  assert.match(render(renderApplyPatchCall({ input }, theme)), /^apply_patch src\/example\.ts$/);

  const details = {
    files: [{ kind: "update", path: "src/example.ts", absolutePath: "/tmp/src/example.ts" }],
    changedFiles: ["src/example.ts"],
    diff: " 1 -old\n 1 +new",
    patch: "",
    summary: "Applied patch: update src/example.ts",
  };
  const collapsed = render(renderApplyPatchResult({ details }, { expanded: false, isPartial: false }, theme, { isError: false }));
  assert.match(collapsed, /Applied patch to 1 file/);
  assert.match(collapsed, /view diff/);
  const expanded = render(renderApplyPatchResult({ details }, { expanded: true, isPartial: false }, theme, { isError: false }));
  assert.match(expanded, /old/);
  assert.match(expanded, /new/);
  const error = render(renderApplyPatchResult({ content: [{ type: "text", text: "first line\nsecond line" }] }, { expanded: false, isPartial: false }, theme, { isError: true }), 12);
  assert.match(error, /failed/);
  for (const line of error.split("\n")) assert.ok(line.length <= 12, `line exceeds width: ${JSON.stringify(line)}`);
});

function workspaceBus() {
  const handlers = new Map();
  return {
    emit(channel, payload) {
      for (const handler of handlers.get(channel) ?? []) handler(payload);
    },
    on(channel, handler) {
      const list = handlers.get(channel) ?? [];
      list.push(handler);
      handlers.set(channel, list);
    },
  };
}

function isLexicalNoHostPreview(state) {
  const preview = state.callComponent?.preview;
  return Boolean(
    preview
    && !("error" in preview)
    && preview.diff === ""
    && preview.patch === ""
    && preview.files.includes("preview.txt")
    && state.callComponent.previewPending === false,
  );
}

function startedAsyncHostPreview(state) {
  const preview = state.callComponent?.preview;
  return Boolean(state.callComponent?.previewPending)
    || Boolean(preview && !("error" in preview) && preview.diff);
}

async function nativeToolRenderCall(t, listeners) {
  const cwd = tempDir();
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  writeFileSync(join(cwd, "preview.txt"), "old");
  const events = workspaceBus();
  for (const bind of listeners ?? []) bind(events);
  const tool = createApplyPatchToolDefinition({ events });
  const state = {};
  const args = { input: patch("*** Update File: preview.txt\n@@\n-old\n+new") };
  tool.renderCall(args, theme, { cwd, argsComplete: true, invalidate() {}, state });
  await new Promise((resolve) => setTimeout(resolve, 20));
  return state;
}

test("native renderCall keeps Host preview when v2 is silent or answers host", async (t) => {
  const noListener = await nativeToolRenderCall(t);
  assert.ok(startedAsyncHostPreview(noListener), "no listener still starts Host preview");
  assert.match(noListener.callComponent.preview.diff, /old/);
  assert.match(noListener.callComponent.preview.diff, /new/);

  const v2Host = await nativeToolRenderCall(t, [(events) => {
    events.on(WORKSPACE_ACCESS_QUERY_V2, (query) => query.provide({ kind: "host" }));
  }]);
  assert.ok(startedAsyncHostPreview(v2Host), "valid v2 host starts Host preview");
  assert.match(v2Host.callComponent.preview.diff, /old/);

  const v1Host = await nativeToolRenderCall(t, [(events) => {
    events.on(WORKSPACE_ACCESS_QUERY_V1, (query) => {
      query.provide({ kind: "access", access: { placement: "host" } });
    });
  }]);
  assert.ok(startedAsyncHostPreview(v1Host), "silent v2 plus valid v1 host starts Host preview");
  assert.match(v1Host.callComponent.preview.diff, /old/);
});

test("native renderCall fails closed after any v2 provide, including malformed", async (t) => {
  const cases = [
    ["undefined", undefined],
    ["null", null],
    ["non-object", "host"],
    ["invalid kind", { kind: "invalid" }],
    ["access", { kind: "access", access: { protocolVersion: 2, placement: "sandbox", inspect() {}, writeFile() {}, remove() {} } }],
    ["unavailable", { kind: "unavailable", reason: "VM starting" }],
  ];
  for (const [label, offer] of cases) {
    const state = await nativeToolRenderCall(t, [(events) => {
      events.on(WORKSPACE_ACCESS_QUERY_V2, (query) => query.provide(offer));
      events.on(WORKSPACE_ACCESS_QUERY_V1, (query) => {
        query.provide({ kind: "access", access: { placement: "host" } });
      });
    }]);
    assert.equal(startedAsyncHostPreview(state), false, `${label} v2 must not start Host preview`);
    assert.ok(isLexicalNoHostPreview(state), `${label} v2 stays on the lexical no-Host body`);
    assert.doesNotMatch(render(state.callComponent), /\bold\b/);
  }

  const firstMalformedWins = await nativeToolRenderCall(t, [(events) => {
    events.on(WORKSPACE_ACCESS_QUERY_V2, (query) => {
      query.provide(undefined);
      query.provide({ kind: "host" });
    });
  }]);
  assert.equal(startedAsyncHostPreview(firstMalformedWins), false, "first malformed v2 provide stays closed even if a later host arrives");
  assert.ok(isLexicalNoHostPreview(firstMalformedWins));
});
