import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesClient, SearchBackendError } from "./responses-client.ts";
import { buildXaiWebSearchRequest, WEB_SEARCH_INSTRUCTIONS, XaiWebSearchSource } from "./xai-web-search.ts";

test("buildXaiWebSearchRequest sends native web_search without OpenAI-only fields", () => {
	assert.deepEqual(buildXaiWebSearchRequest({
		query: "latest Pi release",
		model: "grok-4.5",
		allowed_domains: [" example.com ", "docs.example"],
	}), {
		model: "grok-4.5",
		input: [{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "latest Pi release" }],
		}],
		instructions: WEB_SEARCH_INSTRUCTIONS,
		tools: [{
			type: "web_search",
			filters: { allowed_domains: ["example.com", "docs.example"] },
		}],
		tool_choice: { type: "web_search" },
		stream: false,
		store: false,
	});
	assert.equal(Object.hasOwn(buildXaiWebSearchRequest({
		query: "latest Pi release",
		model: "grok-4.5",
	}).tools[0], "search_context_size"), false);
	assert.equal(Object.hasOwn(buildXaiWebSearchRequest({
		query: "latest Pi release",
		model: "grok-4.5",
	}).tools[0], "user_location"), false);
});

test("xAI web search rejects more than five allowed domains without a network call", async () => {
	let called = false;
	const source = new XaiWebSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => {
			called = true;
			return new Response("should not run");
		},
	}));

	await assert.rejects(
		() => source.search({
			query: "docs",
			model: "grok-4.5",
			allowed_domains: ["a.com", "b.com", "c.com", "d.com", "e.com", "f.com"],
		}),
		(error) => error instanceof SearchBackendError && error.code === "invalid_input" && /at most 5/.test(error.message),
	);
	assert.equal(called, false);
});

test("xAI web search retries once without an unsupported forced tool choice", async () => {
	const bodies = [];
	const client = new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async (_input, init) => {
			bodies.push(JSON.parse(String(init?.body)));
			if (bodies.length === 1) {
				return new Response(JSON.stringify({ message: "data did not match ModelToolChoice" }), { status: 422 });
			}
			return new Response(JSON.stringify({
				output: [{ type: "output_text", text: "answer", annotations: [{ type: "url_citation", url: "https://docs.x.ai/search", title: "Docs" }] }],
			}), { headers: { "content-type": "application/json" } });
		},
	});

	const response = await new XaiWebSearchSource(client).search({
		query: "docs",
		model: "grok-4.5",
		reasoningEffort: "high",
	});
	assert.equal(response.answer, "answer");
	assert.equal(bodies.length, 2);
	assert.deepEqual(bodies[0].tool_choice, { type: "web_search" });
	assert.deepEqual(bodies[0].reasoning, { effort: "high" });
	assert.equal(Object.hasOwn(bodies[1], "tool_choice"), false);
	assert.deepEqual(bodies[1].reasoning, { effort: "high" });
});

test("buildXaiWebSearchRequest includes reasoning.effort only when provided", () => {
	assert.equal(Object.hasOwn(buildXaiWebSearchRequest({
		query: "latest Pi release",
		model: "grok-4.5",
	}), "reasoning"), false);
	assert.deepEqual(buildXaiWebSearchRequest({
		query: "latest Pi release",
		model: "grok-4.5",
		reasoningEffort: "low",
	}).reasoning, { effort: "low" });
});

test("xAI web search does not retry a 5xx that mentions ModelToolChoice", async () => {
	let calls = 0;
	const source = new XaiWebSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => {
			calls += 1;
			return new Response(JSON.stringify({ message: "data did not match ModelToolChoice" }), { status: 500 });
		},
	}));

	await assert.rejects(
		() => source.search({ query: "docs", model: "grok-4.5" }),
		(error) => error instanceof SearchBackendError && error.code === "backend_error" && error.status === 500,
	);
	assert.equal(calls, 1);
});
