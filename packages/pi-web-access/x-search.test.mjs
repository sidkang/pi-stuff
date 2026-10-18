import assert from "node:assert/strict";
import test from "node:test";
import { ResponsesClient, SearchBackendError } from "./responses-client.ts";
import { buildXSearchRequest, isXSearchSuccess, X_SEARCH_INSTRUCTIONS, XSearchSource } from "./x-search.ts";

test("buildXSearchRequest sends native x_search with optional forced tool_choice", () => {
	assert.deepEqual(buildXSearchRequest({ query: "pi release", model: "grok-4.5" }, true), {
		model: "grok-4.5",
		input: [{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "pi release" }],
		}],
		instructions: X_SEARCH_INSTRUCTIONS,
		tools: [{ type: "x_search" }],
		tool_choice: { type: "x_search" },
		stream: false,
		store: false,
	});
	const withoutToolChoice = buildXSearchRequest({ query: "pi release", model: "grok-4.5" }, false);
	assert.equal(Object.hasOwn(withoutToolChoice, "tool_choice"), false);
	assert.equal(withoutToolChoice.instructions, X_SEARCH_INSTRUCTIONS);
	assert.equal(Object.hasOwn(buildXSearchRequest({ query: "pi release", model: "grok-4.5" }, true), "reasoning"), false);
	assert.deepEqual(buildXSearchRequest({
		query: "pi release",
		model: "grok-4.5",
		from_date: "2025-02-01",
		to_date: "2025-02-28",
		reasoningEffort: "medium",
	}, true), {
		model: "grok-4.5",
		input: [{
			type: "message",
			role: "user",
			content: [{ type: "input_text", text: "pi release" }],
		}],
		instructions: X_SEARCH_INSTRUCTIONS,
		tools: [{ type: "x_search", from_date: "2025-02-01", to_date: "2025-02-28" }],
		tool_choice: { type: "x_search" },
		stream: false,
		store: false,
		reasoning: { effort: "medium" },
	});
});

test("buildXSearchRequest validates calendar dates and ordering", () => {
	assert.throws(
		() => buildXSearchRequest({ query: "pi release", model: "grok-4.5", from_date: "2025-02-29" }, true),
		(error) => error instanceof SearchBackendError && error.code === "invalid_input" && /from_date/.test(error.message),
	);
	assert.throws(
		() => buildXSearchRequest({ query: "pi release", model: "grok-4.5", from_date: "2025-03-01", to_date: "2025-02-28" }, true),
		(error) => error instanceof SearchBackendError && error.code === "invalid_input" && /on or before/.test(error.message),
	);
	assert.deepEqual(
		buildXSearchRequest({ query: "pi release", model: "grok-4.5", from_date: "2024-02-29" }, true).tools,
		[{ type: "x_search", from_date: "2024-02-29" }],
	);
});

test("X success requires assistant text plus an x_search_call or structured X URL", () => {
	assert.equal(isXSearchSuccess({
		answer: "A post",
		sources: [],
		outputItems: [{ type: "x_search_call" }],
	}), true);
	assert.equal(isXSearchSuccess({
		answer: "A post",
		sources: [],
		citations: [{ title: "Post", url: "https://x.com/user/status/1" }],
		citationUrls: ["https://x.com/user/status/1"],
	}), true);
	assert.equal(isXSearchSuccess({
		answer: "See https://x.com/user/status/1",
		sources: [{ title: "x.com", url: "https://x.com/user/status/1" }],
	}), false);
	assert.equal(isXSearchSuccess({
		answer: "See [Post](https://x.com/user/status/1)",
		sources: [{ title: "Post", url: "https://x.com/user/status/1" }],
	}), false);
	assert.equal(isXSearchSuccess({
		answer: "A post",
		sources: [],
		outputItems: [{ type: "x_search" }],
	}), false);
	assert.equal(isXSearchSuccess({
		answer: "A post",
		sources: [{ title: "Docs", url: "https://docs.example" }],
	}), false);
	assert.equal(isXSearchSuccess({
		answer: "",
		sources: [{ title: "Post", url: "https://twitter.com/user/status/1" }],
		outputItems: [{ type: "x_search_call" }],
	}), false);
});

test("x_search succeeds from assistant text plus official top-level X citation URLs", async () => {
	const source = new XSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => new Response(JSON.stringify({
			output: [{ type: "output_text", text: "A post about Pi." }],
			citations: ["https://x.com/user/status/1/"],
		})),
	}));

	const result = await source.search({ query: "pi release", model: "grok-4.5" });
	assert.equal(result.answer, "A post about Pi.");
	assert.deepEqual(result.citations, [{ title: "x.com", url: "https://x.com/user/status/1/" }]);
	assert.deepEqual(result.sources, [{ title: "x.com", url: "https://x.com/user/status/1/" }]);
});

test("x_search retries once without tool_choice after an unsupported tool-choice shape", async () => {
	const bodies = [];
	const source = new XSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async (_input, init) => {
			const body = JSON.parse(String(init?.body ?? "{}"));
			bodies.push(body);
			if (body.tool_choice) {
				return new Response(JSON.stringify({ error: { message: "invalid tool_choice shape" } }), { status: 400 });
			}
			return new Response(JSON.stringify({
				output: [
					{ type: "x_search_call" },
					{ type: "output_text", text: "A post", annotations: [{ type: "url_citation", url: "https://x.com/user/status/1", title: "Post" }] },
				],
			}));
		},
	}));

	const result = await source.search({
		query: "pi release",
		model: "grok-4.5",
		from_date: "2025-01-01",
		to_date: "2025-01-31",
		reasoningEffort: "low",
	});
	assert.equal(bodies.length, 2);
	assert.deepEqual(bodies[0].tool_choice, { type: "x_search" });
	assert.deepEqual(bodies[0].tools, [{ type: "x_search", from_date: "2025-01-01", to_date: "2025-01-31" }]);
	assert.deepEqual(bodies[0].reasoning, { effort: "low" });
	assert.equal(Object.hasOwn(bodies[1], "tool_choice"), false);
	assert.deepEqual(bodies[1].tools, [{ type: "x_search", from_date: "2025-01-01", to_date: "2025-01-31" }]);
	assert.deepEqual(bodies[1].reasoning, { effort: "low" });
	assert.equal(result.answer, "A post");
});

test("x_search rejects answer-scraped X URLs and type x_search output items", async () => {
	const scraped = new XSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => new Response(JSON.stringify({
			output: [{ type: "output_text", text: "See [Post](https://x.com/user/status/1) and https://x.com/user/status/2" }],
		})),
	}));
	const typedSearch = new XSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => new Response(JSON.stringify({
			output: [
				{ type: "x_search" },
				{ type: "output_text", text: "A post" },
			],
		})),
	}));

	await assert.rejects(
		() => scraped.search({ query: "pi release", model: "grok-4.5" }),
		(error) => error instanceof SearchBackendError && error.code === "invalid_response",
	);
	await assert.rejects(
		() => typedSearch.search({ query: "pi release", model: "grok-4.5" }),
		(error) => error instanceof SearchBackendError && error.code === "invalid_response",
	);
});

test("x_search succeeds from assistant text plus url_citation annotations", async () => {
	const source = new XSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => new Response(JSON.stringify({
			output: [{
				type: "output_text",
				text: "A post about Pi.",
				annotations: [{ type: "url_citation", url: "https://twitter.com/user/status/1", title: "Post" }],
			}],
		})),
	}));

	const result = await source.search({ query: "pi release", model: "grok-4.5" });
	assert.equal(result.answer, "A post about Pi.");
	assert.deepEqual(result.citationUrls, ["https://twitter.com/user/status/1"]);
});

test("x_search does not retry a 5xx that mentions ModelToolChoice", async () => {
	let calls = 0;
	const source = new XSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => {
			calls += 1;
			return new Response(JSON.stringify({ error: { message: "data did not match ModelToolChoice" } }), { status: 503 });
		},
	}));

	await assert.rejects(
		() => source.search({ query: "pi release", model: "grok-4.5" }),
		(error) => error instanceof SearchBackendError && error.code === "backend_error" && error.status === 503,
	);
	assert.equal(calls, 1);
});

test("x_search does not retry a general backend error", async () => {
	let calls = 0;
	const source = new XSearchSource(new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => {
			calls += 1;
			return new Response(JSON.stringify({ error: { message: "upstream unavailable" } }), { status: 502 });
		},
	}));

	await assert.rejects(
		() => source.search({ query: "pi release", model: "grok-4.5" }),
		(error) => error instanceof SearchBackendError && error.code === "backend_error",
	);
	assert.equal(calls, 1);
});
