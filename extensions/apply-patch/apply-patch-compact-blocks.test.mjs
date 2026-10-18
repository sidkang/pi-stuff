/**
 * Cross-package regression: apply_patch + real Better TUI Compact Blocks.
 * Better TUI owns call/result slots; native async host preview must not wrap
 * CompactMemberSlot or attach at the root of a multi-member block.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Stub only coding-agent theme helpers; Better TUI runtime is the real sibling package.
const stubModules = new Map([
	["@earendil-works/pi-coding-agent", `
		export function keyHint(_key, description) { return description; }
		export function renderDiff(value) { return value; }
		export async function withFileMutationQueue(_path, fn) { return fn(); }
		export function generateDiffString(oldText, newText) { return { diff: oldText === newText ? "" : "-" + oldText + "\\n+" + newText, firstChangedLine: 1 }; }
		export function generateUnifiedPatch(path, oldText, newText) { return oldText === newText ? "" : "--- " + path + "\\n+++ " + path + "\\n-" + oldText + "\\n+" + newText; }
	`],
]);

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (stubModules.has(specifier)) return { url: `stub:${specifier}`, shortCircuit: true };
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url.startsWith("stub:")) return { format: "module", source: stubModules.get(url.slice(5)), shortCircuit: true };
		return nextLoad(url, context);
	},
});

const betterTuiRoot = new URL("../better-tui/", import.meta.url);
const { CompactBlockCoordinator } = await import(new URL("compact-blocks.ts", betterTuiRoot).href);
const { resolveToolPresentation } = await import(new URL("design-language.ts", betterTuiRoot).href);
const { installBetterTuiAPI } = await import(new URL("tui.ts", betterTuiRoot).href);
const { renderApplyPatchCall, renderApplyPatchResult } = await import("./apply-patch-renderer.ts");

const theme = {
	fg(_name, value) { return value; },
	bg(_name, value) { return value; },
	bold(value) { return value; },
};

function patch(body) {
	return `*** Begin Patch\n${body}\n*** End Patch`;
}

function text(lines) {
	const output = Array.isArray(lines) ? lines : [lines];
	return { render: () => output, invalidate() {} };
}

function installCompactRuntime() {
	const subject = new CompactBlockCoordinator({
		createPresentation(view, options) {
			const metadata = [view.outcome, ...(view.metadata ?? [])].filter(Boolean);
			const headline = `◆ ${view.action} ${view.target}${metadata.length ? ` · ${metadata.join(" · ")}` : ""}`;
			const details = [];
			for (const body of view.body ?? []) {
				if (body.kind === "diff") {
					for (const line of String(body.unified).split("\n")) details.push(`└─ ${line}`);
				} else if (body.kind === "text") {
					for (const line of String(body.text).split("\n")) details.push(`└─ ${line}`);
				}
			}
			// Body (including unified diffs) is expanded-only; collapsed must not fake-green this assertion.
			const shown = options.mode === "expanded" ? details : [];
			return text([headline, ...shown]);
		},
		resolvePresentation: resolveToolPresentation,
	});
	const api = installBetterTuiAPI({ compactBlocks: subject });
	return { subject, api };
}

function makeContext(cwd, toolCallId, state, extra = {}) {
	return {
		cwd,
		toolCallId,
		argsComplete: true,
		executionStarted: true,
		invalidate() {},
		state,
		allowHostPreview: true,
		...extra,
	};
}

test("apply_patch compact root aggregates Patch headlines; native preview is not root-attached; expanded result body shows each member diff once", async (t) => {
	const { subject, api } = installCompactRuntime();
	const cwd = mkdtempSync(join(tmpdir(), "codex-apply-patch-compact-"));
	t.after(() => {
		api.dispose();
		rmSync(cwd, { recursive: true, force: true });
	});

	writeFileSync(join(cwd, "a.ts"), "old-a\n");
	writeFileSync(join(cwd, "b.ts"), "old-b\n");

	const argsA = { input: patch("*** Update File: a.ts\n@@\n-old-a\n+new-a") };
	const argsB = { input: patch("*** Update File: b.ts\n@@\n-old-b\n+new-b") };
	const stateA = {};
	const stateB = {};
	let invalidationsA = 0;
	let invalidationsB = 0;

	subject.observe({ type: "tool-start", toolCallId: "patch-a" });
	subject.observe({ type: "tool-start", toolCallId: "patch-b" });

	const callA = renderApplyPatchCall(argsA, theme, makeContext(cwd, "patch-a", stateA, {
		invalidate() { invalidationsA++; },
	}));
	const callB = renderApplyPatchCall(argsB, theme, makeContext(cwd, "patch-b", stateB, {
		invalidate() { invalidationsB++; },
	}));

	const rootLines = callA.render(100).map((line) => line.trimEnd()).filter((line) => line.length > 0);
	const memberLines = callB.render(100);

	assert.deepEqual(memberLines, [], "non-root CompactMemberSlot must be zero-height");
	assert.ok(rootLines.some((line) => /Patch a\.ts/.test(line)), `root should include first Patch headline: ${rootLines.join(" | ")}`);
	assert.ok(rootLines.some((line) => /Patch b\.ts/.test(line)), `root should include second Patch headline: ${rootLines.join(" | ")}`);
	// Native async host preview must not append file-level diff bodies under the whole block.
	assert.equal(rootLines.filter((line) => /old-a|new-a|old-b|new-b/.test(line)).length, 0, "call preview must not attach native host diffs to the compact root");
	// Better TUI path still seeds callComponent for retirement, but must not start native preview I/O.
	assert.equal(stateA.callComponent?.preview, undefined, "Better TUI call path must not start native ApplyPatchCallRenderComponent preview");
	assert.equal(stateB.callComponent?.preview, undefined);
	assert.equal(stateA.callComponent?.previewPending, false);
	assert.equal(stateB.callComponent?.previewPending, false);
	assert.equal(stateA.callComponent?.previewPendingArgsKey, undefined);
	assert.equal(stateB.callComponent?.previewPendingArgsKey, undefined);
	assert.equal(invalidationsA, 0);
	assert.equal(invalidationsB, 0);

	// Final diffs live in the expanded Protocol v1 result body, not collapsed headlines.
	const resultA = renderApplyPatchResult(
		{
			content: [{ type: "text", text: "Applied\nFiles changed: a.ts" }],
			details: {
				summary: "Applied",
				changedFiles: ["a.ts"],
				files: [{ path: "a.ts" }],
				noops: [],
				diff: "--- a.ts\n+++ a.ts\n-old-a\n+new-a",
				patch: "",
			},
		},
		{ expanded: true, isPartial: false },
		theme,
		makeContext(cwd, "patch-a", stateA, { args: argsA, isError: false }),
	);
	const resultB = renderApplyPatchResult(
		{
			content: [{ type: "text", text: "Applied\nFiles changed: b.ts" }],
			details: {
				summary: "Applied",
				changedFiles: ["b.ts"],
				files: [{ path: "b.ts" }],
				noops: [],
				diff: "--- b.ts\n+++ b.ts\n-old-b\n+new-b",
				patch: "",
			},
		},
		{ expanded: true, isPartial: false },
		theme,
		makeContext(cwd, "patch-b", stateB, { args: argsB, isError: false }),
	);

	// Compact Blocks paint only on the root *call* slot; result slots stay zero-height.
	assert.deepEqual(resultA.render(100), [], "root result slot is zero-height; aggregation is on the call root");
	assert.deepEqual(resultB.render(100), [], "non-root result slot stays zero-height");
	const finalRoot = callA.render(100).map((line) => line.trimEnd()).filter((line) => line.length > 0).join("\n");
	assert.match(finalRoot, /Patch a\.ts/);
	assert.match(finalRoot, /Patch b\.ts/);
	// Expanded Protocol v1 body: each member's unified diff appears once (no native host wrap).
	assert.match(finalRoot, /old-a/);
	assert.match(finalRoot, /new-a/);
	assert.match(finalRoot, /old-b/);
	assert.match(finalRoot, /new-b/);
	assert.equal((finalRoot.match(/--- a\.ts/g) ?? []).length, 1);
	assert.equal((finalRoot.match(/--- b\.ts/g) ?? []).length, 1);
	assert.equal((finalRoot.match(/old-a/g) ?? []).length, 1);
	assert.equal((finalRoot.match(/old-b/g) ?? []).length, 1);
	// Non-root call remains empty after final results.
	assert.deepEqual(callB.render(100), []);
});

test("apply_patch expanded final diffs survive post-result renderApplyPatchCall rebuild (result-owned mode)", async (t) => {
	const { subject, api } = installCompactRuntime();
	const cwd = mkdtempSync(join(tmpdir(), "codex-apply-patch-compact-rebuild-"));
	t.after(() => {
		api.dispose();
		rmSync(cwd, { recursive: true, force: true });
	});

	writeFileSync(join(cwd, "a.ts"), "old-a\n");
	writeFileSync(join(cwd, "b.ts"), "old-b\n");

	const argsA = { input: patch("*** Update File: a.ts\n@@\n-old-a\n+new-a") };
	const argsB = { input: patch("*** Update File: b.ts\n@@\n-old-b\n+new-b") };
	const stateA = {};
	const stateB = {};

	subject.observe({ type: "tool-start", toolCallId: "patch-a" });
	subject.observe({ type: "tool-start", toolCallId: "patch-b" });

	const callA = renderApplyPatchCall(argsA, theme, makeContext(cwd, "patch-a", stateA));
	const callB = renderApplyPatchCall(argsB, theme, makeContext(cwd, "patch-b", stateB));

	renderApplyPatchResult(
		{
			content: [{ type: "text", text: "Applied\nFiles changed: a.ts" }],
			details: {
				summary: "Applied",
				changedFiles: ["a.ts"],
				files: [{ path: "a.ts" }],
				noops: [],
				diff: "--- a.ts\n+++ a.ts\n-old-a\n+new-a",
				patch: "",
			},
		},
		{ expanded: true, isPartial: false },
		theme,
		makeContext(cwd, "patch-a", stateA, { args: argsA, isError: false }),
	);
	renderApplyPatchResult(
		{
			content: [{ type: "text", text: "Applied\nFiles changed: b.ts" }],
			details: {
				summary: "Applied",
				changedFiles: ["b.ts"],
				files: [{ path: "b.ts" }],
				noops: [],
				diff: "--- b.ts\n+++ b.ts\n-old-b\n+new-b",
				patch: "",
			},
		},
		{ expanded: true, isPartial: false },
		theme,
		makeContext(cwd, "patch-b", stateB, { args: argsB, isError: false }),
	);

	const expandedRoot = callA.render(100).map((line) => line.trimEnd()).filter((line) => line.length > 0).join("\n");
	assert.match(expandedRoot, /old-a/);
	assert.match(expandedRoot, /old-b/);

	// Reviewer sequence: after expanded finals, Pi rebuilds via renderCall with lastComponent.
	// Call-collapsed rebuild must not erase result-owned expanded diffs.
	const rebuiltA = renderApplyPatchCall(argsA, theme, makeContext(cwd, "patch-a", stateA, {
		lastComponent: callA,
	}));
	const rebuiltB = renderApplyPatchCall(argsB, theme, makeContext(cwd, "patch-b", stateB, {
		lastComponent: callB,
	}));

	const rebuiltRoot = rebuiltA.render(100).map((line) => line.trimEnd()).filter((line) => line.length > 0).join("\n");
	assert.match(rebuiltRoot, /Patch a\.ts/);
	assert.match(rebuiltRoot, /Patch b\.ts/);
	assert.equal((rebuiltRoot.match(/--- a\.ts/g) ?? []).length, 1, "each member diff must remain once after call rebuild");
	assert.equal((rebuiltRoot.match(/--- b\.ts/g) ?? []).length, 1);
	assert.equal((rebuiltRoot.match(/old-a/g) ?? []).length, 1);
	assert.equal((rebuiltRoot.match(/old-b/g) ?? []).length, 1);
	assert.deepEqual(rebuiltB.render(100), [], "non-root call stays zero-height after rebuild");
	// Original root identity may also repaint the same aggregated body.
	const originalRoot = callA.render(100).map((line) => line.trimEnd()).filter((line) => line.length > 0).join("\n");
	assert.equal((originalRoot.match(/--- a\.ts/g) ?? []).length, 1);
	assert.equal((originalRoot.match(/--- b\.ts/g) ?? []).length, 1);
});
