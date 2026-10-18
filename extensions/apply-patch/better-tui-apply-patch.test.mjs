import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const stubModules = new Map([
	["@earendil-works/pi-coding-agent", `
		export function keyHint(_key, description) { return description; }
		export function renderDiff(value) { return value; }
		export async function withFileMutationQueue(_path, fn) { return fn(); }
		export function generateDiffString(oldText, newText) { return { diff: oldText === newText ? "" : "-" + oldText + "\\n+" + newText, firstChangedLine: 1 }; }
		export function generateUnifiedPatch(path, oldText, newText) { return oldText === newText ? "" : "--- " + path + "\\n+++ " + path + "\\n-" + oldText + "\\n+" + newText; }
	`],
	["@earendil-works/pi-tui", `
		export class Text { constructor(value = "") { this.value = value; } render() { return String(this.value).split(/\\r?\\n/); } invalidate() {} }
		export class Container { constructor() { this.children = []; } addChild(child) { this.children.push(child); } clear() { this.children = []; } render(width) { return this.children.flatMap((child) => child.render(width)); } invalidate() {} }
		export class Box extends Container { setBgFn(fn) { this.bgFn = fn; } }
		export class Spacer { constructor(lines = 1) { this.lines = lines; } render() { return Array(this.lines).fill(""); } invalidate() {} }
		export function visibleWidth(value) { return String(value).length; }
		export function truncateToWidth(value, width, marker = "…") { const text = String(value); return text.length <= width ? text : text.slice(0, Math.max(0, width - marker.length)) + marker; }
		export function wrapTextWithAnsi(value) { return String(value).split(/\\r?\\n/); }
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

const { applyPatchCallPresentation, applyPatchPresentation, renderApplyPatchCall, renderApplyPatchResult } = await import("./apply-patch-renderer.ts");

const theme = {
	fg(_name, value) { return value; },
	bg(_name, value) { return value; },
	bold(value) { return value; },
};

function patch(body) {
	return `*** Begin Patch\n${body}\n*** End Patch`;
}

function render(component) {
	return component.render(120).join("\n");
}

test("apply_patch maps owner semantics to Better TUI Protocol v1", () => {
	assert.deepEqual(applyPatchCallPresentation({ input: patch("*** Update File: single.ts\n@@\n-old\n+new") }), {
		action: "Patch",
		target: "single.ts",
	});
	assert.deepEqual(applyPatchCallPresentation({ input: patch("*** Update File: a.ts\n@@\n-old\n+new\n*** Update File: b.ts\n@@\n-old\n+new") }), {
		action: "Patch",
		target: "2 files",
		summary: [{ text: "a.ts" }, { text: "b.ts" }],
	});
	assert.deepEqual(applyPatchPresentation({}, true, false), { status: "running", outcome: "applying" });
	assert.deepEqual(applyPatchPresentation({ details: { changedFiles: ["a.ts", "b.ts"], files: [], noops: [{ path: "a.ts" }, { path: "b.ts" }], diff: "--- a.ts\n+++ a.ts\n-old\n+new" } }, false, false), {
		status: "success",
		target: "2 files",
		outcome: "applied",
		metadata: ["2 hunks already satisfied"],
		summary: [{ text: "a.ts" }, { text: "b.ts" }],
		body: [{ kind: "diff", unified: "--- a.ts\n+++ a.ts\n-old\n+new" }],
	});
	assert.deepEqual(applyPatchPresentation({ content: [{ type: "text", text: "bad patch" }] }, false, true), {
		status: "error",
		outcome: "failed",
		error: "bad patch",
	});
});

test("Better TUI call owns the slot without attaching native async host preview", async (t) => {
	const symbol = Symbol.for("pi.better-tui.api");
	const cwd = mkdtempSync(join(tmpdir(), "codex-tools-better-tui-patch-"));
	t.after(() => {
		delete globalThis[symbol];
		rmSync(cwd, { recursive: true, force: true });
	});
	globalThis[symbol] = {
		capabilities: ["presentation-v1"],
		protocols: {
			v1: {
				version: "1",
				createRenderer(spec) {
					return {
						renderCall(args, _theme, context) {
							const call = spec.call(args, context);
							const component = { visible: true, setVisible(value) { this.visible = value; }, render() { return this.visible ? [`○ ${call.action} ${call.target}`] : []; }, invalidate() {} };
							context.state.betterTui = { call, callComponent: component };
							return component;
						},
						renderResult(result, options, _theme, context) {
							context.state.betterTui.callComponent.setVisible(false);
							if (!Array.isArray(result.content)) throw new Error("result content is required");
							const presentation = spec.result(result, options, context);
							return { render: () => presentation.error ? [`└─ ${presentation.error}`] : ["result"], invalidate() {} };
						},

					};
				},
			},
		},
	};
	writeFileSync(join(cwd, "preview.txt"), "old");
	const args = { input: patch("*** Update File: preview.txt\n@@\n-old\n+new") };
	const state = {};
	let invalidations = 0;
	const context = { cwd, argsComplete: true, invalidate() { invalidations++; }, state, allowHostPreview: true };
	let component = renderApplyPatchCall(args, theme, context);
	// Better TUI returns early before requestPreview; native host preview state stays idle.
	assert.equal(render(component), "○ Patch preview.txt");
	// getApplyPatchCallRenderComponent still seeds state.callComponent for fallback retirement,
	// but native async preview must not start (no pending, no generation, no invalidate).
	assert.equal(state.callComponent?.preview, undefined);
	assert.equal(state.callComponent?.previewPending, false);
	assert.equal(state.callComponent?.previewPendingArgsKey, undefined);
	assert.equal(invalidations, 0);
	component = renderApplyPatchCall(args, theme, { ...context, lastComponent: component });
	assert.equal(render(component), "○ Patch preview.txt");
	assert.equal(state.callComponent?.preview, undefined);
	assert.equal(state.callComponent?.previewPending, false);
	assert.equal(invalidations, 0);

	const error = "authoritative apply failure";
	const errorResult = renderApplyPatchResult(
		{ content: [{ type: "text", text: error }] },
		{ expanded: false, isPartial: false },
		theme,
		{ ...context, args, isError: true },
	);
	const redrawnCall = renderApplyPatchCall(args, theme, { ...context, lastComponent: component });
	const errorOccurrences = `${render(redrawnCall)}\n${render(errorResult)}`.match(new RegExp(error, "g"))?.length ?? 0;
	assert.equal(errorOccurrences, 1, "a final Better TUI error remains visible in exactly one slot after a redraw");

	// Fresh runtime API so Presentation Lifecycle cannot reuse a cached renderer from earlier cases.
	let betterCallRenders = 0;
	let betterResultThrows = 0;
	globalThis[symbol] = {
		capabilities: ["presentation-v1"],
		protocols: {
			v1: {
				version: "1",
				createRenderer(spec) {
					return {
						renderCall(callArgs, _theme, renderContext) {
							betterCallRenders += 1;
							const call = spec.call(callArgs, renderContext);
							const callComponent = { visible: true, setVisible(value) { this.visible = value; }, render() { return this.visible ? [`○ ${call.action} ${call.target}`] : []; }, invalidate() {} };
							renderContext.state.betterTui = { call, callComponent };
							return callComponent;
						},
						renderResult(result, options, _theme, renderContext) {
							betterResultThrows += 1;
							renderContext.state.betterTui?.callComponent?.setVisible(false);
							if (!Array.isArray(result.content)) throw new Error("result content is required");
							const presentation = spec.result(result, options, renderContext);
							return { render: () => presentation.error ? [`└─ ${presentation.error}`] : ["result"], invalidate() {} };
						},
					};
				},
			},
		},
	};

	const malformedState = {};
	const malformedContext = { ...context, state: malformedState, lastComponent: undefined };
	const malformedLiveCall = renderApplyPatchCall(args, theme, malformedContext);
	assert.equal(betterCallRenders, 1);
	let malformedResult;
	assert.doesNotThrow(() => {
		malformedResult = renderApplyPatchResult(
			{},
			{ expanded: false, isPartial: false },
			theme,
			{ ...malformedContext, args, isError: true },
		);
	}, "a failed Better TUI result renderer falls back to a result error");
	assert.equal(betterResultThrows, 1);
	assert.equal(malformedState.codexToolsBetterTuiV1?.family, "retired");
	const malformedError = "apply_patch failed";
	const immediateMalformedOccurrences = `${render(malformedLiveCall)}\n${render(malformedResult)}`.match(new RegExp(malformedError, "g"))?.length ?? 0;
	assert.equal(immediateMalformedOccurrences, 1, "a hidden Better TUI call cannot suppress the fallback result error");
	const invalidationsBeforeRedraw = invalidations;
	const malformedCall = renderApplyPatchCall(args, theme, malformedContext);
	assert.equal(betterCallRenders, 1, "retired call redraw must not reinvoke Better TUI");
	assert.equal(malformedState.callComponent?.preview, undefined, "retired call redraw must not launch Host preview");
	assert.equal(malformedState.callComponent?.previewPending, false);
	assert.equal(invalidations, invalidationsBeforeRedraw, "retired call redraw must not invalidate for Host preview");
	const malformedOccurrences = `${render(malformedCall)}\n${render(malformedResult)}`.match(new RegExp(malformedError, "g"))?.length ?? 0;
	assert.equal(malformedOccurrences, 1, "the fallback result remains the only error after a call redraw");
	const redrawnMalformedResult = renderApplyPatchResult(
		{},
		{ expanded: false, isPartial: false },
		theme,
		{ ...malformedContext, args, isError: true },
	);
	assert.equal(betterResultThrows, 1, "retired result redraw must not reinvoke Better TUI");
	assert.match(render(redrawnMalformedResult), /apply_patch failed/);

	const failedSuccessState = {};
	const failedSuccessContext = { ...context, state: failedSuccessState, lastComponent: undefined };
	const failedSuccessLiveCall = renderApplyPatchCall(args, theme, failedSuccessContext);
	const successfulResult = renderApplyPatchResult(
		{ details: { changedFiles: ["preview.txt"], files: [{ path: "preview.txt" }], diff: "-old\n+new", patch: "" } },
		{ expanded: false, isPartial: false },
		theme,
		{ ...failedSuccessContext, args, isError: false },
	);
	const fallbackSuccess = "Applied patch to 1 file";
	const immediateSuccessOccurrences = `${render(failedSuccessLiveCall)}\n${render(successfulResult)}`.match(new RegExp(fallbackSuccess, "g"))?.length ?? 0;
	assert.equal(immediateSuccessOccurrences, 1, "a failed Better TUI result renderer preserves immediate success feedback");
	assert.equal(failedSuccessState.codexToolsBetterTuiV1?.family, "retired");
	const redrawnSuccessCall = renderApplyPatchCall(args, theme, failedSuccessContext);
	assert.equal(failedSuccessState.callComponent?.preview, undefined, "retired success redraw must not launch Host preview");
	const successOccurrences = `${render(redrawnSuccessCall)}\n${render(successfulResult)}`.match(new RegExp(fallbackSuccess, "g"))?.length ?? 0;
	assert.equal(successOccurrences, 1, "the fallback success remains singular after a call redraw");
	const redrawnSuccessResult = renderApplyPatchResult(
		{ details: { changedFiles: ["preview.txt"], files: [{ path: "preview.txt" }], diff: "-old\n+new", patch: "" } },
		{ expanded: false, isPartial: false },
		theme,
		{ ...failedSuccessContext, args, isError: false },
	);
	assert.match(render(redrawnSuccessResult), /Applied patch to 1 file/);

	const partialState = {};
	const partialContext = { ...context, state: partialState, lastComponent: undefined };
	renderApplyPatchCall(args, theme, partialContext);
	let partialResult;
	assert.doesNotThrow(() => {
		partialResult = renderApplyPatchResult(
			{},
			{ expanded: false, isPartial: true },
			theme,
			{ ...partialContext, args, isError: false },
		);
	}, "a failed Better TUI partial renderer falls back to the applying status");
	assert.equal(render(partialResult), "Applying patch…");
	assert.equal(partialState.codexToolsBetterTuiV1?.family, "retired");
});

test("native fallback still previews asynchronously when Better TUI is absent", async (t) => {
	const symbol = Symbol.for("pi.better-tui.api");
	delete globalThis[symbol];
	const cwd = mkdtempSync(join(tmpdir(), "codex-tools-native-patch-"));
	t.after(() => {
		rmSync(cwd, { recursive: true, force: true });
	});
	writeFileSync(join(cwd, "preview.txt"), "old");
	const args = { input: patch("*** Update File: preview.txt\n@@\n-old\n+new") };
	const state = {};
	let invalidations = 0;
	const context = { cwd, argsComplete: true, invalidate() { invalidations++; }, state, allowHostPreview: true };
	renderApplyPatchCall(args, theme, context);
	for (let attempt = 0; attempt < 50 && !state.callComponent?.preview; attempt++) {
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
	assert.ok(state.callComponent?.preview, "native host preview resolves asynchronously");
	const component = renderApplyPatchCall(args, theme, { ...context, lastComponent: state.callComponent });
	// Native fallback uses the apply_patch header + async host diff body (not Better TUI ○ Patch).
	assert.match(render(component), /apply_patch preview\.txt/);
	assert.match(render(component), /old/);
	assert.match(render(component), /new/);
	assert.ok(invalidations > 0);
});
