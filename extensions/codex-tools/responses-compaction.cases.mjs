import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { SessionManager, buildSessionProjection } from "@earendil-works/pi-coding-agent";
import { stream as streamResponses, streamSimple as streamResponsesSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { normalizeContext } from "@earendil-works/pi-ai";
import {
	buildResponsesCompactionDetails,
	buildResponsesCompactionV2History,
	captureResponsesRequestShape,
	parseResponsesCompactionDetails,
	reconstructResponsesCompactionHistory as reconstructWithRuntime,
	registerResponsesCompaction,
	requestResponsesCompaction as requestWithRuntime,
	replayResponsesCompactionPayload,
	runCompactionPair,
	serializePiMessages as serializeWithRuntime,
	serializePiMessagesForParity as serializeParityWithRuntime,
	supportsResponsesCompaction,
} from "./responses-compaction.ts";

const packageRoot = dirname(fileURLToPath(import.meta.url));
function readPackageLocalVersion(name) {
	const packageJsonPath = join(packageRoot, "node_modules", ...name.split("/"), "package.json");
	return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}
const resolvedCodingAgentVersion = readPackageLocalVersion("@earendil-works/pi-coding-agent");
const resolvedAiVersion = readPackageLocalVersion("@earendil-works/pi-ai");
assert.equal(resolvedCodingAgentVersion, "1.2.0", `package-local pi-coding-agent must be 1.2.0, got ${resolvedCodingAgentVersion}`);
assert.equal(resolvedAiVersion, "1.2.0", `package-local pi-ai must be 1.2.0, got ${resolvedAiVersion}`);
const resolvedCodingAgentUrl = pathToFileURL(join(packageRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js")).href;
assert.equal((await import.meta.resolve("@earendil-works/pi-coding-agent")), resolvedCodingAgentUrl, "pi-coding-agent must resolve from this package's node_modules");
if (typeof SessionManager.prototype.buildSessionProjection !== "function" || typeof buildSessionProjection !== "function") {
	throw new Error("Pi 1.2.0 buildSessionProjection is required for these cases");
}

const identity = {
	provider: "newapi",
	api: "openai-responses",
	model: "GPT-5.4",
	baseUrl: "https://proxy.example/v1",
};

const model = {
	provider: identity.provider,
	api: identity.api,
	id: identity.model,
	baseUrl: identity.baseUrl,
	input: ["text", "image"],
	reasoning: false,
	contextWindow: 128_000,
	maxTokens: 4096,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const adapter = { stream: streamResponses, streamSimple: streamResponsesSimple };
function runtimeFor(modelConfig = model) {
	return { ...identity, provider: modelConfig.provider, api: modelConfig.api, model: modelConfig.id,
		baseUrl: modelConfig.baseUrl, modelConfig, adapter, apiKey: "fixture-only", headers: {} };
}
const serializePiMessages = (messages, target) => serializeWithRuntime(messages, runtimeFor(target));
const serializePiMessagesForParity = (messages, target) => serializeParityWithRuntime(messages, runtimeFor(target));
const reconstructResponsesCompactionHistory = (entries, targetIdentity, target) => reconstructWithRuntime(entries, targetIdentity, runtimeFor(target));
// Only the fixture adapter installs a fetch. Production compaction never replaces transport.
const requestResponsesCompaction = (runtime, input, signal, fixtureFetch, options = {}) => {
	const selected = runtime.adapter ?? adapter;
	return requestWithRuntime({ ...runtimeFor(runtime.modelConfig), ...runtime, adapter: {
		...selected,
		stream(target, context, streamOptions) { return selected.stream(target, context, { ...streamOptions, fetch: fixtureFetch }); },
	} }, input, signal, options);
};
const settings = { enabled: true, providers: ["newapi"] };
const artifact = { type: "compaction", encrypted_content: "opaque-history" };

test("local and remote compaction start concurrently and preserve independent failures", async () => {
	const started = [];
	let releaseLocal;
	let releaseRemote;
	const localGate = new Promise((resolve) => { releaseLocal = resolve; });
	const remoteGate = new Promise((resolve) => { releaseRemote = resolve; });
	const pending = runCompactionPair(
		async () => { started.push("local"); await localGate; return "portable"; },
		async () => { started.push("remote"); await remoteGate; return "artifact"; },
	);
	await Promise.resolve();
	assert.deepEqual(started, ["local", "remote"]);
	releaseRemote(); releaseLocal();
	assert.deepEqual(await pending, { local: "portable", remote: "artifact" });
	assert.deepEqual(await runCompactionPair(async () => "portable", async () => { throw new Error("remote failed"); }), { local: "portable" });
	assert.deepEqual(await runCompactionPair(async () => { throw new Error("local failed"); }, async () => "artifact"), { remote: "artifact" });
});
const retainedUser = {
	type: "message",
	role: "user",
	content: [{ type: "input_text", text: "retained user" }],
};

function remoteDetails(history = [retainedUser, artifact]) {
	return {
		kind: "codex-tools.responses-compaction",
		version: 2,
		identity,
		history,
	};
}

test("Responses compaction gating requires every fixed condition", () => {
	assert.equal(supportsResponsesCompaction(model, settings), true);
	assert.equal(supportsResponsesCompaction({ ...model, api: "custom-response" }, settings), true);
	assert.equal(supportsResponsesCompaction({ ...model, provider: "NewAPI" }, settings), false);
	assert.equal(supportsResponsesCompaction({ ...model, api: "openai-codex-responses" }, settings), false);
	assert.equal(supportsResponsesCompaction({ ...model, id: "claude-4" }, settings), false);
	assert.equal(supportsResponsesCompaction(model, { enabled: false, providers: ["newapi"] }), false);
	assert.equal(supportsResponsesCompaction({ ...model, baseUrl: "https://user:secret@proxy.example/v1" }, settings), false);
	assert.equal(supportsResponsesCompaction({ ...model, baseUrl: "https://proxy.example/v1?token=secret" }, settings), false);
});

test("serializer delegates to the configured provider without dispatching", async () => {
	const input = await serializePiMessages([
		{ role: "user", content: [{ type: "text", text: "inspect this" }, { type: "image", data: "AAAA", mimeType: "image/png" }] },
		{ role: "assistant", provider: identity.provider, api: identity.api, model: identity.model, content: [
			{ type: "thinking", thinking: "plan", thinkingSignature: JSON.stringify({ type: "reasoning", encrypted_content: "encrypted", summary: [] }) },
			{ type: "text", text: "I will inspect it." },
			{ type: "toolCall", id: "call-1|fc_item", name: "read", arguments: { path: "a.txt" } },
		] },
		{ role: "toolResult", toolCallId: "call-1|fc_item", content: [{ type: "text", text: "contents" }], isError: false },
	], model);
	assert.deepEqual(input, [
		{ role: "user", content: [
			{ type: "input_text", text: "inspect this" },
			{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
		] },
		{ type: "reasoning", encrypted_content: "encrypted", summary: [] },
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "I will inspect it.", annotations: [] }], status: "completed", id: "msg_pi_1" },
		{ type: "function_call", id: "fc_item", call_id: "call-1", name: "read", arguments: '{"path":"a.txt"}' },
		{ type: "function_call_output", call_id: "call-1", output: "contents" },
	]);
});

test("serializer removes private reasoning when only the assistant API differs", async () => {
	const serialized = await serializePiMessages([{ role: "assistant", provider: identity.provider, api: "other-api", model: identity.model, content: [
		{ type: "thinking", thinking: "private-api-reasoning", thinkingSignature: JSON.stringify({ type: "reasoning", encrypted_content: "private", summary: [] }) },
		{ type: "text", text: "portable answer", textSignature: "private-text-signature" },
	] }], model);
	const encoded = JSON.stringify(serialized);
	assert.equal(encoded.includes("portable answer"), true);
	assert.equal(encoded.includes("private-api-reasoning"), false);
	assert.equal(encoded.includes("private-text-signature"), false);
	assert.equal(encoded.includes('"type":"reasoning"'), false);
});

test("outbound parity retains foreign thinking for replay while provider history strips private signatures", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-compact-parity-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ codexTools: { responsesCompaction: { enabled: true, providers: [identity.provider] } } }));
	try {
		const foreignAssistant = { role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "claude", content: [
			{ type: "thinking", thinking: "foreign private reasoning", thinkingSignature: "foreign-private-signature" },
			{ type: "text", text: "foreign answer", textSignature: "foreign-text-signature" },
		] };
		const messageParity = await serializePiMessagesForParity([foreignAssistant], model);
		assert.deepEqual(messageParity, [
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "foreign private reasoning", annotations: [] }], status: "completed", id: "msg_pi_0" },
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "foreign answer", annotations: [] }], status: "completed", id: "msg_pi_0_1" },
		]);
		const providerHistory = await serializePiMessages([foreignAssistant], model);
		assert.deepEqual(providerHistory, [
			{ type: "message", role: "assistant", content: [{ type: "output_text", text: "foreign answer", annotations: [] }], status: "completed", id: "msg_pi_0" },
		]);
		assert.equal(JSON.stringify(providerHistory).includes("foreign-private-signature"), false);
		assert.equal(JSON.stringify(providerHistory).includes("foreign-text-signature"), false);

		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "checkpoint", timestamp: Date.now() });
		const firstKeptEntryId = manager.getLeafId();
		manager.appendCompaction("portable summary", firstKeptEntryId, 1, { remoteResponsesCompaction: remoteDetails() }, true);
		manager.appendMessage({ ...foreignAssistant, timestamp: Date.now() });
		const projection = buildSessionProjection(manager.getBranch());
		const expectedSessionInput = await serializePiMessagesForParity(projection.messages, model);
		const history = await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model);
		assert.ok(expectedSessionInput);
		assert.ok(history);
		assert.equal(JSON.stringify(expectedSessionInput).includes("foreign private reasoning"), true);
		assert.equal(JSON.stringify(history).includes("foreign private reasoning"), false);
		assert.equal(JSON.stringify(history).includes("foreign answer"), true);

		const handlers = new Map();
		registerResponsesCompaction({
			on(name, handler) { handlers.set(name, handler); },
			getThinkingLevel() { return "off"; },
		});
		const context = {
			cwd,
			isProjectTrusted: () => true,
			hasUI: false,
			ui: { notify() {} },
			model,
			modelRegistry: { getProvider: () => adapter, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) },
			sessionManager: {
				getBranch: () => manager.getBranch(),
			},
		};
		const payload = {
			model: identity.model,
			input: [{ role: "developer", content: "observed system" }, ...expectedSessionInput],
		};
		assert.deepEqual(await handlers.get("before_provider_request")({ payload }, context), {
			...payload,
			input: [{ role: "developer", content: "observed system" }, ...history],
		});
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("serializer returns undefined when the provider rejects input", async () => {
	assert.equal(await serializePiMessages([
		{ role: "toolResult", toolCallId: "call-1", content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] },
	], { ...model, input: undefined }), undefined);
});

test("v2 replacement history retains newest real users before the terminal artifact", () => {
	const longText = "x".repeat(90_000);
	const history = buildResponsesCompactionV2History([
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "ignore assistant" }] },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "older user" }] },
		{ type: "message", role: "user", content: [
			{ type: "input_text", text: longText },
			{ type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" },
		] },
	], artifact);
	assert.equal(history.length, 2);
	assert.deepEqual(history.at(-1), artifact);
	assert.equal(history[0].role, "user");
	assert.equal(history[0].content[0].text.length, 80_000);
	assert.deepEqual(history[0].content[1], { type: "input_image", detail: "auto", image_url: "data:image/png;base64,AAAA" });
});

test("retained history enforces a cumulative one MiB image-part budget", () => {
	const oversizedImage = `data:image/png;base64,${"A".repeat(1024 * 1024)}`;
	const oversized = buildResponsesCompactionV2History([{ type: "message", role: "user", content: [
		{ type: "input_text", text: "keep text" },
		{ type: "input_image", detail: "auto", image_url: oversizedImage },
	] }], artifact);
	assert.deepEqual(oversized[0].content, [{ type: "input_text", text: "keep text" }]);

	const olderImage = `data:image/png;base64,${"B".repeat(600 * 1024)}`;
	const newerImage = `data:image/png;base64,${"C".repeat(600 * 1024)}`;
	const cumulative = buildResponsesCompactionV2History([
		{ type: "message", role: "user", content: [{ type: "input_text", text: "older" }, { type: "input_image", detail: "auto", image_url: olderImage }] },
		{ type: "message", role: "user", content: [{ type: "input_text", text: "newer" }, { type: "input_image", detail: "auto", image_url: newerImage }] },
	], artifact);
	const retainedImages = cumulative.slice(0, -1).flatMap((item) => item.content.filter((part) => part.type === "input_image"));
	assert.equal(retainedImages.length, 1);
	assert.equal(retainedImages[0].image_url, newerImage);
	assert.equal(JSON.stringify(cumulative).includes("older"), true);
	assert.equal(JSON.stringify(cumulative).includes("newer"), true);
});

function sseResponse(events) {
	return new Response(events.map((event) => "data: " + JSON.stringify(event) + "\n\n").join(""), { headers: { "Content-Type": "text/event-stream" } });
}

function compactionEvents(item = artifact) {
	return [
		{ type: "response.output_item.done", output_index: 0, item },
		{ type: "response.completed", response: { status: "completed", output: [item] } },
	];
}

test("public provider events validate one completed artifact without mutating or persisting extra fields", async () => {
	const item = { ...artifact, apiKey: "echoed-secret", headers: { authorization: "echoed-secret" } };
	const events = compactionEvents(item);
	const before = JSON.stringify(events);
	const result = await requestResponsesCompaction(runtimeFor(), [], undefined, async () => sseResponse(events));
	assert.deepEqual(result.artifact, artifact);
	assert.equal(JSON.stringify(events), before);
	assert.doesNotMatch(JSON.stringify(result), /echoed-secret|authorization/);
	const completionOnly = await requestResponsesCompaction(runtimeFor(), [], undefined, async () => sseResponse([compactionEvents()[1]]));
	assert.deepEqual(completionOnly.artifact, artifact, "terminal output is authoritative even without an item-done event");
});

test("missing, incomplete, duplicate, mismatched, and over-budget provider artifacts are rejected", async () => {
	const [done, completed] = compactionEvents();
	const cases = [
		[done],
		[done, { type: "response.incomplete", response: { status: "incomplete", output: [artifact] } }],
		[done, { type: "response.completed", response: { status: "failed", output: [artifact] } }],
		[done, { type: "response.completed", response: { status: "completed", output: [] } }],
		[done, { type: "response.completed", response: { status: "completed", output: [artifact, artifact] } }],
		[done, { type: "response.completed", response: { status: "completed", output: [{ ...artifact, encrypted_content: "different" }] } }],
		[done, done, completed],
		[completed, completed],
		compactionEvents({ type: "compaction", encrypted_content: "" }),
		[{ type: "response.created", padding: "x".repeat(40 * 1024 * 1024) }, done, completed],
	];
	for (const events of cases) {
		assert.equal(await requestResponsesCompaction(runtimeFor(), [], undefined, async () => sseResponse(events)), undefined);
	}
});

test("details persistence strips runtime authentication and model configuration", () => {
	const details = buildResponsesCompactionDetails({ ...identity, apiKey: "secret", headers: { Authorization: "Bearer secret" }, modelConfig: { hidden: true } }, artifact, [retainedUser]);
	assert.deepEqual(details.identity, identity);
	assert.equal("apiKey" in details.identity, false);
	assert.equal("headers" in details.identity, false);
	assert.equal("modelConfig" in details.identity, false);
	const artifactWithExtras = { ...artifact, apiKey: "echoed-secret", headers: { authorization: "echoed-secret" } };
	assert.deepEqual(buildResponsesCompactionDetails(identity, artifactWithExtras, [retainedUser]).history.at(-1), artifact);
	const oversizedArtifact = { type: "compaction", encrypted_content: "€".repeat(Math.floor((42 * 1024 * 1024) / 3) + 1) };
	assert.equal(buildResponsesCompactionDetails(identity, oversizedArtifact, [retainedUser]), undefined);
});

test("details validation requires one terminal artifact and only preceding user messages", () => {
	assert.deepEqual(parseResponsesCompactionDetails(remoteDetails()), remoteDetails());
	assert.deepEqual(parseResponsesCompactionDetails({ ...remoteDetails(), telemetry: { inputTokens: 10, outputTokens: 3, totalTokens: 13, latencyMs: 20 } }).telemetry, { inputTokens: 10, outputTokens: 3, totalTokens: 13, latencyMs: 20 });
	assert.deepEqual(parseResponsesCompactionDetails(remoteDetails([{ ...retainedUser, extra: "drop", content: [{ type: "input_text", text: "retained user", extra: "drop" }] }, artifact])).history, [retainedUser, artifact]);
	assert.deepEqual(parseResponsesCompactionDetails(remoteDetails([retainedUser, { ...artifact, apiKey: "echoed-secret", headers: { authorization: "echoed-secret" } }])).history, [retainedUser, artifact]);
	assert.equal(parseResponsesCompactionDetails({ ...remoteDetails(), history: [artifact, retainedUser] }), undefined);
	assert.equal(parseResponsesCompactionDetails({ ...remoteDetails(), history: [retainedUser, artifact, artifact] }), undefined);
	assert.equal(parseResponsesCompactionDetails({ ...remoteDetails(), history: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "no" }] }, artifact] }), undefined);
	assert.equal(parseResponsesCompactionDetails({ ...remoteDetails(), identity: { ...identity, baseUrl: "" } }), undefined);
	assert.equal(parseResponsesCompactionDetails({ ...remoteDetails(), identity: { ...identity, baseUrl: "https://user:secret@proxy.example/v1" } }), undefined);
	assert.equal(parseResponsesCompactionDetails(remoteDetails([{ type: "message", role: "user", content: [{ type: "input_text", text: "x".repeat(80_001) }] }, artifact])), undefined);
	assert.equal(parseResponsesCompactionDetails(remoteDetails([{ type: "message", role: "user", content: [{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${"A".repeat(1024 * 1024)}` }] }, artifact])), undefined);
});

test("reconstruction starts at the checkpoint, appending only live tail converted by Pi", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage({ role: "user", content: "checkpoint-before", timestamp: Date.now() });
	manager.appendMessage({ role: "assistant", provider: identity.provider, api: identity.api, model: identity.model, content: [{ type: "text", text: "old answer" }], timestamp: Date.now() });
	const firstKeptEntryId = manager.getLeafId();
	manager.appendCompaction("portable summary", firstKeptEntryId, 1, { remoteResponsesCompaction: remoteDetails() }, true);
	manager.appendMessage({ role: "user", content: "next", timestamp: Date.now() });
	manager.appendMessage({ role: "assistant", provider: "anthropic", api: "anthropic-messages", model: "claude", content: [
		{ type: "thinking", thinking: "provider-private", thinkingSignature: "private-signature" },
		{ type: "text", text: "cross-provider answer" },
	], timestamp: Date.now() });
	manager.appendMessage({ role: "assistant", provider: identity.provider, api: identity.api, model: identity.model, content: [{ type: "toolCall", id: "call-1|fc_item", name: "read", arguments: { path: "a.txt" } }], timestamp: Date.now() });
	manager.appendMessage({ role: "toolResult", toolCallId: "call-1|fc_item", content: [{ type: "text", text: "contents" }], isError: false, timestamp: Date.now() });
	manager.appendCustomMessageEntry("goal", "remember the injected goal", false);

	assert.deepEqual(manager.buildContextEntries().map((entry) => entry.type), ["compaction", "message", "message", "message", "message", "message", "custom_message"]);
	const history = await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model);
	assert.deepEqual(history, [
		retainedUser,
		artifact,
		{ role: "user", content: [{ type: "input_text", text: "next" }] },
		{ type: "message", role: "assistant", content: [{ type: "output_text", text: "cross-provider answer", annotations: [] }], status: "completed", id: "msg_pi_1" },
		{ type: "function_call", id: "fc_item", call_id: "call-1", name: "read", arguments: '{"path":"a.txt"}' },
		{ type: "function_call_output", call_id: "call-1", output: "contents" },
		{ role: "user", content: [{ type: "input_text", text: "remember the injected goal" }] },
	]);
	assert.equal(JSON.stringify(history).includes("checkpoint-before"), false);
	assert.equal(await reconstructResponsesCompactionHistory(manager.getBranch(), { ...identity, model: "gpt-5.5" }, model), undefined);
});

test("replay requires exact session parity and retains only the provider system prefix", () => {
	const expectedSessionInput = [{ role: "user", content: "duplicate" }];
	assert.deepEqual(replayResponsesCompactionPayload({
		model: identity.model,
		input: [
			{ role: "developer", content: "system" },
			{ role: "user", content: "duplicate" },
		],
	}, [retainedUser, artifact], expectedSessionInput, identity.model), {
		model: identity.model,
		input: [{ role: "developer", content: "system" }, retainedUser, artifact],
	});
	assert.equal(replayResponsesCompactionPayload({
		model: identity.model,
		input: [{ role: "user", content: "context hook changed this" }],
	}, [retainedUser, artifact], expectedSessionInput, identity.model), undefined);
	assert.equal(replayResponsesCompactionPayload({
		model: "other-model",
		input: expectedSessionInput,
	}, [retainedUser, artifact], expectedSessionInput, identity.model), undefined);
});

test("request-shape capture retains only bounded JSON-safe semantic fields", () => {
	const reasoning = { effort: "high" };
	const text = { verbosity: "low" };
	const tools = [{ type: "function", name: "read", parameters: { type: "object" } }];
	const shape = captureResponsesRequestShape({
		model: identity.model,
		instructions: "system prompt",
		input: [{ role: "developer", content: "prefix" }, { role: "user", content: "session" }],
		tools,
		tool_choice: "auto",
		parallel_tool_calls: true,
		reasoning,
		text,
		apiKey: "secret",
	}, identity);
	reasoning.effort = "low";
	assert.deepEqual(shape, {
		identity,
		instructions: "system prompt",
		inputPrefix: [{ role: "developer", content: "prefix" }],
		tools,
		toolChoice: "auto",
		parallelToolCalls: true,
		reasoning: { effort: "high" },
		text: { verbosity: "low" },
	});
	assert.deepEqual(captureResponsesRequestShape({ reasoning: "invalid", text: { bad: undefined } }, identity), { identity });
	assert.equal(captureResponsesRequestShape({ model: "other" }, identity), undefined);
});

function completedCompactionResponse() {
	return new Response(`data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [artifact] } })}\n\n`, { headers: { "Content-Type": "text/event-stream" } });
}

test("configured custom-response adapter owns conversion, endpoint, environment, and payload transforms", async () => {
	let adapterCalls = 0;
	let dispatches = 0;
	const customModel = { ...model, api: "custom-response", samplingParams: { gateway_sampling: "preserved" } };
	const runtime = {
		...runtimeFor(customModel),
		apiKey: "resolved-key",
		headers: { "X-Resolved": "auth-header", Authorization: null },
		env: { GATEWAY_ORIGIN: "https://custom.example/tenant/v2", GATEWAY_POLICY: "configured" },
		adapter: {
			stream(target, context, options) {
				adapterCalls++;
				assert.equal(options.apiKey, "resolved-key");
				assert.equal(options.env.GATEWAY_POLICY, "configured");
				assert.equal(options.transport, undefined, "compaction must not force the provider transport");
				assert.equal(options.maxRetries, 0);
				return streamResponses({ ...target, baseUrl: options.env.GATEWAY_ORIGIN }, context, {
					...options,
					headers: { ...options.headers, "X-Adapter": "transformed" },
					onPayload(payload) {
						const input = payload.input.map((item) => item.role === "user" ? {
							...item, content: item.content.map((part) => part.type === "input_text" ? { ...part, text: `encoded:${part.text}` } : part),
						} : item);
						return options.onPayload({ ...payload, input, gateway_policy: options.env.GATEWAY_POLICY, previous_response_id: "must-not-continue" });
					},
				});
			},
		},
	};
	const messages = [{ role: "user", content: "hello" }];
	const source = await serializeWithRuntime(messages, runtime);
	assert.equal(source[0].content[0].text, "encoded:hello", "history must use this adapter's conversion, not a built-in converter");
	const result = await requestResponsesCompaction(runtime, source, undefined, async (url, options) => {
		dispatches++;
		assert.equal(url, "https://custom.example/tenant/v2/responses");
		const headers = new Headers(options.headers);
		assert.equal(headers.get("X-Resolved"), "auth-header");
		assert.equal(headers.get("X-Adapter"), "transformed");
		assert.equal(headers.has("Authorization"), false);
		const body = JSON.parse(options.body);
		assert.deepEqual(body.input, [...source, { type: "compaction_trigger" }]);
		assert.equal(body.gateway_sampling, "preserved");
		assert.equal(body.gateway_policy, "configured");
		assert.equal(body.store, false);
		assert.equal("previous_response_id" in body, false);
		return completedCompactionResponse();
	}, { context: normalizeContext({ messages }) });
	assert.equal(adapterCalls, 2, "preparation and execution must both use the selected adapter");
	assert.equal(dispatches, 1, "preparation must never produce a billable request");
	assert.deepEqual(result.artifact, artifact);
});

test("an adapter that omits public events fails instead of using a raw-fetch bypass", async () => {
	let dispatches = 0;
	const runtime = { ...runtimeFor(), adapter: {
		stream(target, context, options) {
			assert.equal("fetch" in options, false, "production compaction must not replace provider transport");
			return streamResponses(target, context, { ...options, onProviderStreamEvent: undefined, fetch: async () => {
				dispatches++;
				return completedCompactionResponse();
			} });
		},
	} };
	assert.equal(await requestWithRuntime(runtime, [], undefined), undefined);
	assert.equal(dispatches, 1, "no hidden retries or alternative request path");
});

test("caller cancellation stops the provider-owned compaction stream", { timeout: 2000 }, async () => {
	const controller = new AbortController();
	let transportCancelled = false;
	const result = requestResponsesCompaction(runtimeFor(), [], controller.signal, async (_url, options) => {
		const body = new ReadableStream({
			start(streamController) {
				streamController.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "response.output_item.done", item: artifact })}\n\n`));
				options.signal.addEventListener("abort", () => {
					transportCancelled = true;
					streamController.error(options.signal.reason);
				}, { once: true });
				queueMicrotask(() => controller.abort(new DOMException("user cancelled", "AbortError")));
			},
		});
		return new Response(body);
	});
	await assert.rejects(result, { name: "AbortError", message: "user cancelled" });
	assert.equal(transportCancelled, true);
});

test("remote request uses the current Responses endpoint and v2 body", async () => {
	let url;
	let body;
	const result = await requestResponsesCompaction({ ...identity, headers: { Authorization: "Bearer resolved" }, modelConfig: model }, [{ role: "user", content: [{ type: "input_text", text: "hello" }] }], undefined, async (requestUrl, options) => {
		url = requestUrl;
		body = JSON.parse(options.body);
		return new Response([
			'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed"}}',
			"",
			'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":"sealed"}],"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13}}}',
			"",
		].join("\n") + "\n", { headers: { "content-type": "text/event-stream" } });
	}, {
		instructions: "system prompt",
		inputPrefix: [{ role: "developer", content: "prefix" }],
		tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
		toolChoice: "auto",
		parallelToolCalls: true,
		reasoning: { effort: "high" },
		text: { verbosity: "low" },
	});
	assert.equal(url, "https://proxy.example/v1/responses");
	assert.deepEqual(body, {
		model: "GPT-5.4",
		input: [{ role: "developer", content: "prefix" }, { role: "user", content: [{ type: "input_text", text: "hello" }] }, { type: "compaction_trigger" }],
		stream: true,
		store: false,
		include: ["reasoning.encrypted_content"],
		instructions: "system prompt",
		tools: [{ type: "function", name: "read", parameters: { type: "object" } }],
		tool_choice: "auto",
		parallel_tool_calls: true,
		reasoning: { effort: "high" },
		text: { verbosity: "low" },
	});
	assert.deepEqual(result.artifact, { type: "compaction", encrypted_content: "sealed" });
	assert.deepEqual({ ...result.telemetry, latencyMs: 0 }, { inputTokens: 10, outputTokens: 3, totalTokens: 13, latencyMs: 0 });
});

test("remote compaction sends the full envelope without local capacity estimation", async () => {
	let fetchCalls = 0;
	let sent;
	const runtime = { ...identity, headers: { Authorization: "Bearer SECRET" }, modelConfig: { ...model, contextWindow: 1 } };
	const source = [{ role: "user", content: [{ type: "input_text", text: "hello" }] }];
	const tools = [{ type: "function", name: "read", description: "private description ".repeat(2_000), parameters: { type: "object" } }];
	const fetch = async (_url, options) => {
		fetchCalls++;
		sent = JSON.parse(options.body);
		return new Response('data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed"}}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":"sealed"}]}}\n\n');
	};
	const result = await requestResponsesCompaction(runtime, source, undefined, fetch, { tools, instructions: "system" });
	assert.equal(fetchCalls, 1);
	assert.deepEqual(sent.input, [...source, { type: "compaction_trigger" }]);
	assert.deepEqual(sent.tools, tools);
	assert.equal(sent.instructions, "system");
	assert.equal("reserveTokens" in sent, false);
	assert.equal("requestBudget" in sent, false);
	assert.equal("requestBudget" in result.telemetry, false);
	assert.doesNotMatch(JSON.stringify(result.telemetry), /SECRET|private description|hello/);
	const details = buildResponsesCompactionDetails(identity, result.artifact, source, result.telemetry);
	assert.deepEqual(parseResponsesCompactionDetails({ ...details, telemetry: { ...result.telemetry, requestBudget: { obsolete: true } } }).telemetry, result.telemetry, "old extra telemetry does not invalidate a persisted checkpoint");
});

test("remote fetch does not charge request serialization against its network deadline", async (t) => {
	let clock = 0;
	let expiresAt;
	let deadline;
	let fetchSignal;
	let abortedAtFetch;
	t.mock.method(AbortSignal, "timeout", (milliseconds) => {
		deadline = new AbortController();
		expiresAt = clock + milliseconds;
		return deadline.signal;
	});
	const source = [{
		toJSON() {
			clock += 180_001; // Exceed the transport deadline without a real three-minute wait.
			if (deadline && clock >= expiresAt) deadline.abort(new DOMException("network deadline expired", "TimeoutError"));
			return { role: "user", content: [] };
		},
	}];
	const runtime = { ...identity, headers: {}, modelConfig: model };
	const result = await requestResponsesCompaction(runtime, source, undefined, async (_url, options) => {
		fetchSignal = options.signal;
		abortedAtFetch = fetchSignal.aborted;
		options.signal.throwIfAborted();
		return new Response('data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"sealed"}}\n\ndata: {"type":"response.completed","response":{"status":"completed","output":[{"type":"compaction","encrypted_content":"sealed"}]}}\n\n');
	});
	assert.equal(clock, 180_001);
	assert.equal(abortedAtFetch, false, "serialization must leave the full fetch deadline available");
	assert.equal(fetchSignal.aborted, true, "the owned signal is closed after the request finishes");
	assert.equal(expiresAt, 360_001);
	assert.equal(result.artifact.encrypted_content, "sealed");
});

test("remote requests propagate caller cancellation instead of returning an artifact miss", async () => {
	const runtime = { ...identity, headers: {}, modelConfig: model };
	let fetchCalls = 0;
	const fetch = async () => { fetchCalls++; throw new Error("must not fetch"); };
	await assert.rejects(() => requestResponsesCompaction(runtime, [], AbortSignal.abort(), fetch), { name: "AbortError" });
	assert.equal(fetchCalls, 0);
	const controller = new AbortController();
	await assert.rejects(() => requestResponsesCompaction(runtime, [], controller.signal, async (_url, options) => {
		fetchCalls++;
		controller.abort(new DOMException("request canceled", "AbortError"));
		options.signal.throwIfAborted();
	}), { name: "AbortError", message: "request canceled" });
	assert.equal(fetchCalls, 1);
});

test("remote outbound fetch drops ProviderHeaders null deletion markers and keeps gateway headers", async () => {
	let captured;
	const runtime = {
		...identity,
		apiKey: "fallback-key",
		modelConfig: model,
		headers: {
			Authorization: null,
			"x-api-key": null,
			"cf-aig-authorization": "Bearer gateway-token",
			"X-Test": "kept",
		},
	};
	await requestResponsesCompaction(runtime, [{ role: "user", content: [] }], undefined, async (_url, options) => {
		const headers = new Headers(options.headers);
		captured = {
			has: (name) => headers.has(name),
			get: (name) => headers.get(name),
			values: () => [...headers.values()],
		};
		return new Response("unsupported", { status: 400 });
	});
	assert.ok(captured, "compaction must issue an outbound fetch");
	assert.equal(captured.has("Authorization"), false);
	assert.equal(captured.has("x-api-key"), false);
	assert.equal(captured.get("cf-aig-authorization"), "Bearer gateway-token");
	assert.equal(captured.get("X-Test"), "kept");
	assert.equal(captured.values().includes("null"), false);
});

test("remote outbound fetch adds Authorization Bearer when headers are empty", async () => {
	let authorization;
	const runtime = { ...identity, headers: {}, apiKey: "fallback-key", modelConfig: model };
	await requestResponsesCompaction(runtime, [{ role: "user", content: [] }], undefined, async (_url, options) => {
		authorization = new Headers(options.headers).get("Authorization");
		return new Response("unsupported", { status: 400 });
	});
	assert.equal(authorization, "Bearer fallback-key");
});

test("remote HTTP, deadline, and stream-read failures return undefined and clean up the reader", async () => {
	let headers;
	const runtime = { ...identity, headers: { "x-proxy-auth": "resolved" }, apiKey: "key", modelConfig: model };
	const httpResult = await requestResponsesCompaction(runtime, [{ role: "user", content: [] }], undefined, async (_url, options) => {
		headers = options.headers;
		return new Response("unsupported", { status: 400 });
	});
	assert.equal(httpResult, undefined);
	assert.equal(new Headers(headers).has("x-codex-beta-features"), false);
	assert.equal(new Headers(headers).get("Authorization"), "Bearer key");

	const failedBody = new ReadableStream({
		pull(controller) { controller.error(new Error("stream failed")); },
	});
	const readFailure = await requestResponsesCompaction(runtime, [], undefined, async () => new Response(failedBody));
	assert.equal(readFailure, undefined);

	const originalTimeout = AbortSignal.timeout;
	AbortSignal.timeout = () => AbortSignal.abort();
	try {
		let fetchCalls = 0;
		const timeoutResult = await requestResponsesCompaction(runtime, [], undefined, async () => {
			fetchCalls++;
			throw new Error("must not dispatch after deadline");
		});
		assert.equal(timeoutResult, undefined);
		assert.equal(fetchCalls, 0);
	} finally {
		AbortSignal.timeout = originalTimeout;
	}
});

test("both generators use the configured adapter and auth-resolved endpoint", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-compact-provider-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ codexTools: { responsesCompaction: settings } }));
	try {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "preserve the provider contract", timestamp: 1 });
		manager.appendMessage({ role: "assistant", provider: model.provider, api: model.api, model: model.id, content: [{ type: "text", text: "work completed" }], timestamp: 2 });
		manager.appendMessage({ role: "user", content: "continue", timestamp: 3 });
		const branchEntries = manager.getBranch();
		const preparation = {
			messagesToSummarize: buildSessionProjection(branchEntries).messages,
			turnPrefixMessages: [], isSplitTurn: false, tokensBefore: 100,
			firstKeptEntryId: manager.getLeafId(),
			fileOps: { read: new Set(), written: new Set(), edited: new Set() },
			settings: { enabled: true, reserveTokens: 128, keepRecentTokens: 0 },
		};
		const calls = [];
		const fetch = async (url, options) => {
			const body = JSON.parse(options.body);
			calls.push({ url, headers: new Headers(options.headers), body });
			if (body.input.at(-1)?.type === "compaction_trigger") return completedCompactionResponse();
			const item = { id: "summary", type: "message", role: "assistant", content: [{ type: "output_text", text: "Portable provider summary", annotations: [] }] };
			return new Response(`data: ${JSON.stringify({ type: "response.output_item.done", output_index: 0, item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { status: "completed", output: [item] } })}\n\n`);
		};
		let simpleCalls = 0;
		const selectedAdapter = {
			stream: streamResponses,
			streamSimple(target, context, options) {
				simpleCalls++;
				assert.equal(options.env.PROVIDER_SCOPE, "resolved-env");
				assert.equal(options.maxRetries, 0, "portable projection must not hide transport retries");
				return streamResponsesSimple(target, context, { ...options, fetch });
			},
		};
		const handlers = new Map();
		registerResponsesCompaction({
			on(name, handler) { handlers.set(name, handler); },
			getThinkingLevel() { return "off"; },
			getActiveTools() { return []; },
			getAllTools() { return []; },
		}, { request: (runtime, source, signal, options) => requestResponsesCompaction(runtime, source, signal, fetch, options) });
		const result = await handlers.get("session_before_compact")({ preparation, branchEntries, signal: new AbortController().signal }, {
			cwd, isProjectTrusted: () => true, hasUI: false, model,
			modelRegistry: {
				getProvider: () => selectedAdapter,
				getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "resolved-key", baseUrl: "https://resolved.example/v3", headers: { "X-Auth": "resolved" }, env: { PROVIDER_SCOPE: "resolved-env" } }),
			},
			getSystemPrompt: () => "system",
			sessionManager: manager,
		});
		assert.ok(result.compaction, "the real Pi summary generator and native artifact must both complete");
		assert.match(result.compaction.summary, /Portable provider summary/);
		assert.equal(result.compaction.details.remoteResponsesCompaction.identity.baseUrl, "https://resolved.example/v3");
		assert.equal(simpleCalls, 1);
		assert.equal(calls.length, 2, "preparation does not dispatch, and each generator makes one request");
		for (const call of calls) {
			assert.equal(call.url, "https://resolved.example/v3/responses");
			assert.equal(call.headers.get("Authorization"), "Bearer resolved-key");
			assert.equal(call.headers.get("X-Auth"), "resolved");
		}
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("registered hook retains a successful component and retries only the missing component", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-compact-pending-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ codexTools: { responsesCompaction: { enabled: true, providers: [identity.provider] } } }));
	try {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const branchEntries = manager.getBranch();
		const handlers = new Map();
		let localCalls = 0;
		let remoteCalls = 0;
		let remoteSucceeds = false;
		let remoteOptions;
		let remoteSource;
		registerResponsesCompaction({
			on(name, handler) { handlers.set(name, handler); },
			getThinkingLevel() { return "off"; },
			getActiveTools() { return []; },
			getAllTools() { return []; },
		}, {
			compact: async () => {
				localCalls++;
				return { summary: "portable", firstKeptEntryId: "kept", tokensBefore: 100 };
			},
			request: async (_runtime, source, _signal, options) => {
				remoteCalls++;
				remoteSource = source;
				remoteOptions = options;
				return remoteSucceeds ? { artifact, telemetry: { latencyMs: 10 } } : undefined;
			},
		});
		const context = {
			cwd,
			isProjectTrusted: () => true,
			hasUI: false,
			ui: { notify() {} },
			model,
			modelRegistry: { getProvider: () => adapter, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) },
			getSystemPrompt: () => "system",
			sessionManager: {
				getSessionId: () => "session-1",
				getBranch: () => manager.getBranch(),
			},
		};
		await handlers.get("before_provider_request")({ payload: {
			model: identity.model,
			input: [{ role: "developer", content: "observed system" }, { role: "user", content: [{ type: "input_text", text: "hello" }] }],
			tools: [],
		} }, context);
		const event = { preparation: { firstKeptEntryId: "kept", tokensBefore: 100 }, branchEntries, signal: new AbortController().signal };
		assert.deepEqual(await handlers.get("session_before_compact")(event, context), { cancel: true });
		assert.equal(localCalls, 1);
		assert.equal(remoteCalls, 1);
		assert.equal(remoteOptions.instructions, undefined, "observed input prefix must suppress reconstructed duplicate instructions");
		assert.deepEqual(remoteOptions.inputPrefix, [{ role: "developer", content: "observed system" }]);
		assert.equal(JSON.stringify(remoteSource).includes("hello"), true);

		remoteSucceeds = true;
		const completed = await handlers.get("session_before_compact")(event, context);
		assert.equal(localCalls, 1, "portable projection should be reused");
		assert.equal(remoteCalls, 2);
		assert.equal(completed.compaction.summary, "portable");
		assert.deepEqual(completed.compaction.details.remoteResponsesCompaction.telemetry, { latencyMs: 10 });

		manager.appendContextEdit(manager.getLeafId(), { content: "hello-edited" });
		remoteCalls = 0;
		localCalls = 0;
		const invalidated = await handlers.get("session_before_compact")({
			...event,
			branchEntries: manager.getBranch(),
		}, context);
		assert.equal(localCalls, 1, "context edit must invalidate pending fingerprint");
		assert.equal(remoteCalls, 1);
		assert.equal(invalidated.compaction.summary, "portable");
		assert.equal(JSON.stringify(remoteSource).includes("hello-edited"), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

for (const [label, blank] of [["empty", ""], ["whitespace-only", " \n\t "]]) {
	test(`${label} portable projection summary is a local failure that retains the artifact`, async () => {
		const cwd = mkdtempSync(join(tmpdir(), "codex-compact-blank-"));
		mkdirSync(join(cwd, ".pi"));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ codexTools: { responsesCompaction: { enabled: true, providers: [identity.provider] } } }));
		try {
			const manager = SessionManager.inMemory();
			manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
			const handlers = new Map();
			let summary = blank;
			let localCalls = 0;
			let remoteCalls = 0;
			registerResponsesCompaction({
				on(name, handler) { handlers.set(name, handler); },
				getThinkingLevel() { return "off"; },
				getActiveTools() { return []; },
				getAllTools() { return []; },
			}, {
				compact: async () => {
					localCalls++;
					return { summary, firstKeptEntryId: "kept", tokensBefore: 100 };
				},
				request: async () => {
					remoteCalls++;
					return { artifact, telemetry: { latencyMs: 10 } };
				},
			});
			const context = {
				cwd, isProjectTrusted: () => true, hasUI: false, ui: { notify() {} }, model,
				modelRegistry: { getProvider: () => adapter, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) },
				getSystemPrompt: () => "system",
				sessionManager: { getSessionId: () => "session-blank", getBranch: () => manager.getBranch() },
			};
			const event = { preparation: { firstKeptEntryId: "kept", tokensBefore: 100 }, branchEntries: manager.getBranch(), signal: new AbortController().signal };
			assert.deepEqual(await handlers.get("session_before_compact")(event, context), { cancel: true });
			assert.equal(localCalls, 1);
			assert.equal(remoteCalls, 1);

			summary = "portable";
			const completed = await handlers.get("session_before_compact")(event, context);
			assert.equal(localCalls, 2, "the blank projection must not be cached");
			assert.equal(remoteCalls, 1, "the successful artifact must be reused");
			assert.equal(completed.compaction.summary, "portable");
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
}

test("registered hook cancels if a matched compaction policy throws", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-compact-throw-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ codexTools: { responsesCompaction: { enabled: true, providers: [identity.provider] } } }));
	try {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		const handlers = new Map();
		const warnings = [];
		registerResponsesCompaction({
			on(name, handler) { handlers.set(name, handler); },
			getThinkingLevel() { throw new Error("Pi API failed"); },
			getActiveTools() { return []; },
			getAllTools() { return []; },
		});
		const result = await handlers.get("session_before_compact")({
			preparation: {},
			branchEntries: manager.getBranch(),
			signal: new AbortController().signal,
		}, {
			cwd,
			isProjectTrusted: () => true,
			hasUI: true,
			ui: { notify(message, level) { warnings.push({ message, level }); } },
			model,
			modelRegistry: { getProvider: () => adapter, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) },
			getSystemPrompt: () => "system",
			sessionManager: {
				getSessionId: () => "session-throw",
				getBranch: () => manager.getBranch(),
			},
		});
		assert.deepEqual(result, { cancel: true });
		assert.deepEqual(warnings, [{
			message: "Codex compaction failed unexpectedly. Pi default compaction was blocked; run /compact again.",
			level: "warning",
		}]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("registered hook leaves disabled routes to Pi", async () => {
	const handlers = new Map();
	registerResponsesCompaction({
		on(name, handler) { handlers.set(name, handler); },
		getThinkingLevel() { return "off"; },
	});
	const result = await handlers.get("session_before_compact")({ preparation: {}, branchEntries: [], signal: AbortSignal.abort() }, {
		cwd: process.cwd(),
		isProjectTrusted: () => false,
		model,
		modelRegistry: { getProvider: () => adapter, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) },
	});
	assert.equal(result, undefined);
});

function compactedSessionWithTail(tailContent = "tail-secret") {
	const manager = SessionManager.inMemory();
	const summedId = manager.appendMessage({ role: "user", content: "summed-secret", timestamp: 1 });
	const keptId = manager.appendMessage({ role: "user", content: "kept-user", timestamp: 2 });
	manager.appendCompaction("portable summary", keptId, 1, { remoteResponsesCompaction: remoteDetails() }, true);
	const tailId = manager.appendMessage({ role: "user", content: tailContent, timestamp: 3 });
	return { manager, summedId, keptId, tailId };
}

test("projection omits and replaces post-checkpoint tail content for provider history", async () => {
	{
		const { manager, tailId } = compactedSessionWithTail();
		manager.appendContextEdit(tailId, null);
		const history = await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model);
		const parity = await serializePiMessagesForParity(buildSessionProjection(manager.getBranch()).messages, model);
		assert.deepEqual(history, [retainedUser, artifact]);
		assert.equal(JSON.stringify(history).includes("tail-secret"), false);
		assert.equal(JSON.stringify(parity).includes("tail-secret"), false);
	}
	{
		const { manager, tailId } = compactedSessionWithTail();
		manager.appendContextEdit(tailId, { content: "tail-replaced" });
		const history = await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model);
		const parity = await serializePiMessagesForParity(buildSessionProjection(manager.getBranch()).messages, model);
		assert.equal(JSON.stringify(history).includes("tail-replaced"), true);
		assert.equal(JSON.stringify(history).includes("tail-secret"), false);
		assert.equal(JSON.stringify(parity).includes("tail-replaced"), true);
		assert.equal(JSON.stringify(parity).includes("tail-secret"), false);
	}
});

test("post-checkpoint edits of kept or summarized content disable provider replay", async () => {
	{
		const { manager, keptId } = compactedSessionWithTail();
		manager.appendContextEdit(keptId, { content: "edited-kept" });
		assert.equal(await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model), undefined);
		const parity = await serializePiMessagesForParity(buildSessionProjection(manager.getBranch()).messages, model);
		assert.equal(JSON.stringify(parity).includes("edited-kept"), true);
	}
	{
		const { manager, summedId } = compactedSessionWithTail();
		manager.appendContextEdit(summedId, { content: "edited-summed" });
		assert.equal(await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model), undefined);
		const parity = JSON.stringify(await serializePiMessagesForParity(buildSessionProjection(manager.getBranch()).messages, model));
		assert.equal(parity.includes("edited-summed"), false);
		assert.equal(parity.includes("summed-secret"), false);
	}
});

test("unsafe post-checkpoint edit forces the next compaction to serialize the projection instead of replaying the artifact", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-compact-recompact-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ codexTools: { responsesCompaction: { enabled: true, providers: [identity.provider] } } }));
	try {
		const { manager, keptId } = compactedSessionWithTail();
		manager.appendContextEdit(keptId, { content: "edited-kept" });
		let remoteSource;
		const handlers = new Map();
		registerResponsesCompaction({
			on(name, handler) { handlers.set(name, handler); },
			getThinkingLevel() { return "off"; },
			getActiveTools() { return []; },
			getAllTools() { return []; },
		}, {
			compact: async () => ({ summary: "portable", firstKeptEntryId: keptId, tokensBefore: 100 }),
			request: async (_runtime, source) => {
				remoteSource = source;
				return { artifact: { type: "compaction", encrypted_content: "fresh-artifact" }, telemetry: { latencyMs: 1 } };
			},
		});
		const context = {
			cwd,
			isProjectTrusted: () => true,
			hasUI: false,
			ui: { notify() {} },
			model,
			modelRegistry: { getProvider: () => adapter, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) },
			getSystemPrompt: () => "system",
			sessionManager: {
				getSessionId: () => "session-recompact",
				getBranch: () => manager.getBranch(),
			},
		};
		const completed = await handlers.get("session_before_compact")({
			preparation: { firstKeptEntryId: keptId, tokensBefore: 100 },
			branchEntries: manager.getBranch(),
			signal: new AbortController().signal,
		}, context);
		assert.equal(completed.compaction.details.remoteResponsesCompaction.history.at(-1).encrypted_content, "fresh-artifact");
		assert.equal(JSON.stringify(remoteSource).includes("opaque-history"), false);
		assert.equal(JSON.stringify(remoteSource).includes("edited-kept"), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("null replacement of an abandoned post-checkpoint attempt is omitted from provider history", async () => {
	const { manager, tailId } = compactedSessionWithTail("abandoned-attempt");
	manager.appendContextEdit(tailId, null);
	const history = await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model);
	assert.deepEqual(history, [retainedUser, artifact]);
	assert.equal(JSON.stringify(history).includes("abandoned-attempt"), false);
});

test("context edits on another branch stay invisible to the current leaf", async () => {
	const { manager, tailId } = compactedSessionWithTail();
	const compactionId = manager.getBranch().find((entry) => entry.type === "compaction").id;
	const mainLeaf = manager.getLeafId();
	manager.branch(compactionId);
	const otherTail = manager.appendMessage({ role: "user", content: "other-branch-secret", timestamp: 4 });
	manager.appendContextEdit(otherTail, { content: "other-branch-edited" });
	const otherLeaf = manager.getLeafId();
	manager.branch(mainLeaf);
	const history = await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model);
	assert.equal(JSON.stringify(history).includes("other-branch"), false);
	assert.equal(JSON.stringify(history).includes("tail-secret"), true);

	manager.branch(otherLeaf);
	const editedOther = await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model);
	assert.equal(JSON.stringify(editedOther).includes("other-branch-edited"), true);
	assert.equal(JSON.stringify(editedOther).includes("tail-secret"), false);
	manager.appendContextEdit(otherTail, null);
	const omittedOther = await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model);
	assert.deepEqual(omittedOther, [retainedUser, artifact]);

	manager.branch(tailId);
	assert.equal(JSON.stringify(await reconstructResponsesCompactionHistory(manager.getBranch(), identity, model)).includes("tail-secret"), true);
});

test("leading transcript system message is stripped once into the request envelope", async () => {
	const serialized = await serializePiMessages([
		{ role: "system", content: "you are helpful", timestamp: 1 },
		{ role: "user", content: "hello", timestamp: 2 },
	], model);
	assert.deepEqual(serialized, [{ role: "user", content: [{ type: "input_text", text: "hello" }] }]);
	assert.equal(JSON.stringify(serialized).includes("you are helpful"), false);

	const cwd = mkdtempSync(join(tmpdir(), "codex-compact-prefix-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ codexTools: { responsesCompaction: { enabled: true, providers: [identity.provider] } } }));
	try {
		const manager = SessionManager.inMemory();
		manager.appendMessage({ role: "system", content: "you are helpful", timestamp: 1 });
		manager.appendMessage({ role: "user", content: "hello", timestamp: 2 });
		let remoteOptions;
		let remoteSource;
		const handlers = new Map();
		registerResponsesCompaction({
			on(name, handler) { handlers.set(name, handler); },
			getThinkingLevel() { return "off"; },
			getActiveTools() { return []; },
			getAllTools() { return []; },
		}, {
			compact: async () => ({ summary: "portable", firstKeptEntryId: manager.getLeafId(), tokensBefore: 10 }),
			request: async (_runtime, source, _signal, options) => {
				remoteSource = source;
				remoteOptions = options;
				return { artifact, telemetry: { latencyMs: 1 } };
			},
		});
		const context = {
			cwd,
			isProjectTrusted: () => true,
			hasUI: false,
			ui: { notify() {} },
			model,
			modelRegistry: { getProvider: () => adapter, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) },
			getSystemPrompt: () => "system",
			sessionManager: {
				getSessionId: () => "session-prefix",
				getBranch: () => manager.getBranch(),
			},
		};
		await handlers.get("before_provider_request")({
			payload: {
				model: identity.model,
				input: [{ role: "developer", content: "observed system" }, { role: "user", content: [{ type: "input_text", text: "hello" }] }],
			},
		}, context);
		const completed = await handlers.get("session_before_compact")({
			preparation: { firstKeptEntryId: manager.getLeafId(), tokensBefore: 10 },
			branchEntries: manager.getBranch(),
			signal: new AbortController().signal,
		}, context);
		assert.ok(completed.compaction);
		assert.deepEqual(remoteOptions.inputPrefix, [{ role: "developer", content: "observed system" }]);
		assert.equal(JSON.stringify(remoteSource).includes("you are helpful"), false);
		assert.equal(JSON.stringify(remoteSource).includes("observed system"), false);
		assert.equal(JSON.stringify(remoteSource).includes("hello"), true);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});

test("missing session projection skips replay and cancels matched compaction", async () => {
	const cwd = mkdtempSync(join(tmpdir(), "codex-compact-guard-"));
	mkdirSync(join(cwd, ".pi"));
	writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ codexTools: { responsesCompaction: { enabled: true, providers: [identity.provider] } } }));
	try {
		const handlers = new Map();
		const warnings = [];
		registerResponsesCompaction({
			on(name, handler) { handlers.set(name, handler); },
			getThinkingLevel() { return "off"; },
			getActiveTools() { return []; },
			getAllTools() { return []; },
		}, {
			compact: async () => ({ summary: "portable", firstKeptEntryId: "kept", tokensBefore: 1 }),
			request: async () => ({ artifact, telemetry: { latencyMs: 1 } }),
		});
		const context = {
			cwd,
			isProjectTrusted: () => true,
			hasUI: true,
			ui: { notify(message, level) { warnings.push({ message, level }); } },
			model,
			modelRegistry: { getProvider: () => adapter, getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key", headers: {} }) },
			getSystemPrompt: () => "system",
			sessionManager: {
				getSessionId: () => "session-guard",
				getBranch: () => { throw new Error("projection unavailable"); },
			},
		};
		assert.equal(await handlers.get("before_provider_request")({
			payload: { model: identity.model, input: [{ role: "user", content: "x" }] },
		}, context), undefined);
		const cancelled = await handlers.get("session_before_compact")({
			preparation: {},
			branchEntries: null,
			signal: new AbortController().signal,
		}, context);
		assert.deepEqual(cancelled, { cancel: true });
		assert.deepEqual(warnings, [{
			message: "Codex compaction requires Pi 1.2.0 session projection.",
			level: "warning",
		}]);
	} finally {
		rmSync(cwd, { recursive: true, force: true });
	}
});
