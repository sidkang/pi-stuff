import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
	resolve(specifier, context, nextResolve) {
		if (specifier === "@earendil-works/pi-tui") return { url: "stub:pi-tui", shortCircuit: true };
		return nextResolve(specifier, context);
	},
	load(url, context, nextLoad) {
		if (url === "stub:pi-tui") {
			return {
				format: "module",
				source: `
					export function visibleWidth(value) { return String(value).length; }
					export function truncateToWidth(value, width, marker = "…") {
						const text = String(value);
						return text.length <= width ? text : text.slice(0, Math.max(0, width - marker.length)) + marker;
					}
					export class Box {
						constructor(px = 1, py = 0, bgFn = (s) => s) {
							this.px = px; this.py = py; this.bgFn = bgFn; this.children = [];
						}
						addChild(child) { this.children.push(child); }
						render(width = 120) {
							const inner = Math.max(1, width - this.px * 2);
							const rows = [];
							for (const child of this.children) {
								for (const line of child.render(inner)) {
									rows.push(this.bgFn(" ".repeat(this.px) + line + " ".repeat(this.px)));
								}
							}
							return rows;
						}
						invalidate() { for (const c of this.children) c.invalidate?.(); }
					}
				`,
				shortCircuit: true,
			};
		}
		return nextLoad(url, context);
	},
});

const {
	attemptPresentationResult,
	presentationFamilyOf,
	presentToolCall,
	presentToolResult,
	renderBetterTuiCall,
	renderBetterTuiResult,
} = await import("./better-tui-v1.ts");

const symbol = Symbol.for("pi.better-tui.api");
const theme = {};
const callComponent = { render: () => ["better call"], invalidate() {}, visible: true, setVisible(value) { this.visible = value; } };
const resultComponent = { render: () => ["better result"], invalidate() {} };
const nativeCall = { render: () => ["native call"], invalidate() {} };
const nativeResult = { render: () => ["native result"], invalidate() {} };

function installProtocol(captured, options = {}) {
	const capabilities = options.capabilities === undefined ? ["presentation-v1"] : options.capabilities;
	globalThis[symbol] = {
		...(capabilities === null ? {} : { capabilities }),
		protocols: {
			v1: {
				version: "1",
				createRenderer(spec) {
					captured.creations = (captured.creations ?? 0) + 1;
					const calls = new WeakMap();
					return {
						renderCall(args, _theme, renderContext) {
							captured.call = spec.call(args, renderContext);
							calls.set(renderContext.state, captured.call);
							callComponent.visible = true;
							return callComponent;
						},
						renderResult(result, options, _theme, renderContext) {
							if (!calls.has(renderContext.state)) throw new Error("result before call");
							captured.result = spec.result(result, options, renderContext);
							callComponent.visible = false;
							return resultComponent;
						},
					};
				},
			},
		},
	};
}

test("Presentation Lifecycle discovery is dynamic and falls back safely", (t) => {
	t.after(() => delete globalThis[symbol]);
	const spec = {
		call: (args) => ({ action: "Test", target: args.target }),
		result: (_result, options) => ({ status: options.isPartial ? "running" : "success", outcome: "done" }),
	};

	const fallbackContext = { state: {}, invalidate() {} };
	delete globalThis[symbol];
	assert.equal(renderBetterTuiCall(spec, { target: "one" }, theme, fallbackContext), undefined);
	assert.equal(presentationFamilyOf(fallbackContext.state), "fallback");
	assert.equal(
		presentToolCall(spec, { target: "one" }, theme, fallbackContext, () => nativeCall),
		nativeCall,
	);

	const captured = {};
	installProtocol(captured);
	assert.equal(renderBetterTuiResult(spec, {}, { expanded: false, isPartial: false }, theme, fallbackContext), undefined, "a call keeps its fallback renderer family when Better TUI appears mid-flight");
	assert.deepEqual(
		attemptPresentationResult(spec, {}, { expanded: false, isPartial: false }, theme, fallbackContext),
		{ failed: false, family: "fallback" },
	);

	const betterContext = { state: {}, invalidate() {} };
	assert.equal(renderBetterTuiCall(spec, { target: "two" }, theme, betterContext), callComponent);
	assert.equal(presentationFamilyOf(betterContext.state), "better-tui");
	assert.deepEqual(captured.call, { action: "Test", target: "two" });
	assert.equal(renderBetterTuiResult(spec, { details: {} }, { expanded: false, isPartial: false }, theme, betterContext), resultComponent);
	assert.deepEqual(captured.result, { status: "success", outcome: "done" });

	const removedContext = { state: {}, invalidate() {} };
	assert.equal(renderBetterTuiCall(spec, { target: "removed" }, theme, removedContext), callComponent);
	delete globalThis[symbol];
	assert.equal(renderBetterTuiResult(spec, {}, { expanded: false, isPartial: false }, theme, removedContext), resultComponent);
	assert.equal(callComponent.visible, false, "the selected renderer completes its call after provider removal");

	const firstProvider = {};
	installProtocol(firstProvider);
	const replacedContext = { state: {}, invalidate() {} };
	assert.equal(renderBetterTuiCall(spec, { target: "replaced" }, theme, replacedContext), callComponent);
	const secondProvider = {};
	installProtocol(secondProvider);
	assert.equal(renderBetterTuiCall(spec, { target: "replaced-again" }, theme, replacedContext), callComponent);
	assert.equal(renderBetterTuiResult(spec, {}, { expanded: false, isPartial: false }, theme, replacedContext), resultComponent);
	assert.deepEqual(firstProvider.result, { status: "success", outcome: "done" });
	assert.equal(secondProvider.result, undefined, "repeated call renders do not switch provider families");

	installProtocol(captured);
	globalThis[symbol].protocols.v1.createRenderer = () => { throw new Error("renderer unavailable"); };
	const brokenContext = { state: {}, invalidate() {} };
	assert.equal(renderBetterTuiCall(spec, { target: "three" }, theme, brokenContext), undefined);
	assert.equal(presentationFamilyOf(brokenContext.state), "fallback");
});

test("Presentation Lifecycle caches one renderer per runtime API and spec", (t) => {
	t.after(() => delete globalThis[symbol]);
	const spec = {
		call: (args) => ({ action: "Test", target: args.target }),
		result: () => ({ status: "success" }),
	};
	const first = {};
	installProtocol(first);

	renderBetterTuiCall(spec, { target: "one" }, theme, { state: {}, invalidate() {} });
	renderBetterTuiCall(spec, { target: "two" }, theme, { state: {}, invalidate() {} });
	assert.equal(first.creations, 1);

	const replacement = {};
	installProtocol(replacement);
	renderBetterTuiCall(spec, { target: "three" }, theme, { state: {}, invalidate() {} });
	assert.equal(replacement.creations, 1);
});

test("valid v1 without presentation-v1 capability falls back and stays sticky", (t) => {
	t.after(() => delete globalThis[symbol]);
	const spec = {
		call: (args) => ({ action: "Test", target: args.target }),
		result: () => ({ status: "success", outcome: "done" }),
	};

	for (const capabilities of [null, [], ["component-slots"]]) {
		const captured = {};
		installProtocol(captured, { capabilities });
		const context = { state: {}, invalidate() {} };
		assert.equal(
			renderBetterTuiCall(spec, { target: "no-cap" }, theme, context),
			undefined,
			`capabilities ${JSON.stringify(capabilities)} must not select Better TUI`,
		);
		assert.equal(presentationFamilyOf(context.state), "fallback");
		// Capability appears mid-flight; sticky fallback must not switch family.
		installProtocol(captured, { capabilities: ["presentation-v1"] });
		assert.equal(renderBetterTuiCall(spec, { target: "no-cap" }, theme, context), undefined);
		assert.equal(renderBetterTuiResult(spec, {}, { expanded: false, isPartial: false }, theme, context), undefined);
		assert.equal(captured.creations, undefined);
	}
});

test("presentToolCall and presentToolResult own adapter selection for tool callers", (t) => {
	t.after(() => delete globalThis[symbol]);
	const spec = {
		call: (args) => ({ action: "Search", target: args.query }),
		result: () => ({ status: "success", outcome: "done" }),
	};

	delete globalThis[symbol];
	const nativeContext = { state: {}, invalidate() {} };
	assert.equal(
		presentToolCall(spec, { query: "q" }, theme, nativeContext, () => nativeCall),
		nativeCall,
	);
	assert.equal(presentationFamilyOf(nativeContext.state), "fallback");
	assert.equal(
		presentToolResult(spec, {}, { expanded: false, isPartial: false }, theme, nativeContext, () => nativeResult),
		nativeResult,
	);

	const captured = {};
	installProtocol(captured);
	const betterContext = { state: {}, invalidate() {} };
	assert.equal(
		presentToolCall(spec, { query: "release notes" }, theme, betterContext, () => nativeCall),
		callComponent,
	);
	assert.deepEqual(captured.call, { action: "Search", target: "release notes" });
	assert.equal(
		presentToolResult(spec, { details: {} }, { expanded: false, isPartial: false }, theme, betterContext, () => nativeResult),
		resultComponent,
	);
	assert.deepEqual(captured.result, { status: "success", outcome: "done" });
});

test("attemptPresentationResult retires Better TUI after a terminal result throw", (t) => {
	t.after(() => delete globalThis[symbol]);
	const captured = { resultThrows: 0, callRenders: 0 };
	installProtocol(captured);
	globalThis[symbol].protocols.v1.createRenderer = (spec) => ({
		renderCall(args, _theme, context) {
			captured.callRenders += 1;
			captured.call = spec.call(args, context);
			return callComponent;
		},
		renderResult() {
			captured.resultThrows += 1;
			throw new Error("result content is required");
		},
	});

	const spec = {
		call: (args) => ({ action: "Patch", target: args.target }),
		result: () => ({ status: "error", outcome: "failed", error: "bad" }),
	};
	const context = { state: {}, invalidate() {} };
	assert.equal(presentToolCall(spec, { target: "file.ts" }, theme, context, () => nativeCall), callComponent);
	assert.equal(captured.callRenders, 1);

	const attempt = attemptPresentationResult(spec, {}, { expanded: false, isPartial: false }, theme, context);
	assert.deepEqual(attempt, { failed: true, family: "retired" });
	assert.equal(presentationFamilyOf(context.state), "retired");
	assert.equal(context.state.codexToolsBetterTuiV1?.family, "retired");
	assert.equal(captured.resultThrows, 1);

	// Later call redraw must stay native and must not re-enter Better TUI.
	assert.equal(
		presentToolCall(spec, { target: "file.ts" }, theme, context, () => nativeCall),
		nativeCall,
	);
	assert.equal(captured.callRenders, 1, "retired execution must not reinvoke Better TUI call");

	// Later result redraw must not throw again or reinvoke Better TUI.
	let observed;
	const component = presentToolResult(
		spec,
		{},
		{ expanded: false, isPartial: false },
		theme,
		context,
		(next) => {
			observed = next;
			return nativeResult;
		},
	);
	assert.equal(component, nativeResult);
	assert.deepEqual(observed, { failed: false, family: "retired" });
	assert.equal(captured.resultThrows, 1, "retired execution must not reinvoke Better TUI result");
	assert.equal(renderBetterTuiCall(spec, { target: "file.ts" }, theme, context), undefined);
	assert.equal(renderBetterTuiResult(spec, {}, { expanded: false, isPartial: false }, theme, context), undefined);
});

test("presentToolResult notifies tool-owned side effects when Better TUI wins", (t) => {
	t.after(() => delete globalThis[symbol]);
	const captured = {};
	installProtocol(captured);
	const spec = {
		call: (args) => ({ action: "Search", target: args.query }),
		result: () => ({ status: "success", outcome: "done" }),
	};
	const context = { state: {}, invalidate() {} };
	presentToolCall(spec, { query: "q" }, theme, context, () => nativeCall);

	const attempts = [];
	const component = presentToolResult(
		spec,
		{},
		{ expanded: false, isPartial: false },
		theme,
		context,
		() => nativeResult,
		(attempt) => attempts.push(attempt),
	);
	assert.equal(component, resultComponent);
	assert.equal(attempts.length, 1);
	assert.equal(attempts[0].component, resultComponent);
	assert.equal(attempts[0].failed, false);
	assert.equal(attempts[0].family, "better-tui");
});
