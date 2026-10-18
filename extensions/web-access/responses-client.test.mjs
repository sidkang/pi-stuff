import assert from "node:assert/strict";
import test from "node:test";
import { normalizeBackendResponse, readSearchStream, ResponsesClient, searchToolResult, SearchBackendError } from "./responses-client.ts";

const MEBIBYTE = 1024 * 1024;

function streamResponse(chunks) {
	return new Response(new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
			controller.close();
		},
	}));
}

function unfinishedStreamResponse(chunks) {
	let cancelled = false;
	const stream = new ReadableStream({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
		},
		cancel() {
			cancelled = true;
		},
	});
	return { response: new Response(stream), stream, wasCancelled: () => cancelled };
}

function urlWithoutHash(url) {
	const parsed = new URL(url);
	parsed.hash = "";
	return parsed.toString();
}

const NORMALIZER_RESPONSE = {
	id: "resp_123",
	model: "gpt-5.4-mini",
	usage: { input_tokens: 11, output_tokens: 7, total_tokens: 18 },
	output: [{
		type: "output_text",
		text: "Read [Docs](https://docs.example/a#markdown) and https://bare.example/path#frag.",
		annotations: [{
			type: "url_citation",
			title: "Docs annotation",
			url: "https://docs.example/a#annotation",
			cited_text: "quoted docs",
		}],
		sources: [{
			title: "Explicit source",
			url: "https://source.example/item#first",
			snippet: "from source list",
		}],
		citations: [{
			title: "Explicit citation",
			url: "https://citation.example/item#first",
			text: "from citations list",
		}],
	}],
};

test("normalizeBackendResponse extracts answers, citations, explicit sources, text links, usage, and request metadata", () => {
	const normalized = normalizeBackendResponse(NORMALIZER_RESPONSE);

	assert.equal(normalized.answer, "Read [Docs](https://docs.example/a#markdown) and https://bare.example/path#frag.");
	assert.equal(normalized.model, "gpt-5.4-mini");
	assert.equal(normalized.requestId, "resp_123");
	assert.deepEqual(normalized.usage, { inputTokens: 11, outputTokens: 7, totalTokens: 18 });
	assert.deepEqual(normalized.sources, [
		{ title: "Docs annotation", url: "https://docs.example/a#annotation", snippet: "quoted docs" },
		{ title: "Explicit source", url: "https://source.example/item#first", snippet: "from source list", publishedDate: undefined },
		{ title: "Explicit citation", url: "https://citation.example/item#first", snippet: "from citations list" },
		{ title: "bare.example", url: "https://bare.example/path#frag" },
	]);
	assert.deepEqual(normalized.citations, [
		{ title: "Docs annotation", url: "https://docs.example/a#annotation", citedText: "quoted docs" },
		{ title: "Explicit citation", url: "https://citation.example/item#first", citedText: "from citations list" },
	]);
	assert.deepEqual(normalized.citationUrls, [
		"https://docs.example/a#annotation",
		"https://citation.example/item#first",
	]);

	const docsSources = normalized.sources.filter((source) => urlWithoutHash(source.url) === "https://docs.example/a");
	assert.equal(docsSources.length, 1, "URL citations and markdown links dedupe by URL without hash");
});

test("normalizeBackendResponse accepts xAI official top-level citation URL strings", () => {
	const url = "https://x.com/user/status/1/";
	const normalized = normalizeBackendResponse({
		output: [{
			type: "output_text",
			text: "A post about Pi.",
			annotations: [{ type: "url_citation", url, title: "Annotated post", cited_text: "quoted" }],
		}],
		citations: [url, "", "ftp://ignored.example", url],
	});

	assert.equal(normalized.answer, "A post about Pi.");
	assert.deepEqual(normalized.citations, [{ title: "Annotated post", url, citedText: "quoted" }]);
	assert.deepEqual(normalized.citationUrls, [url]);
	assert.deepEqual(normalized.sources, [{ title: "Annotated post", url, snippet: "quoted" }]);
});

test("normalizeBackendResponse applies source and citation limits after deduplication", () => {
	const normalized = normalizeBackendResponse(NORMALIZER_RESPONSE, { limit: 2 });

	assert.deepEqual(normalized.sources.map((source) => source.url), [
		"https://docs.example/a#annotation",
		"https://source.example/item#first",
	]);
	assert.deepEqual(normalized.citations.map((citation) => citation.url), [
		"https://docs.example/a#annotation",
		"https://citation.example/item#first",
	]);
	assert.deepEqual(normalized.citationUrls, [
		"https://docs.example/a#annotation",
		"https://citation.example/item#first",
	]);
});

test("readSearchStream combines Responses deltas, completed output items, and completed response metadata", async () => {
	const response = streamResponse([
		'data: {"type":"response.output_text.delta","delta":"Live "}\n\n',
		'data: {"type":"response.output_text.delta","delta":"answer"}\n\n',
		'data: {"type":"response.output_item.done","item":{"type":"output_text","text":"Output item text","annotations":[{"type":"url_citation","title":"Stream source","url":"https://stream.example/doc#one","cited_text":"stream quote"}]}}\n\n',
		'data: {"type":"response.completed","response":{"id":"resp_stream","model":"gpt-stream","usage":{"input_tokens":3,"output_tokens":2,"total_tokens":5}}}\n\n',
	]);

	assert.deepEqual(await readSearchStream(response), {
		answer: "Live answer",
		sources: [{ title: "Stream source", url: "https://stream.example/doc#one", snippet: "stream quote" }],
		citations: [{ title: "Stream source", url: "https://stream.example/doc#one", citedText: "stream quote" }],
		citationUrls: ["https://stream.example/doc#one"],
		model: "gpt-stream",
		requestId: "resp_stream",
		usage: { inputTokens: 3, outputTokens: 2, totalTokens: 5 },
		outputItems: [{
			type: "output_text",
			text: "Output item text",
			annotations: [{ type: "url_citation", title: "Stream source", url: "https://stream.example/doc#one", cited_text: "stream quote" }],
		}],
	});
});

test("readSearchStream supports CRLF frames and a final residual frame", async () => {
	const response = streamResponse([
		'data: {"type":"response.output_text.delta","delta":"CRLF "}\r\n\r\n',
		'data: {"type":"response.output_text.delta","delta":"final"}',
	]);

	assert.deepEqual(await readSearchStream(response), {
		answer: "CRLF final",
		sources: [],
		citations: [],
		citationUrls: [],
		model: undefined,
		requestId: undefined,
		usage: undefined,
		outputItems: [],
	});
});

test("readSearchStream requestId is the completed response envelope ID, never an output-item ID", async () => {
	for (const responseId of ["resp_actual", undefined]) {
		const response = streamResponse([
			'data: {"type":"response.output_item.done","item":{"id":"ws_item","type":"web_search_call"}}\n\n',
			'data: {"type":"response.output_item.done","item":{"id":"msg_item","type":"message","content":[{"type":"output_text","text":"Stream answer"}]}}\n\n',
			`data: ${JSON.stringify({ type: "response.completed", response: { ...(responseId ? { id: responseId } : {}), model: "gpt-stream" } })}\n\n`,
		]);
		const normalized = await readSearchStream(response);
		assert.equal(normalized.requestId, responseId);
		assert.equal(searchToolResult("query", normalized).structuredContent.requestId, responseId);
		assert.equal(normalized.answer, "Stream answer");
		assert.deepEqual(normalized.outputItems.map((item) => item.id), ["ws_item", "msg_item"]);
	}
});

test("normalizeBackendResponse does not promote nested output IDs to request metadata", () => {
	assert.equal(normalizeBackendResponse({ output: [{ id: "msg_item", type: "output_text", text: "Answer" }] }).requestId, undefined);
});

test("readSearchStream surfaces Responses stream errors", async () => {
	await assert.rejects(
		() => readSearchStream(streamResponse(['data: {"type":"response.failed","response":{"error":{"message":"search backend failed"}}}\n\n'])),
		(error) => error instanceof SearchBackendError && error.code === "backend_error" && /search backend failed/.test(error.message),
	);
});

test("readSearchStream rejects an oversized unfinished SSE response and cancels its reader", async () => {
	const tracked = unfinishedStreamResponse(["data: ", "x".repeat(MEBIBYTE)]);

	await assert.rejects(
		() => readSearchStream(tracked.response),
		(error) => error instanceof SearchBackendError && error.code === "invalid_response" && /1 MiB/.test(error.message),
	);
	assert.equal(tracked.wasCancelled(), true);
	assert.equal(tracked.stream.locked, false);
});

test("readSearchStream rejects streams whose aggregate raw bytes exceed 1 MiB", async () => {
	await assert.rejects(
		() => readSearchStream(streamResponse(["x".repeat(MEBIBYTE - 1), "xx"])),
		(error) => error instanceof SearchBackendError && error.code === "invalid_response" && /1 MiB/.test(error.message),
	);
});

test("ResponsesClient rejects oversized JSON and error response bodies", async () => {
	const jsonClient = new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => new Response(`{"output_text":"${"x".repeat(MEBIBYTE)}"}`),
	});
	const errorClient = new ResponsesClient({
		baseUrl: "https://api.example",
		fetchImpl: async () => new Response("x".repeat(MEBIBYTE + 1), { status: 500 }),
	});

	for (const client of [jsonClient, errorClient]) {
		await assert.rejects(
			() => client.post({ model: "gpt-5.4-mini" }),
			(error) => error instanceof SearchBackendError && error.code === "invalid_response" && /1 MiB/.test(error.message),
		);
	}
});

test("ResponsesClient outbound fetch drops ProviderHeaders null deletion markers", async () => {
	let captured;
	const client = new ResponsesClient({
		baseUrl: "https://api.example",
		apiKey: "fallback-key",
		headers: {
			Authorization: null,
			"x-api-key": null,
			"cf-aig-authorization": "Bearer gateway-token",
			"X-Test": "kept",
		},
		fetchImpl: async (_input, init) => {
			const headers = new Headers(init?.headers);
			captured = {
				has: (name) => headers.has(name),
				get: (name) => headers.get(name),
				values: () => [...headers.values()],
			};
			return new Response(JSON.stringify({
				id: "resp_headers",
				model: "gpt-5.4-mini",
				output: [{ type: "output_text", text: "ok" }],
			}), { headers: { "content-type": "application/json" } });
		},
	});

	await client.post({ model: "gpt-5.4-mini" });
	assert.ok(captured, "client must issue an outbound fetch");
	assert.equal(captured.has("Authorization"), false);
	assert.equal(captured.has("x-api-key"), false);
	assert.equal(captured.get("cf-aig-authorization"), "Bearer gateway-token");
	assert.equal(captured.get("X-Test"), "kept");
	assert.equal(captured.values().includes("null"), false);
});

test("ResponsesClient outbound fetch adds Authorization Bearer when headers are empty", async () => {
	let captured;
	const client = new ResponsesClient({
		baseUrl: "https://api.example",
		apiKey: "fallback-key",
		headers: {},
		fetchImpl: async (_input, init) => {
			const headers = new Headers(init?.headers);
			captured = headers.get("Authorization");
			return new Response(JSON.stringify({
				id: "resp_bearer",
				model: "gpt-5.4-mini",
				output: [{ type: "output_text", text: "ok" }],
			}), { headers: { "content-type": "application/json" } });
		},
	});

	await client.post({ model: "gpt-5.4-mini" });
	assert.equal(captured, "Bearer fallback-key");
});

test("readSearchStream bounds backend error text to 1000 characters", async () => {
	await assert.rejects(
		() => readSearchStream(streamResponse([`data: {"type":"error","message":"${"x".repeat(1001)}"}\n\n`])),
		(error) => error instanceof SearchBackendError && error.code === "backend_error" && error.message.length === 1000,
	);
});

test("readSearchStream cancels and releases the reader after a parser failure", async () => {
	const tracked = unfinishedStreamResponse(["data: not-json\n\n"]);

	await assert.rejects(
		() => readSearchStream(tracked.response),
		(error) => error instanceof SearchBackendError && error.code === "invalid_response",
	);
	assert.equal(tracked.wasCancelled(), true);
	assert.equal(tracked.stream.locked, false);
});

test("searchToolResult exposes bounded success details for callers", () => {
	const success = searchToolResult("latest Pi release", {
		answer: "Answer text",
		sources: [{ title: "Docs", url: "https://docs.example" }],
		citations: [],
		model: "gpt-5.4-mini",
		requestId: "resp_123",
		usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
	});

	assert.equal(success.details.ok, true);
	assert.equal(success.details.sourceCount, 1);
	assert.equal(success.content[0].text, "Answer text\n\nSources:\n[1] Docs\nhttps://docs.example");
	const withSnippet = searchToolResult("latest Pi release", {
		sources: [{ title: "Docs", url: "https://docs.example", snippet: "excerpt from page" }],
	});
	assert.equal(
		withSnippet.content[0].text,
		"Sources:\n[1] Docs\nhttps://docs.example\nexcerpt from page",
	);
	assert.equal(Object.hasOwn(success.details, "sources"), false);
	assert.equal(Object.hasOwn(success.details, "answer"), false);
	assert.equal(Object.hasOwn(success.details, "citations"), false);
	assert.equal(Object.hasOwn(success.details, "usage"), false);
});

function assertSecretSafeError(error, secrets) {
	assert.ok(error instanceof SearchBackendError);
	for (const secret of secrets) {
		assert.equal(error.message.includes(secret), false, `error leaked ${secret}`);
	}
	assert.match(error.message, /\[redacted\]/);
	assert.match(error.message, /application\/json|user-agent|Mozilla/i);
}

test("ResponsesClient redacts reflected API keys and gateway authorization from HTTP errors", async () => {
	const apiKey = "sk-live-secret-abc123";
	const gatewayAuth = "Bearer gateway-secret-xyz";
	const client = new ResponsesClient({
		baseUrl: "https://api.example",
		apiKey,
		headers: {
			Authorization: gatewayAuth,
			"Content-Type": "application/json",
			"User-Agent": "Mozilla/5.0 web-access-test",
		},
		fetchImpl: async () => new Response(JSON.stringify({
			error: {
				message: `invalid Authorization: ${gatewayAuth}; apiKey=${apiKey}; Content-Type=application/json User-Agent=Mozilla/5.0 web-access-test`,
			},
		}), { status: 401 }),
	});

	await assert.rejects(
		() => client.post({ model: "gpt-5.4-mini" }),
		(error) => {
			assertSecretSafeError(error, [apiKey, gatewayAuth, "gateway-secret-xyz"]);
			assert.equal(error.code, "auth_failed");
			assert.equal(error.status, 401);
			return true;
		},
	);
});

test("ResponsesClient redacts reflected API keys and gateway authorization from SSE errors", async () => {
	const apiKey = "sk-live-secret-abc123";
	const gatewayAuth = "Bearer gateway-secret-xyz";
	const client = new ResponsesClient({
		baseUrl: "https://api.example",
		apiKey,
		headers: {
			"cf-aig-authorization": gatewayAuth,
			"Content-Type": "application/json",
			"User-Agent": "Mozilla/5.0 web-access-test",
		},
		fetchImpl: async () => new Response(
			`data: {"type":"error","message":"authorization=${gatewayAuth} api_key=${apiKey} Content-Type=application/json User-Agent=Mozilla/5.0 web-access-test"}\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		),
	});

	await assert.rejects(
		() => client.post({ model: "gpt-5.4-mini" }),
		(error) => {
			assertSecretSafeError(error, [apiKey, gatewayAuth, "gateway-secret-xyz"]);
			assert.equal(error.code, "backend_error");
			return true;
		},
	);
});

test("ResponsesClient redacts a Bearer token that appears only as the scheme-stripped value", async () => {
	const token = "only-the-token-value";
	const client = new ResponsesClient({
		baseUrl: "https://api.example",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			"User-Agent": "Mozilla/5.0 web-access-test",
		},
		fetchImpl: async () => new Response(JSON.stringify({
			error: { message: `echo token=${token}; Content-Type=application/json User-Agent=Mozilla/5.0 web-access-test` },
		}), { status: 401 }),
	});

	await assert.rejects(
		() => client.post({ model: "gpt-5.4-mini" }),
		(error) => {
			assertSecretSafeError(error, [token]);
			assert.equal(error.code, "auth_failed");
			return true;
		},
	);
});

test("ResponsesClient redacts Ocp-Apim-Subscription-Key without treating content-type as secret", async () => {
	const subscriptionKey = "azure-subscription-key-xyz";
	const client = new ResponsesClient({
		baseUrl: "https://api.example",
		headers: {
			"Ocp-Apim-Subscription-Key": subscriptionKey,
			"Content-Type": "application/json",
			"User-Agent": "Mozilla/5.0 web-access-test",
		},
		fetchImpl: async () => new Response(JSON.stringify({
			error: { message: `subscription=${subscriptionKey}; Content-Type=application/json User-Agent=Mozilla/5.0 web-access-test` },
		}), { status: 403 }),
	});

	await assert.rejects(
		() => client.post({ model: "gpt-5.4-mini" }),
		(error) => {
			assertSecretSafeError(error, [subscriptionKey]);
			assert.equal(error.code, "auth_failed");
			return true;
		},
	);
});

test("ResponsesClient redacts a secret that straddles the 1000-character bound on HTTP and SSE errors", async () => {
	const secret = "boundary-secret-ABCDEFGH";
	const httpPrefix = "x".repeat(980);
	const ssePrefix = "x".repeat(990);
	const httpEcho = `${httpPrefix}${secret}`;
	const sseEcho = `${ssePrefix}${secret}`;
	assert.match(`HTTP 500: ${httpEcho}`.slice(0, 1000), /boundary/);
	assert.match(sseEcho.slice(0, 1000), /boundary/);

	const httpClient = new ResponsesClient({
		baseUrl: "https://api.example",
		headers: { "X-Api-Gateway": secret },
		fetchImpl: async () => new Response(JSON.stringify({ error: { message: httpEcho } }), { status: 500 }),
	});
	await assert.rejects(
		() => httpClient.post({ model: "gpt-5.4-mini" }),
		(error) => {
			assert.ok(error instanceof SearchBackendError);
			assert.equal(error.message.includes(secret), false);
			assert.equal(error.message.includes("boundary-secret"), false);
			assert.match(error.message, /\[redacted\]/);
			assert.ok(error.message.length <= 1000);
			return true;
		},
	);

	const sseClient = new ResponsesClient({
		baseUrl: "https://api.example",
		headers: { "X-Api-Gateway": secret },
		fetchImpl: async () => new Response(
			`data: {"type":"error","message":${JSON.stringify(sseEcho)}}\n\n`,
			{ headers: { "content-type": "text/event-stream" } },
		),
	});
	await assert.rejects(
		() => sseClient.post({ model: "gpt-5.4-mini" }),
		(error) => {
			assert.ok(error instanceof SearchBackendError);
			assert.equal(error.message.includes(secret), false);
			assert.equal(error.message.includes("boundary-secret"), false);
			assert.match(error.message, /\[redacted\]/);
			assert.ok(error.message.length <= 1000);
			return true;
		},
	);
});

test("ResponsesClient classifies tool-choice shape failures and generic 400/422 invalid requests", async () => {
	const cases = [
		{ status: 400, message: "invalid tool_choice", code: "unsupported_tool_choice" },
		{ status: 422, message: "data did not match ModelToolChoice", code: "unsupported_tool_choice" },
		{ status: 400, message: "web_search is not supported", code: "unsupported_tool" },
		{ status: 422, message: "unknown model", code: "unsupported_model" },
		{ status: 400, message: "invalid allowed_domains", code: "invalid_input" },
		{ status: 422, message: "invalid allowed_domains filter", code: "invalid_input" },
	];

	for (const item of cases) {
		const client = new ResponsesClient({
			baseUrl: "https://api.example",
			fetchImpl: async () => new Response(JSON.stringify({ error: { message: item.message } }), { status: item.status }),
		});
		await assert.rejects(
			() => client.post({ model: "gpt-5.4-mini" }),
			(error) => error instanceof SearchBackendError && error.code === item.code && error.status === item.status,
		);
	}
});

test("ResponsesClient converts unexpected Errors without leaking configured URL credentials", async () => {
	const secret = "secret";
	const client = new ResponsesClient({
		baseUrl: "https://user:secret@example.invalid/v1",
		fetchImpl: async (input) => {
			throw new TypeError(`Failed to parse URL from ${String(input)}`);
		},
	});

	await assert.rejects(
		() => client.post({ model: "gpt-5.4-mini" }),
		(error) => {
			assert.ok(error instanceof SearchBackendError);
			assert.equal(error.code, "backend_error");
			assert.equal(error.message.includes(secret), false);
			assert.equal(error.message.includes("user:secret"), false);
			assert.match(error.message, /\[redacted\]/);
			return true;
		},
	);
});
