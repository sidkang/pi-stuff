import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createEventBus,
	createExtensionRuntime,
	ExtensionRunner,
} from "@earendil-works/pi-coding-agent";

// Internal host modules are not exported; find the dev dependency whether npm installed it here or hoisted it to a workspace root.
function findCodingAgent() {
	for (let dir = dirname(fileURLToPath(import.meta.url)); ; dir = dirname(dir)) {
		const candidate = join(dir, "node_modules/@earendil-works/pi-coding-agent");
		if (existsSync(candidate)) return candidate;
		if (dirname(dir) === dir) throw new Error("@earendil-works/pi-coding-agent dev dependency not found");
	}
}
const codingAgent = findCodingAgent();
const { loadExtensionFromFactory } = await import(pathToFileURL(join(codingAgent, "dist/core/extensions/loader.js")).href);
const { runAgentLoop } = await import(
	pathToFileURL(join(codingAgent, "node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js")).href
);
import fetchContent, { setFetchContentDepsForTests } from "./fetch-content.ts";
import webSearch from "./web-search.ts";
import xSearch from "./x-search-tool.ts";

function assistantToolCall(name, args) {
	const message = {
		role: "assistant",
		content: [{ type: "toolCall", id: `call-${name}`, name, arguments: args }],
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
	return {
		message,
		response: {
			async *[Symbol.asyncIterator]() {
				yield { type: "start", partial: message };
				yield { type: "done", reason: "toolUse", message };
			},
			async result() {
				return message;
			},
		},
	};
}

async function registeredTool(factory, name, cwd, withPeerExtension) {
	const eventBus = createEventBus();
	const runtime = createExtensionRuntime();
	const extensions = [await loadExtensionFromFactory(factory, cwd, eventBus, runtime, `/virtual/web-access/${name}.ts`)];
	if (withPeerExtension) {
		extensions.push(await loadExtensionFromFactory(
			(pi) => pi.on("session_start", () => undefined),
			cwd,
			eventBus,
			runtime,
			"/virtual/peer-extension/index.ts",
		));
	}
	const runner = new ExtensionRunner(extensions, runtime, cwd, {}, {});
	const definition = runner.getToolDefinition(name);
	assert.ok(definition, `${name} was registered`);
	return { definition, runner };
}

async function runFailingTool(definition, params, ctx, runner) {
	const tool = {
		...definition,
		execute(toolCallId, args, signal, onUpdate) {
			return definition.execute(toolCallId, args, signal, onUpdate, ctx);
		},
	};
	const { message, response } = assistantToolCall(definition.name, params);
	const events = [];
	const messages = await runAgentLoop(
		[{ role: "user", content: [{ type: "text", text: "run the tool" }], timestamp: Date.now() }],
		{ systemPrompt: "", messages: [], tools: [tool] },
		{
			model: { provider: "test", id: "text-model", api: "openai-responses" },
			convertToLlm: () => [],
			shouldStopAfterTurn: () => true,
			async afterToolCall({ toolCall, args, result, isError }) {
				if (!runner.hasHandlers("tool_result")) return undefined;
				const hookResult = await runner.emitToolResult({
					type: "tool_result",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args,
					content: result.content,
					details: result.details,
					isError,
					usage: result.usage,
				});
				if (!hookResult) return undefined;
				return {
					content: hookResult.content,
					details: hookResult.details,
					isError: hookResult.isError ?? isError,
					usage: hookResult.usage,
				};
			},
		},
		(event) => events.push(event),
		undefined,
		async () => response,
	);
	const end = events.find((event) => event.type === "tool_execution_end");
	const persisted = messages.find((entry) => entry.role === "toolResult" && entry.toolName === definition.name);
	assert.equal(end?.isError, true, `${definition.name} outer event is an error`);
	assert.equal(persisted?.isError, true, `${definition.name} persisted result is an error`);
	assert.equal(persisted?.toolCallId, message.content[0].id);
	return { end, persisted };
}

function assertRestoredErrorDetails(result, expectedError) {
	const details = result.persisted.details;
	assert.ok(details && typeof details === "object" && !Array.isArray(details), "persisted details must be a non-empty object");
	assert.notDeepEqual(details, {}, "persisted details must not be empty after tool_result restore");
	assert.equal(details.ok, false);
	assert.equal(details.error, expectedError);
	assert.equal(result.persisted.content[0].text, expectedError);
	assert.equal(result.end.result.details.error, expectedError);
	assert.equal(result.end.result.details.ok, false);
}

for (const withPeerExtension of [false, true]) {
	const composition = withPeerExtension ? "with another loaded extension" : "without another loaded extension";

	test(`Pi records web_search rejection as isError ${composition}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "web-access-web-error-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}\n");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const { definition, runner } = await registeredTool(webSearch, "web_search", cwd, withPeerExtension);
			const result = await runFailingTool(definition, { query: "latest Pi release", provider: "openai" }, {
				cwd,
				isProjectTrusted: () => true,
				modelRegistry: { find: () => undefined },
			}, runner);
			assert.match(result.persisted.content[0].text, /No openai web search source is configured/i);
			assertRestoredErrorDetails(result, result.persisted.content[0].text);
			assert.equal(result.persisted.details.code, "missing_config");
			assert.equal(typeof result.persisted.details.elapsedMs, "number");
			assert.equal(typeof result.persisted.details.timeoutMs, "number");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test(`Pi records configured web_search backend HTTP error with one tool prefix ${composition}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "web-access-web-backend-error-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}\n");
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			webAccess: { openai: { model: "test/text-model" } },
		}));
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		const previousFetch = globalThis.fetch;
		globalThis.fetch = async () => new Response(JSON.stringify({
			error: { message: "Web search failed: upstream unavailable" },
		}), { status: 502, statusText: "Bad Gateway", headers: { "content-type": "application/json" } });
		try {
			const { definition, runner } = await registeredTool(webSearch, "web_search", cwd, withPeerExtension);
			const modelRegistry = {
				find(provider, id) {
					if (provider !== "test" || id !== "text-model") return undefined;
					return { provider, id, baseUrl: "https://example.test/v1", api: "openai-responses" };
				},
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "test-key", headers: {} };
				},
			};
			const result = await runFailingTool(definition, { query: "latest Pi release", provider: "openai" }, {
				cwd,
				isProjectTrusted: () => true,
				modelRegistry,
			}, runner);
			const expected = "Web search failed: HTTP 502: upstream unavailable";
			assert.equal(result.persisted.content[0].text, expected);
			assert.equal(result.end.result.content[0].text, expected);
			assertRestoredErrorDetails(result, expected);
			assert.equal(result.persisted.details.provider, "test");
			assert.equal(result.persisted.details.model, "text-model");
			assert.equal(result.persisted.details.api, "openai-responses");
			assert.equal(result.persisted.details.code, "backend_error");
			assert.equal(result.persisted.details.status, 502);
			assert.equal(Number.isFinite(result.persisted.details.elapsedMs), true);
			assert.equal(result.persisted.details.timeoutMs, 60_000);
			assert.ok(Array.isArray(result.persisted.details.attempts));
		} finally {
			globalThis.fetch = previousFetch;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test(`Pi records x_search rejection as isError ${composition}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "web-access-x-error-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}\n");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		try {
			const { definition, runner } = await registeredTool(xSearch, "x_search", cwd, withPeerExtension);
			const result = await runFailingTool(definition, { query: "pi release" }, {
				cwd,
				isProjectTrusted: () => true,
				modelRegistry: { find: () => undefined },
			}, runner);
			assert.match(result.persisted.content[0].text, /No xAI source is configured/i);
			assertRestoredErrorDetails(result, result.persisted.content[0].text);
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test(`Pi records fetch_content missing CDP config with missing_config ${composition}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "web-access-fetch-error-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}\n");
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		const previousEndpoint = process.env.CDP_ENDPOINT;
		const previousApiKey = process.env.CDP_API_KEY;
		process.env.PI_CODING_AGENT_DIR = agentDir;
		delete process.env.CDP_ENDPOINT;
		delete process.env.CDP_API_KEY;
		try {
			const { definition, runner } = await registeredTool(fetchContent, "fetch_content", cwd, withPeerExtension);
			const result = await runFailingTool(definition, { url: "https://example.com" }, {
				cwd,
				isProjectTrusted: () => true,
				env: {},
			}, runner);
			assert.match(result.persisted.content[0].text, /CDP_ENDPOINT or webAccess\.fetch\.cdp\.endpoint/i);
			assertRestoredErrorDetails(result, result.persisted.content[0].text);
			assert.equal(result.persisted.details.code, "missing_config");
		} finally {
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			if (previousEndpoint === undefined) delete process.env.CDP_ENDPOINT;
			else process.env.CDP_ENDPOINT = previousEndpoint;
			if (previousApiKey === undefined) delete process.env.CDP_API_KEY;
			else process.env.CDP_API_KEY = previousApiKey;
			rmSync(root, { recursive: true, force: true });
		}
	});

	test(`Pi records fetch_content CDP command timeouts as timeout ${composition}`, async () => {
		const root = mkdtempSync(join(tmpdir(), "web-access-fetch-timeout-"));
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), "{}\n");
		setFetchContentDepsForTests({
			capturePage: async () => {
				throw new DOMException("CDP timeout: Runtime.evaluate", "TimeoutError");
			},
		});
		try {
			const { definition, runner } = await registeredTool(fetchContent, "fetch_content", cwd, withPeerExtension);
			const result = await runFailingTool(definition, { url: "https://example.com" }, {
				cwd,
				isProjectTrusted: () => true,
				env: { CDP_ENDPOINT: "https://browser.example/json/version" },
			}, runner);
			assert.equal(result.persisted.content[0].text, "fetch_content timed out");
			assertRestoredErrorDetails(result, "fetch_content timed out");
			assert.equal(result.persisted.details.code, "timeout");
		} finally {
			setFetchContentDepsForTests();
			rmSync(root, { recursive: true, force: true });
		}
	});
}
