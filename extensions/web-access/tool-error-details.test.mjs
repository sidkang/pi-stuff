import assert from "node:assert/strict";
import test from "node:test";
import { createToolErrorDetailsBridge } from "./tool-error-details.ts";

function mockPi() {
	const handlers = new Map();
	return {
		on(event, handler) {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
		},
		emit(event, payload) {
			let result;
			for (const handler of handlers.get(event) ?? []) {
				const next = handler(payload);
				if (next !== undefined) result = next;
			}
			return result;
		},
	};
}

test("interleaved toolCallIds restore only their own details", () => {
	const bridge = createToolErrorDetailsBridge("web_search");
	const pi = mockPi();
	bridge.install(pi);

	bridge.record("call-a", { ok: false, error: "error-a", provider: "p" });
	bridge.record("call-b", { ok: false, error: "error-b", provider: "p" });

	const restoredB = pi.emit("tool_result", {
		type: "tool_result",
		toolName: "web_search",
		toolCallId: "call-b",
		input: {},
		content: [{ type: "text", text: "error-b" }],
		details: {},
		isError: true,
	});
	const restoredA = pi.emit("tool_result", {
		type: "tool_result",
		toolName: "web_search",
		toolCallId: "call-a",
		input: {},
		content: [{ type: "text", text: "error-a" }],
		details: {},
		isError: true,
	});

	assert.deepEqual(restoredB, { details: { ok: false, error: "error-b", provider: "p" } });
	assert.deepEqual(restoredA, { details: { ok: false, error: "error-a", provider: "p" } });
	assert.equal(bridge.pendingCount(), 0);
});

test("wrong tool name leaves pending details untouched", () => {
	const bridge = createToolErrorDetailsBridge("image_generate");
	const pi = mockPi();
	bridge.install(pi);

	bridge.record("call-1", { ok: false, error: "image failed" });
	const result = pi.emit("tool_result", {
		type: "tool_result",
		toolName: "web_search",
		toolCallId: "call-1",
		input: {},
		content: [{ type: "text", text: "image failed" }],
		details: {},
		isError: true,
	});

	assert.equal(result, undefined);
	assert.equal(bridge.pendingCount(), 1);

	const restored = pi.emit("tool_result", {
		type: "tool_result",
		toolName: "image_generate",
		toolCallId: "call-1",
		input: {},
		content: [{ type: "text", text: "image failed" }],
		details: {},
		isError: true,
	});
	assert.deepEqual(restored, { details: { ok: false, error: "image failed" } });
	assert.equal(bridge.pendingCount(), 0);
});

test("successful tool_result consumes pending without patching details", () => {
	const bridge = createToolErrorDetailsBridge("web_search");
	const pi = mockPi();
	bridge.install(pi);

	bridge.record("call-ok", { ok: false, error: "stale" });
	const result = pi.emit("tool_result", {
		type: "tool_result",
		toolName: "web_search",
		toolCallId: "call-ok",
		input: {},
		content: [{ type: "text", text: "ok" }],
		details: { ok: true },
		isError: false,
	});

	assert.equal(result, undefined);
	assert.equal(bridge.pendingCount(), 0);

	const second = pi.emit("tool_result", {
		type: "tool_result",
		toolName: "web_search",
		toolCallId: "call-ok",
		input: {},
		content: [{ type: "text", text: "error" }],
		details: {},
		isError: true,
	});
	assert.equal(second, undefined);
});

test("session_shutdown clears pending details", () => {
	const bridge = createToolErrorDetailsBridge("image_generate");
	const pi = mockPi();
	bridge.install(pi);

	bridge.record("call-1", { ok: false, error: "left behind" });
	bridge.record("call-2", { ok: false, error: "also left" });
	assert.equal(bridge.pendingCount(), 2);

	pi.emit("session_shutdown", { type: "session_shutdown" });
	assert.equal(bridge.pendingCount(), 0);

	const result = pi.emit("tool_result", {
		type: "tool_result",
		toolName: "image_generate",
		toolCallId: "call-1",
		input: {},
		content: [{ type: "text", text: "left behind" }],
		details: {},
		isError: true,
	});
	assert.equal(result, undefined);
});
