import assert from "node:assert/strict";
import test from "node:test";
import { buildOpenAIWebSearchRequest, OpenAIWebSearchSource, WEB_SEARCH_INSTRUCTIONS } from "./openai-web-search.ts";
import { ResponsesClient, SearchBackendError } from "./responses-client.ts";

test("buildOpenAIWebSearchRequest forces hosted web_search tool with message input and optional filters", () => {
	assert.deepEqual(buildOpenAIWebSearchRequest({
		query: "latest Pi release",
		model: "gpt-5.4-mini",
		search_context_size: "high",
		allowed_domains: [" example.com ", "", "docs.example"],
		user_location: {
			type: "approximate",
			country: " US ",
			region: "CA",
			city: " San Francisco ",
			timezone: " America/Los_Angeles ",
		},
	}), {
		model: "gpt-5.4-mini",
		input: [{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "latest Pi release" }],
		}],
		instructions: WEB_SEARCH_INSTRUCTIONS,
		tools: [{
			type: "web_search",
			external_web_access: true,
			search_context_size: "high",
			filters: { allowed_domains: ["example.com", "docs.example"] },
			user_location: {
				type: "approximate",
				country: "US",
				region: "CA",
				city: "San Francisco",
				timezone: "America/Los_Angeles",
			},
		}],
		tool_choice: { type: "web_search" },
		stream: false,
		store: false,
	});
});

test("buildOpenAIWebSearchRequest normalizes two-letter country codes", () => {
	assert.deepEqual(buildOpenAIWebSearchRequest({
		query: "Homebrew documentation",
		model: "gpt-5.4-mini",
		user_location: { type: "approximate", country: " cn " },
	}).tools, [{
		type: "web_search",
		external_web_access: true,
		user_location: { type: "approximate", country: "CN" },
	}]);
});

test("buildOpenAIWebSearchRequest omits non-two-letter country values", () => {
	for (const country of ["China", "Japan", "USA"]) {
		assert.deepEqual(buildOpenAIWebSearchRequest({
			query: "Homebrew documentation",
			model: "gpt-5.4-mini",
			user_location: { type: "approximate", country, city: "Beijing" },
		}).tools, [{
			type: "web_search",
			external_web_access: true,
			user_location: { type: "approximate", city: "Beijing" },
		}]);
	}
});

test("buildOpenAIWebSearchRequest omits a location with no valid fields", () => {
	assert.deepEqual(buildOpenAIWebSearchRequest({
		query: "Homebrew documentation",
		model: "gpt-5.4-mini",
		user_location: { type: "approximate", country: "China" },
	}).tools, [{
		type: "web_search",
		external_web_access: true,
	}]);
});

test("buildOpenAIWebSearchRequest includes reasoning.effort only when provided", () => {
	assert.equal(Object.hasOwn(buildOpenAIWebSearchRequest({
		query: "latest Pi release",
		model: "gpt-5.4-mini",
	}), "reasoning"), false);
	assert.deepEqual(buildOpenAIWebSearchRequest({
		query: "latest Pi release",
		model: "gpt-5.4-mini",
		reasoningEffort: "low",
	}).reasoning, { effort: "low" });
});

test("OpenAI source treats sources-only responses as success and empty ones as invalid", async () => {
	const sourceOnly = new OpenAIWebSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => new Response(JSON.stringify({
			output: [{ type: "web_search_call", sources: [{ title: "Docs", url: "https://docs.example" }] }],
		})),
	}));
	const empty = new OpenAIWebSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => new Response(JSON.stringify({ output: [] })),
	}));

	const result = await sourceOnly.search({ query: "docs", model: "gpt-5.4-mini" });
	assert.equal(result.sources.length, 1);
	await assert.rejects(
		() => empty.search({ query: "docs", model: "gpt-5.4-mini" }),
		(error) => error instanceof SearchBackendError && error.code === "invalid_response",
	);
});
