import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { classifySearchFailure } from "./search-errors.ts";
import { SearchBackendError } from "./responses-client.ts";
import { setSourceDeadlineForTests } from "./source-deadline.ts";
import webSearch from "./web-search.ts";
import xSearch from "./x-search-tool.ts";

function registered(factory = webSearch) {
	let tool;
	const handlers = [];
	factory({
		on(event, handler) { if (event === "tool_result") handlers.push(handler); },
		registerTool(definition) { tool = definition; },
	});
	return { tool, restore(payload) { return handlers.map(h => h(payload)).find(Boolean); } };
}

const models = { openai: { model: "newapi/gpt-5.4-mini" }, xai: { model: "homelab/grok-4.5" } };
const success = () => new Response(JSON.stringify({ output: [{ type: "output_text", text: "answer", annotations: [{ type: "url_citation", url: "https://docs.example", title: "Docs" }] }] }));

async function withSettings(webAccess, callback) {
	const root = mkdtempSync(join(tmpdir(), "web-access-single-search-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ webAccess }));
	const previousDir = process.env.PI_CODING_AGENT_DIR;
	const previousFetch = globalThis.fetch;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		await callback({
			cwd: root,
			isProjectTrusted: () => false,
			env: {},
			modelRegistry: {
				find(provider, id) {
					const host = provider === "newapi" && id === "gpt-5.4-mini" ? "openai" : provider === "homelab" && id === "grok-4.5" ? "xai" : undefined;
					return host ? { provider, id, baseUrl: `https://${host}.example/v1`, api: "openai-responses" } : undefined;
				},
				async getApiKeyAndHeaders() { return { ok: true, apiKey: "test-key", headers: {} }; },
			},
		});
	} finally {
		globalThis.fetch = previousFetch;
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		rmSync(root, { recursive: true, force: true });
	}
}

test("missing, removed, and invalid providers fail before any access, including when a legacy default is set", async () => {
	await withSettings({ ...models, defaultProvider: "all", merge: { enabled: true, model: "newapi/merge" } }, async (ctx) => {
		ctx.modelRegistry.find = () => assert.fail("must not resolve credentials or models");
		globalThis.fetch = () => assert.fail("must not access the network");
		for (const provider of [undefined, "all", "fallback", "", "unknown", null]) {
			const { tool, restore } = registered();
			await assert.rejects(() => tool.execute("invalid", { query: "docs", provider }, undefined, undefined, ctx), /provider is required/);
			const restored = restore({ toolName: "web_search", toolCallId: "invalid", details: {}, isError: true });
			assert.equal(restored.details.code, "invalid_input");
		}
		await assert.rejects(() => registered().tool.execute("merge", { query: "docs", provider: "openai", merge: true }, undefined, undefined, ctx), /merge is not supported/);
	});
});

test("explicit answering provider selects only that source regardless of legacy default", async () => {
	for (const provider of ["openai", "xai"]) {
		await withSettings({ ...models, defaultProvider: "all", merge: { enabled: true } }, async (ctx) => {
			const urls = [];
			globalThis.fetch = async (input, init) => {
				urls.push(String(input));
				const body = JSON.parse(init.body);
				assert.deepEqual(body.tool_choice, { type: "web_search" });
				if (provider === "openai") assert.equal(body.tools[0].search_context_size, "high");
				return success();
			};
			const updates = [];
			const result = await registered().tool.execute("single", { query: "docs", provider }, undefined, update => updates.push(update), ctx);
			assert.deepEqual(urls, [`https://${provider}.example/v1/responses`]);
			assert.equal(result.details.source, provider);
			assert.equal(result.details.attempts.length, 1);
			assert.equal(result.details.attempts[0].ok, true);
			assert.equal(updates[0].details.source, provider);
		});
	}
});

test("missing or invalid selected configuration never switches to another configured source", async () => {
	for (const openai of [undefined, { model: "invalid" }]) {
		await withSettings({ xai: models.xai, ...(openai ? { openai } : {}) }, async (ctx) => {
			globalThis.fetch = () => assert.fail("must not try xAI or hosted sources");
			await assert.rejects(() => registered().tool.execute("config", { query: "docs", provider: "openai" }, undefined, undefined, ctx), /No openai|Invalid webAccess.openai/);
		});
	}
	await withSettings({ openai: models.openai, xai: { model: "invalid" } }, async (ctx) => {
		globalThis.fetch = async () => success();
		assert.equal((await registered().tool.execute("other-invalid", { query: "docs", provider: "openai" }, undefined, undefined, ctx)).details.ok, true);
	});
});

test("all failure categories end the selected source attempt without fallback and preserve diagnostic details", async () => {
	for (const provider of ["openai", "xai"]) {
		for (const failure of [401, 429, 502, "empty", "network", "timeout"]) {
			await withSettings(models, async (ctx) => {
				let calls = 0;
				globalThis.fetch = async (input) => {
					calls++;
					assert.match(String(input), new RegExp(`${provider}\\.example`));
					if (failure === "network") throw new TypeError("fetch failed");
					if (failure === "timeout") throw new DOMException("slow", "TimeoutError");
					if (failure === "empty") return new Response("{}");
					return new Response(JSON.stringify({ error: { message: "upstream failure" } }), { status: failure });
				};
				const { tool, restore } = registered();
				await assert.rejects(() => tool.execute("failure", { query: "docs", provider }, undefined, undefined, ctx), /Web search failed/);
				assert.equal(calls, 1);
				const { details } = restore({ toolName: "web_search", toolCallId: "failure", details: {}, isError: true });
				assert.equal(details.source, provider);
				assert.equal(details.attempts.length, 1);
				assert.equal(details.attempts[0].ok, false);
				assert.equal(details.model, provider === "openai" ? "gpt-5.4-mini" : "grok-4.5");
			});
		}
	}
});

test("cancellation records aborted diagnostics for the selected attempt", async () => {
	await withSettings(models, async ctx => {
		const controller = new AbortController();
		globalThis.fetch = async () => { controller.abort(); throw new DOMException("aborted", "AbortError"); };
		const { tool, restore } = registered();
		await assert.rejects(() => tool.execute("cancel", { query: "docs", provider: "openai" }, controller.signal, undefined, ctx), /aborted/);
		const { details } = restore({ toolName: "web_search", toolCallId: "cancel", details: {}, isError: true });
		assert.equal(details.code, "aborted");
		assert.equal(details.attempts[0].code, "aborted");
	});
});

test("stalled credential resolution remains bounded for web_search and x_search", async () => {
	try {
		setSourceDeadlineForTests({ timeoutMs: 20, createTimeout(ms) {
			const controller = new AbortController();
			setTimeout(() => controller.abort(new DOMException("slow", "TimeoutError")), ms);
			return controller.signal;
		} });
		await withSettings(models, async ctx => {
			ctx.modelRegistry.getApiKeyAndHeaders = () => new Promise(() => {});
			globalThis.fetch = () => assert.fail("must not fetch");
			const start = Date.now();
			await assert.rejects(() => registered().tool.execute("web-timeout", { query: "docs", provider: "openai" }, undefined, undefined, ctx), /timed out/);
			await assert.rejects(() => registered(xSearch).tool.execute("x-timeout", { query: "docs" }, undefined, undefined, ctx), /timed out/);
			assert.ok(Date.now() - start < 1000);
		});
	} finally { setSourceDeadlineForTests(); }
});

test("search error classification preserves codes without source-routing decisions", () => {
	assert.equal(classifySearchFailure(new SearchBackendError("rate_limited", "quota", 429)).code, "rate_limited");
	assert.equal(classifySearchFailure(new DOMException("slow", "TimeoutError")).code, "timeout");
	assert.equal(classifySearchFailure(new DOMException("cancel", "AbortError")).code, "aborted");
	assert.equal(classifySearchFailure(new TypeError("fetch failed")).code, "backend_error");
});
