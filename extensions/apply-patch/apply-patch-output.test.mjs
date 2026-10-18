import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { Value } from "typebox/value";
import { ApplyPatchOutputSchema, buildApplyPatchOutput } from "./apply-patch-output.ts";
import { createApplyPatchToolDefinition } from "./apply-patch-tool.ts";
import { createHostWorkspaceAccess, WORKSPACE_ACCESS_QUERY_V2 } from "./workspace-files.ts";
import { findPiHost } from "./pi-host-test-helper.mjs";

test("patch output keeps relative action/no-op metadata but excludes source and Host paths", () => {
	const details = {
		summary: "Applied patch", changedFiles: ["source.txt", "moved.txt"],
		files: [{ kind: "update", path: "source.txt", moveTo: "moved.txt", absolutePath: "/private/host/source.txt", absoluteMoveTo: "/private/host/moved.txt" }],
		noops: [{ path: "noop.txt", actionIndex: 1, hunkIndex: 0, startLine: 1, endLine: 2, reason: "already_satisfied" }],
		firstChangedLine: 1, diff: "SECRET_DIFF", patch: "SECRET_PATCH",
	};
	const result = buildApplyPatchOutput(details);
	assert.equal(Value.Check(ApplyPatchOutputSchema, result), true);
	assert.equal(result.ok, true);
	assert.deepEqual(result.files, [{ kind: "update", path: "source.txt", moveTo: "moved.txt" }]);
	assert.deepEqual(result.noops, details.noops);
	assert.doesNotMatch(JSON.stringify(result), /SECRET_|\/private\/host/);
	result.changedFiles.push("other.txt");
	result.noops[0].path = "other.txt";
	assert.deepEqual(details.changedFiles, ["source.txt", "moved.txt"]);
	assert.equal(details.noops[0].path, "noop.txt");
});

test("registered patch execution returns schema-valid create/move/no-op/delete results", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "apply-patch-output-"));
	try {
		const tool = createApplyPatchToolDefinition();
		assert.equal(tool.outputSchema, ApplyPatchOutputSchema);
		const patches = [
			"*** Begin Patch\n*** Add File: source.txt\n+hello\n*** End Patch",
			"*** Begin Patch\n*** Update File: source.txt\n*** Move to: moved.txt\n@@\n-hello\n+world\n*** End Patch",
			"*** Begin Patch\n*** Update File: moved.txt\n@@\n world\n*** End Patch",
			"*** Begin Patch\n*** Delete File: moved.txt\n*** End Patch",
		];
		const results = [];
		for (const [index, input] of patches.entries()) {
			const result = await tool.execute(`patch-${index}`, { input }, undefined, undefined, { cwd });
			assert.equal(Value.Check(tool.outputSchema, result.structuredContent), true, JSON.stringify(result.structuredContent));
			assert.match(result.content[0].text, /Files changed:/);
			assert.deepEqual(result.structuredContent.changedFiles, result.details.changedFiles);
			assert.equal(Object.hasOwn(result.structuredContent, "diff"), false);
			assert.equal(Object.hasOwn(result.structuredContent, "patch"), false);
			assert.doesNotMatch(JSON.stringify(result.structuredContent), new RegExp(cwd));
			results.push(result.structuredContent);
		}
		assert.equal(results[0].files[0].kind, "add");
		assert.equal(results[1].files[0].moveTo, "moved.txt");
		assert.deepEqual(results[2].changedFiles, []);
		assert.equal(results[2].ok, true);
		assert.equal(results[2].noops[0].reason, "already_satisfied");
		assert.equal(results[3].files[0].kind, "delete");
		await assert.rejects(() => tool.execute("bad", { input: "not a patch" }, undefined, undefined, { cwd }), /Patch must start/);
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

test("patch output schema rejects renderer data and invalid actions", () => {
	const result = { ok: true, summary: "No changes", changedFiles: [], files: [], noops: [] };
	assert.equal(Value.Check(ApplyPatchOutputSchema, result), true);
	assert.equal(Value.Check(ApplyPatchOutputSchema, { ...result, patch: "source" }), false);
	assert.equal(Value.Check(ApplyPatchOutputSchema, { ...result, files: [{ kind: "unknown", path: "file.txt" }] }), false);
	const { noops: _noops, ...missing } = result;
	assert.equal(Value.Check(ApplyPatchOutputSchema, missing), false);
	assert.deepEqual(Object.keys(ApplyPatchOutputSchema.properties), ["ok", "summary", "changedFiles", "files", "noops", "firstChangedLine"]);
	for (const key of ["ok", "summary", "changedFiles", "files", "noops"]) {
		const incomplete = { ...result };
		delete incomplete[key];
		assert.equal(Value.Check(ApplyPatchOutputSchema, incomplete), false, `${key} stays required`);
	}
	assert.equal(Value.Check(ApplyPatchOutputSchema, { ...result, firstChangedLine: 1 }), true);
	assert.equal(Value.Check(ApplyPatchOutputSchema, { ...result, firstChangedLine: 0 }), false);
	assert.equal(Value.Check(ApplyPatchOutputSchema, { ...result, outcome: "applied" }), false);
});

test("structured output preserves the exact public fields for update, mixed and all-noop patches", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "apply-patch-output-mixed-"));
	const tool = createApplyPatchToolDefinition();
	const execute = (body, signal) => tool.execute("output", { input: `*** Begin Patch\n${body}\n*** End Patch` }, signal, undefined, { cwd });
	try {
		assert.equal(tool.exposure ?? "direct", "direct");
		assert.deepEqual(tool.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false });
		writeFileSync(join(cwd, "file.txt"), "old\n");
		const update = await execute("*** Update File: file.txt\n@@\n-old\n+new");
		assert.deepEqual(update.structuredContent, {
			ok: true, summary: update.details.summary, changedFiles: ["file.txt"],
			files: [{ kind: "update", path: "file.txt" }], noops: [], firstChangedLine: 1,
		});
		const noop = await execute("*** Update File: file.txt\n@@\n-new\n+new");
		const noops = [{ path: "file.txt", actionIndex: 0, hunkIndex: 0, startLine: 1, endLine: 1, reason: "already_satisfied" }];
		assert.deepEqual(noop.structuredContent, {
			ok: true, summary: "Patch already satisfied: 1 hunk required no change.", changedFiles: [],
			files: [{ kind: "update", path: "file.txt" }], noops,
		});
		assert.equal(noop.details.diff, "");
		assert.equal(noop.details.patch, "");
		const mixed = await execute("*** Update File: file.txt\n@@\n new\n*** Add File: empty.txt\n+");
		assert.equal(Value.Check(ApplyPatchOutputSchema, mixed.structuredContent), true);
		assert.deepEqual(mixed.structuredContent.changedFiles, ["empty.txt"]);
		assert.deepEqual(mixed.structuredContent.noops, noops);
		assert.deepEqual(mixed.structuredContent.files, [{ kind: "update", path: "file.txt" }, { kind: "add", path: "empty.txt" }]);
		assert.equal(mixed.structuredContent.ok, true);
		assert.equal(Object.hasOwn(mixed.structuredContent, "outcome"), false);
		for (const body of ["", "not-a-header", "*** Update File: file.txt\n@@\n-missing\n+changed", "*** Add File: ../escape.txt\n+bad"]) await assert.rejects(execute(body));
		await assert.rejects(execute("*** Delete File: file.txt", AbortSignal.abort()), /aborted/);
		assert.equal(readFileSync(join(cwd, "file.txt"), "utf8"), "new\n");
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const conflict of [false, true]) {
	test(`partial mutation with ${conflict ? "rollback conflict" : "successful rollback"} throws without success data`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "apply-patch-output-rollback-"));
		try {
			writeFileSync(join(cwd, "a.txt"), "old\n");
			writeFileSync(join(cwd, "b.txt"), "old\n");
			const host = createHostWorkspaceAccess(cwd);
			let writes = 0;
			const access = { ...host, placement: "sandbox", async writeFile(path, data, options) {
				if (++writes === 2) {
					if (conflict) writeFileSync(join(cwd, "a.txt"), "external\n");
					throw new Error("fixture second write failed");
				}
				return host.writeFile(path, data, options);
			} };
			const definition = createApplyPatchToolDefinition({ events: { emit(name, query) {
				if (name === WORKSPACE_ACCESS_QUERY_V2) query.provide({ kind: "access", access });
			} } });
			await assert.rejects(definition.execute("rollback", { input: "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Update File: b.txt\n@@\n-old\n+new\n*** End Patch" }, undefined, undefined, { cwd }), conflict ? /workspace mutation state uncertain.*Rollback conflict/s : /Rolled back all touched files/);
			assert.equal(readFileSync(join(cwd, "a.txt"), "utf8"), conflict ? "external\n" : "old\n");
			assert.equal(readFileSync(join(cwd, "b.txt"), "utf8"), "old\n");
		} finally { rmSync(cwd, { recursive: true, force: true }); }
	});
}

test("native Pi codemode receives the patch object, not the display summary", async () => {
	const host = await findPiHost();
	const executePath = join(host.root, "dist", "extensions", "codemode", "execute.js");
	const { executeCodemode } = await import(pathToFileURL(executePath).href);
	const cwd = mkdtempSync(join(tmpdir(), "patch-codemode-output-"));
	try {
		const tool = createApplyPatchToolDefinition();
		const result = await executeCodemode("patch-output-probe", { code: "const result = await tools.apply_patch({ input: '*** Begin Patch\\n*** Add File: new.txt\\n+hello\\n*** End Patch' }); return { kind: typeof result, changedFiles: result.changedFiles, ok: result.ok };" }, undefined, undefined, {
			tools: [tool], sessionManager: { getBranch: () => [] },
			async executeTool(name, args, { signal }) {
				assert.equal(name, "apply_patch");
				return { toolCall: { id: "patch-output-probe/1" }, isError: false, result: await tool.execute("patch-output-probe/1", args, signal, undefined, { cwd }) };
			},
		});
		assert.equal(result.isError, undefined, JSON.stringify(result));
		assert.deepEqual(JSON.parse(result.content.at(-1).text), { kind: "object", changedFiles: ["new.txt"], ok: true });
	} finally { rmSync(cwd, { recursive: true, force: true }); }
});
