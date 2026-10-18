import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { transformSync } from "esbuild";
import * as piCompat from "@earendil-works/pi-ai/compat";
import { SessionManager, buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { registerResponsesCompaction, requestResponsesCompaction, serializePiMessages } from "./responses-compaction.ts";

// Execute the actual companion extension against the real package-local Pi 1.2 APIs.
// Only the socket/server is a fixture; no provider, parser, or compaction generator is mocked.
const source = readFileSync(new URL("../custom-response/custom-response.ts", import.meta.url), "utf8");
const compiled = transformSync(source, { loader: "ts", format: "cjs" }).code;
const module = { exports: {} };
new Function("require", "module", "exports", compiled)((specifier) => {
	assert.equal(specifier, "@earendil-works/pi-ai/compat");
	return piCompat;
}, module, module.exports);
let shutdown;
module.exports.default({ on(_name, handler) { shutdown = handler; } });
const adapter = piCompat.getApiProvider("custom-response");
assert.ok(adapter);

const model = {
	id: "gpt-custom-fixture", provider: "codex-fixture", api: "custom-response",
	baseUrl: "https://fixture.invalid/v1", input: ["text"], reasoning: false,
	contextWindow: 128_000, maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const artifact = { type: "compaction", id: "cmp_fixture", encrypted_content: "SEALED_FIXTURE" };
const canonicalArtifact = { type: "compaction", encrypted_content: artifact.encrypted_content };
const runtime = {
	provider: model.provider, api: model.api, model: model.id, baseUrl: model.baseUrl,
	modelConfig: model, adapter, apiKey: "fixture-key", headers: {},
};
let mode;
let requests;
let sockets;
let httpCalls;
let onNativeRequest;
let holdOpen;

class FixtureSocket extends EventTarget {
	static OPEN = 1;
	readyState = 0;
	constructor(url) {
		super();
		this.url = url;
		sockets.push(this);
		if (!holdOpen) queueMicrotask(() => this.open());
	}
	/** A socket closed while connecting never opens. */
	open() {
		if (this.readyState !== 0) return;
		this.readyState = 1;
		this.dispatchEvent(new Event("open"));
	}
	send(text) {
		const body = JSON.parse(text);
		requests.push(body);
		queueMicrotask(() => {
			const native = body.input.at(-1)?.type === "compaction_trigger";
			if (native) {
				onNativeRequest?.();
				if (mode === "early-close") { this.close(); return; }
				this.receive({ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } });
				if (mode === "disconnect") { this.close(); return; }
				if (mode === "silent") return;
				this.receive({ type: "response.output_item.done", output_index: 0, item: artifact });
				this.receive({ type: "response.completed", response: {
					id: "resp_fixture", status: "completed", output: [artifact],
					usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
				} });
			} else {
				if (mode === "summary-early-close") { this.close(); return; }
				const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
					content: [{ type: "output_text", text: "Portable fixture summary", annotations: [] }] };
				this.receive({ type: "response.output_item.done", output_index: 0, item });
				this.receive({ type: "response.completed", response: { id: "resp_summary", status: "completed", output: [item] } });
			}
		});
	}
	receive(event) { this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(event) })); }
	close() {
		if (this.readyState === 3) return;
		this.readyState = 3;
		queueMicrotask(() => this.dispatchEvent(new Event("close")));
	}
}

test.beforeEach((t) => {
	mode = "success"; requests = []; sockets = []; httpCalls = 0; onNativeRequest = undefined; holdOpen = false;
	const originalSocket = globalThis.WebSocket;
	globalThis.WebSocket = FixtureSocket;
	t.after(() => { globalThis.WebSocket = originalSocket; });
	t.mock.method(globalThis, "fetch", async () => { httpCalls++; throw new Error("HTTP is forbidden in the WebSocket fixture"); });
});
test.afterEach(() => {
	for (const socket of sockets) { assert.equal(socket.readyState, 3, "every maintenance socket must close"); }
	assert.equal(httpCalls, 0, "neither component may bypass custom-response with HTTP");
});

function nativeRequests() { return requests.filter((body) => body.input.at(-1)?.type === "compaction_trigger"); }
function summaryRequests() { return requests.filter((body) => body.input.at(-1)?.type !== "compaction_trigger"); }

function policy(t) {
	const cwd = mkdtempSync(join(tmpdir(), "codex-custom-compaction-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ codexTools: { responsesCompaction: { enabled: true, providers: [model.provider] } } }));
	t.after(() => rmSync(cwd, { recursive: true, force: true }));
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "Keep the checkpoint", timestamp: 1 });
	manager.appendMessage({ role: "assistant", provider: model.provider, api: model.api, model: model.id,
		content: [{ type: "text", text: "Work completed" }], timestamp: 2 });
	manager.appendMessage({ role: "user", content: "Continue", timestamp: 3 });
	const handlers = new Map();
	registerResponsesCompaction({
		on(name, handler) { handlers.set(name, handler); },
		getThinkingLevel() { return "off"; }, getActiveTools() { return []; }, getAllTools() { return []; },
	});
	const context = {
		cwd, model, hasUI: false, isProjectTrusted: () => true, sessionManager: manager,
		getSystemPrompt: () => "Fixture system prompt",
		modelRegistry: { getProvider: () => adapter, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: runtime.apiKey, headers: {} }) },
	};
	const compact = (signal = new AbortController().signal) => handlers.get("session_before_compact")({
		branchEntries: manager.getBranch(), signal,
		preparation: {
			firstKeptEntryId: manager.getLeafId(), tokensBefore: 100,
			messagesToSummarize: buildSessionProjection(manager.getBranch()).messages,
			turnPrefixMessages: [], isSplitTurn: false,
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 128, keepRecentTokens: 0 },
		},
	}, context);
	return { manager, compact, handlers, context };
}

test("real custom-response preparation is network-free and native events produce an artifact", async () => {
	const source = await serializePiMessages([{ role: "user", content: "hello" }], runtime);
	assert.equal(sockets.length, 0);
	const result = await requestResponsesCompaction(runtime, source, undefined);
	assert.deepEqual(result.artifact, canonicalArtifact);
	assert.equal(result.telemetry.inputTokens, 100);
	assert.equal(nativeRequests().length, 1);
	assert.equal(sockets[0].url, "wss://fixture.invalid/v1/responses");
	assert.equal(requests[0].store, false);
	assert.equal("previous_response_id" in requests[0], false);
});

test("real two-component policy persists and replays a WebSocket artifact", async (t) => {
	const { manager, compact, handlers, context } = policy(t);
	const result = await compact();
	assert.match(result.compaction.summary, /Portable fixture summary/);
	assert.deepEqual(result.compaction.details.remoteResponsesCompaction.history.at(-1), canonicalArtifact);
	assert.equal(nativeRequests().length, 1);
	assert.equal(summaryRequests().length, 1);
	const pair = result.compaction;
	manager.appendCompaction(pair.summary, pair.firstKeptEntryId, pair.tokensBefore, pair.details, true, pair.usage);
	manager.appendMessage({ role: "user", content: "After checkpoint", timestamp: 4 });
	const input = await serializePiMessages(buildSessionProjection(manager.getBranch()).messages, runtime);
	const replay = await handlers.get("before_provider_request")({ payload: { model: model.id, input } }, context);
	assert.ok(replay.input.some((item) => item.type === "compaction"));
	assert.match(JSON.stringify(replay.input), /After checkpoint/);
	assert.equal(manager.getBranch().filter((entry) => entry.type === "compaction").length, 1);
});

for (const failure of ["early-close", "disconnect"]) {
	test(`WebSocket ${failure} commits nothing and retries only the missing artifact`, async (t) => {
		const { manager, compact } = policy(t);
		mode = failure;
		assert.deepEqual(await compact(), { cancel: true });
		assert.equal(nativeRequests().length, 1, "maxRetries: 0 must suppress hidden reconnection");
		assert.equal(summaryRequests().length, 1);
		assert.equal(manager.getBranch().some((entry) => entry.type === "compaction"), false);
		mode = "success";
		assert.ok((await compact()).compaction);
		assert.equal(nativeRequests().length, 2);
		assert.equal(summaryRequests().length, 1, "completed portable projection must be reused");
	});
}

test("WebSocket summary early-close does not hide reconnection and retries only the projection", async (t) => {
	const { manager, compact } = policy(t);
	mode = "summary-early-close";
	assert.deepEqual(await compact(), { cancel: true });
	assert.equal(summaryRequests().length, 1, "maxRetries: 0 must suppress hidden summary reconnection");
	assert.equal(nativeRequests().length, 1);
	assert.equal(manager.getBranch().some((entry) => entry.type === "compaction"), false);
	mode = "success";
	assert.ok((await compact()).compaction);
	assert.equal(summaryRequests().length, 2);
	assert.equal(nativeRequests().length, 1, "completed artifact must be reused");
});

test("user cancellation closes the actual WebSocket and discards pending components", async (t) => {
	const { compact } = policy(t);
	const controller = new AbortController();
	mode = "silent";
	onNativeRequest = () => queueMicrotask(() => controller.abort(new DOMException("cancelled", "AbortError")));
	assert.deepEqual(await compact(controller.signal), { cancel: true });
	assert.equal(nativeRequests().length, 1);
	mode = "success"; onNativeRequest = undefined;
	assert.ok((await compact()).compaction);
	assert.equal(summaryRequests().length, 2, "user abort must discard the pending projection");
});

test("the absolute deadline aborts a silent WebSocket without HTTP or hidden retries", async (t) => {
	let deadline;
	t.mock.method(AbortSignal, "timeout", (milliseconds) => {
		assert.equal(milliseconds, 180_000);
		deadline = new AbortController();
		return deadline.signal;
	});
	mode = "silent";
	onNativeRequest = () => queueMicrotask(() => deadline.abort(new DOMException("deadline", "TimeoutError")));
	assert.equal(await requestResponsesCompaction(runtime, [], undefined), undefined);
	assert.equal(nativeRequests().length, 1);
});

const sessionEnds = {
	cleanup: (sessionId) => piCompat.cleanupSessionResources(sessionId),
	shutdown: (sessionId) => shutdown({}, { sessionManager: { getSessionId: () => sessionId } }),
};
const until = async (condition) => {
	// The real adapter reaches its fetch only after a few timer-driven steps.
	for (let attempt = 0; !condition(); attempt++) {
		assert.ok(attempt < 400, "condition not reached");
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
};

for (const entry of ["stream", "streamSimple"]) {
	for (const [ending, end] of Object.entries(sessionEnds)) {
		test(`real ${entry} with maxRetries 1 does not resend after ${ending} while connecting`, async () => {
			// A failed assertion must not leave sessions or retry timers for the next test.
			try {
				const context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };
				const options = (sessionId) => ({ apiKey: "fixture-key", maxRetries: 1, sessionId });
				holdOpen = true;
				const ended = adapter[entry](model, context, options("ending"));
				const other = adapter[entry](model, context, options("other"));
				await until(() => sockets.length === 2);

				// A wrongly retried request would now connect and send instead of hanging.
				holdOpen = false;
				end("ending");
				sockets[0].open();
				sockets[1].open();
				const message = await ended.result();
				assert.equal(message.stopReason, "aborted");
				assert.equal(sockets.length, 2, "the SDK retry must not reconnect after the session ended");
				assert.deepEqual(requests.length, 1, "only the other session may send");
				assert.equal((await other.result()).stopReason, "stop");

				assert.equal((await adapter[entry](model, context, options("ending")).result()).stopReason, "stop");
				assert.equal(sockets.length, 3);
			} finally {
				piCompat.cleanupSessionResources();
			}
		});
	}
}
