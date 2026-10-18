import assert from "node:assert/strict";
import test from "node:test";
import { ExtractionKernelError } from "./extract-error.ts";
import {
	DEFAULT_BEGIN_MARKER,
	DEFAULT_END_MARKER,
	LLM_PAGE_DATA_MAX_CHARS,
	LLM_TITLE_MAX_CHARS,
	LLM_URL_MAX_CHARS,
	buildLlmExtractionUserText,
	chooseUntrustedPageMarkers,
	extractWithLlm,
	hardTruncatePageData,
} from "./extract-llm.ts";

function registryWithModel(model, options = {}) {
	const authCalls = options.authCalls ?? [];
	return {
		find(provider, modelId) {
			if (typeof options.find === "function") return options.find(provider, modelId);
			if (provider === model.provider && modelId === model.id) return model;
			return undefined;
		},
		async getApiKeyAndHeaders(found) {
			authCalls.push(found);
			if (typeof options.getApiKeyAndHeaders === "function") {
				return options.getApiKeyAndHeaders(found);
			}
			return {
				ok: true,
				apiKey: "extract-key",
				headers: { "X-Extract": "1" },
				...(options.authBaseUrl ? { baseUrl: options.authBaseUrl } : {}),
			};
		},
		_authCalls: authCalls,
	};
}

test("hardTruncatePageData bounds page payload without partial-line heuristics", () => {
	const small = hardTruncatePageData("hello");
	assert.equal(small.truncated, false);
	assert.equal(small.text, "hello");

	const huge = "x".repeat(LLM_PAGE_DATA_MAX_CHARS + 25);
	const truncated = hardTruncatePageData(huge);
	assert.equal(truncated.truncated, true);
	assert.equal(truncated.text.length, LLM_PAGE_DATA_MAX_CHARS);
	assert.equal(truncated.totalChars, huge.length);
});

test("chooseUntrustedPageMarkers starts at defaults and extends past collisions", () => {
	assert.deepEqual(chooseUntrustedPageMarkers("<html>ok</html>"), {
		begin: DEFAULT_BEGIN_MARKER,
		end: DEFAULT_END_MARKER,
	});
	const colliding = `${DEFAULT_BEGIN_MARKER}\nbody\n${DEFAULT_END_MARKER}`;
	const markers = chooseUntrustedPageMarkers(colliding);
	assert.notEqual(markers.begin, DEFAULT_BEGIN_MARKER);
	assert.notEqual(markers.end, DEFAULT_END_MARKER);
	assert.ok(!colliding.includes(markers.begin));
	assert.ok(!colliding.includes(markers.end));
});

test("buildLlmExtractionUserText keeps raw hard-truncated HTML with collision-free markers", () => {
	const pageHtml = "<html><body>article</body></html>";
	const requestedUrl = "https://example.com/start";
	const finalUrl = "https://example.com/end";
	const titleHint = "Title";
	const user = buildLlmExtractionUserText({
		html: pageHtml,
		url: finalUrl,
		requestedUrl,
		titleHint,
	});
	assert.ok(user.includes(pageHtml));
	assert.ok(user.includes(DEFAULT_BEGIN_MARKER));
	assert.ok(user.includes(DEFAULT_END_MARKER));
	assert.match(user, /untrusted page data/i);
	assert.doesNotMatch(user, /base64/i);
});

test("buildLlmExtractionUserText avoids marker collisions from title and URLs", () => {
	const pageHtml = "<html><body>article</body></html>";
	const requestedUrl = `https://example.com/${DEFAULT_BEGIN_MARKER}`;
	const finalUrl = `https://example.com/${DEFAULT_END_MARKER}`;
	const titleHint = DEFAULT_BEGIN_MARKER;
	const user = buildLlmExtractionUserText({
		html: pageHtml,
		url: finalUrl,
		requestedUrl,
		titleHint,
	});
	const markers = chooseUntrustedPageMarkers(pageHtml, requestedUrl, finalUrl, titleHint);
	assert.notEqual(markers.begin, DEFAULT_BEGIN_MARKER);
	assert.notEqual(markers.end, DEFAULT_END_MARKER);
	assert.ok(!requestedUrl.includes(markers.begin));
	assert.ok(!finalUrl.includes(markers.end));
	assert.ok(!titleHint.includes(markers.begin));
	assert.ok(!titleHint.includes(markers.end));
	assert.equal(user.split(markers.begin).length - 1, 1);
	assert.equal(user.split(markers.end).length - 1, 1);
	const bodyStart = user.indexOf(markers.begin) + markers.begin.length;
	const bodyEnd = user.indexOf(markers.end, bodyStart);
	const body = user.slice(bodyStart, bodyEnd);
	assert.equal(body, `\n${pageHtml}\n`);
	assert.ok(body.includes(pageHtml));
	assert.doesNotMatch(user, /base64/i);
	assert.ok(user.includes(requestedUrl));
	assert.ok(user.includes(finalUrl));
	assert.ok(user.includes(titleHint));
});

test("buildLlmExtractionUserText bounds huge URL and title fields before marker selection", () => {
	const pageHtml = "<html><body>article</body></html>";
	const requestedUrl = `https://example.com/start/${"r".repeat(LLM_URL_MAX_CHARS)}/${DEFAULT_BEGIN_MARKER}`;
	const finalUrl = `https://example.com/end/${"f".repeat(LLM_URL_MAX_CHARS)}/${DEFAULT_END_MARKER}`;
	const titleHint = `${DEFAULT_BEGIN_MARKER}${"t".repeat(LLM_TITLE_MAX_CHARS)}${DEFAULT_END_MARKER}`;
	const user = buildLlmExtractionUserText({
		html: pageHtml,
		url: finalUrl,
		requestedUrl,
		titleHint,
	});

	const requestedLine = user.split("\n").find((line) => line.startsWith("Requested URL: "));
	const finalLine = user.split("\n").find((line) => line.startsWith("Final URL: "));
	const titleLine = user.split("\n").find((line) => line.startsWith("Title: "));
	assert.ok(requestedLine);
	assert.ok(finalLine);
	assert.ok(titleLine);

	const boundedRequested = requestedLine.slice("Requested URL: ".length);
	const boundedFinal = finalLine.slice("Final URL: ".length);
	const boundedTitle = titleLine.slice("Title: ".length);
	assert.equal(boundedRequested.length, LLM_URL_MAX_CHARS);
	assert.equal(boundedFinal.length, LLM_URL_MAX_CHARS);
	assert.equal(boundedTitle.length, LLM_TITLE_MAX_CHARS);
	assert.equal(boundedRequested, requestedUrl.slice(0, LLM_URL_MAX_CHARS));
	assert.equal(boundedFinal, finalUrl.slice(0, LLM_URL_MAX_CHARS));
	assert.equal(boundedTitle, titleHint.slice(0, LLM_TITLE_MAX_CHARS));

	// Unbounded originals must not appear; markers stay collision-free against bounded fields.
	assert.ok(!user.includes(requestedUrl));
	assert.ok(!user.includes(finalUrl));
	assert.ok(!user.includes(titleHint));
	const markers = chooseUntrustedPageMarkers(pageHtml, boundedRequested, boundedFinal, boundedTitle);
	assert.equal(user.split(markers.begin).length - 1, 1);
	assert.equal(user.split(markers.end).length - 1, 1);
	const bodyStart = user.indexOf(markers.begin) + markers.begin.length;
	const bodyEnd = user.indexOf(markers.end, bodyStart);
	assert.equal(user.slice(bodyStart, bodyEnd), `\n${pageHtml}\n`);
	// Request size remains dominated by the 80k page bound, not attacker-controlled fields.
	assert.ok(user.length < LLM_PAGE_DATA_MAX_CHARS + 8_000);
});

test("extractWithLlm uses ResponsesClient with remaining deadline and no tools", async () => {
	const posts = [];
	const authCalls = [];
	const model = {
		provider: "newapi",
		id: "gpt-extract",
		baseUrl: "https://extract.example/v1",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	};
	const pageHtml = "<html><body>secret-cookie-banner</body></html>";
	const registry = registryWithModel(model, { authCalls });

	const result = await extractWithLlm({
		html: pageHtml,
		url: "https://example.com/page",
		requestedUrl: "https://example.com/page",
		titleHint: "Page",
		model: { provider: "newapi", modelId: "gpt-extract" },
		modelRegistry: registry,
		signal: new AbortController().signal,
		deadlineAt: Date.now() + 12_000,
		fetchImpl: async (input, init) => {
			posts.push({ url: String(input), body: JSON.parse(init.body), headers: init.headers, signal: init.signal });
			return new Response(JSON.stringify({ output_text: "  # From model\r\n\r\nbody  " }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	assert.equal(result.content, "# From model\n\nbody");
	assert.equal(result.title, "Page");
	assert.equal(result.thinkingLevel, "off");
	assert.equal(authCalls.length, 1);
	assert.equal(posts.length, 1);
	assert.equal(posts[0].url, "https://extract.example/v1/responses");
	assert.equal(Object.hasOwn(posts[0].body, "reasoning"), false);
	assert.equal(Object.hasOwn(posts[0].body, "tools"), false);
	assert.equal(posts[0].body.store, false);
	assert.match(posts[0].body.instructions, /untrusted page data only/i);
	const user = posts[0].body.input[0].content[0].text;
	assert.match(user, /Requested URL: https:\/\/example.com\/page/);
	assert.match(user, /Final URL: https:\/\/example.com\/page/);
	assert.match(user, /Title: Page/);
	assert.ok(user.includes(pageHtml));
	assert.ok(user.includes(DEFAULT_BEGIN_MARKER));
	assert.ok(user.includes(DEFAULT_END_MARKER));
	assert.doesNotMatch(user, /base64/i);
	assert.ok(!JSON.stringify(result).includes("secret-cookie-banner"));
});

test("extractWithLlm resolves thinking suffix and sends Responses reasoning.effort", async () => {
	const posts = [];
	const model = {
		provider: "newapi",
		id: "gpt-extract",
		baseUrl: "https://extract.example/v1",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: {
			off: "none",
			minimal: "minimal",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
			max: "max",
		},
	};
	const result = await extractWithLlm({
		html: "<html><body>hi</body></html>",
		url: "https://example.com",
		model: { provider: "newapi", modelId: "gpt-extract:high" },
		modelRegistry: registryWithModel(model),
		deadlineAt: Date.now() + 5_000,
		fetchImpl: async (_input, init) => {
			posts.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ output_text: "# Extracted" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	assert.equal(result.content, "# Extracted");
	assert.equal(result.thinkingLevel, "high");
	assert.deepEqual(posts[0].reasoning, { effort: "high" });
	assert.equal(posts[0].model, "gpt-extract");
});

test("extractWithLlm applies auth baseUrl override to ResponsesClient", async () => {
	const posts = [];
	const model = {
		provider: "newapi",
		id: "gpt-extract",
		baseUrl: "https://origin.example/v1",
		api: "openai-responses",
		reasoning: true,
	};
	const result = await extractWithLlm({
		html: "<html><body>hi</body></html>",
		url: "https://example.com",
		model: { provider: "newapi", modelId: "gpt-extract" },
		modelRegistry: registryWithModel(model, { authBaseUrl: "https://proxy.example/v1" }),
		deadlineAt: Date.now() + 5_000,
		fetchImpl: async (input) => {
			posts.push(String(input));
			return new Response(JSON.stringify({ output_text: "# Proxy" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	assert.equal(result.content, "# Proxy");
	assert.equal(posts[0], "https://proxy.example/v1/responses");
});

test("extractWithLlm rejects invalid thinking suffixes without inventing a model id", async () => {
	await assert.rejects(
		() => extractWithLlm({
			html: "<html></html>",
			url: "https://example.com",
			model: { provider: "newapi", modelId: "gpt-extract:exacto" },
			modelRegistry: {
				find(provider, modelId) {
					if (provider === "newapi" && modelId === "gpt-extract") {
						return { provider, id: modelId, reasoning: true, api: "openai-responses", baseUrl: "https://extract.example/v1" };
					}
					return undefined;
				},
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "k", headers: {} };
				},
			},
		}),
		(error) => error instanceof ExtractionKernelError
			&& error.code === "missing_config"
			&& /Invalid thinking level/i.test(error.message),
	);
});

test("extractWithLlm classifies missing model, empty output, oversized response, and auth failures generically", async () => {
	await assert.rejects(
		() => extractWithLlm({
			html: "<html></html>",
			url: "https://example.com",
			model: { provider: "newapi", modelId: "missing" },
			modelRegistry: {
				find() { return undefined; },
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "k", headers: {} };
				},
			},
		}),
		(error) => error instanceof ExtractionKernelError
			&& error.code === "missing_config"
			&& /not found/i.test(error.message),
	);

	const model = {
		provider: "newapi",
		id: "gpt-extract",
		baseUrl: "https://extract.example/v1",
		api: "openai-responses",
	};

	await assert.rejects(
		() => extractWithLlm({
			html: "<html></html>",
			url: "https://example.com",
			model: { provider: "newapi", modelId: "gpt-extract" },
			modelRegistry: registryWithModel(model),
			fetchImpl: async () => new Response(JSON.stringify({ output_text: "   \n  " }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		}),
		(error) => error instanceof ExtractionKernelError
			&& error.code === "backend_error"
			&& error.message === "llm returned empty markdown.",
	);

	await assert.rejects(
		() => extractWithLlm({
			html: "<html></html>",
			url: "https://example.com",
			model: { provider: "newapi", modelId: "gpt-extract" },
			modelRegistry: registryWithModel(model),
			fetchImpl: async () => new Response("a".repeat(1024 * 1024 + 8), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		}),
		(error) => error instanceof ExtractionKernelError
			&& error.code === "backend_error"
			&& error.message === "llm completion failed",
	);

	const pageSentinel = "PAGE_SENTINEL_DO_NOT_ECHO_xyz789";
	await assert.rejects(
		() => extractWithLlm({
			html: `<html><body>${pageSentinel}</body></html>`,
			url: "https://example.com",
			model: { provider: "newapi", modelId: "gpt-extract" },
			modelRegistry: registryWithModel(model),
			fetchImpl: async () => new Response(
				JSON.stringify({ error: { message: `401 unauthorized Authorization: Bearer sk-live-secret-token reflected ${pageSentinel}` } }),
				{ status: 401, headers: { "content-type": "application/json" } },
			),
		}),
		(error) => error instanceof ExtractionKernelError
			&& error.code === "auth_error"
			&& error.message === "llm authentication failed"
			&& !error.message.includes("sk-live-secret-token")
			&& !error.message.includes(pageSentinel)
			&& !error.message.includes("Authorization"),
	);

	await assert.rejects(
		() => extractWithLlm({
			html: `<html><body>${pageSentinel}</body></html>`,
			url: "https://example.com",
			model: { provider: "newapi", modelId: "gpt-extract" },
			modelRegistry: registryWithModel(model),
			fetchImpl: async () => new Response(
				JSON.stringify({ error: { message: `provider boom with page prefix ${pageSentinel}` } }),
				{ status: 500, headers: { "content-type": "application/json" } },
			),
		}),
		(error) => error instanceof ExtractionKernelError
			&& error.code === "backend_error"
			&& error.message === "llm completion failed"
			&& !error.message.includes("provider boom")
			&& !error.message.includes(pageSentinel),
	);
});

test("extractWithLlm bounds a stalled Responses call with only deadlineAt/timeoutMs", async () => {
	const model = {
		provider: "newapi",
		id: "gpt-extract",
		baseUrl: "https://extract.example/v1",
		api: "openai-responses",
		reasoning: true,
	};
	const started = Date.now();
	await assert.rejects(
		() => extractWithLlm({
			html: "<html><body>stalled</body></html>",
			url: "https://example.com",
			model: { provider: "newapi", modelId: "gpt-extract" },
			modelRegistry: registryWithModel(model),
			deadlineAt: Date.now() + 40,
			// Intentionally omit shared signal so only the remaining original budget bounds the call.
			fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
				const signal = init?.signal;
				if (!signal) {
					reject(new Error("expected a completion signal from deadlineAt"));
					return;
				}
				if (signal.aborted) {
					reject(signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError"));
					return;
				}
				signal.addEventListener("abort", () => {
					reject(signal.reason instanceof Error ? signal.reason : new DOMException("This operation was aborted", "AbortError"));
				}, { once: true });
			}),
		}),
		(error) => (error instanceof Error || error instanceof DOMException)
			&& (error.name === "TimeoutError" || error.name === "AbortError"),
	);
	assert.ok(Date.now() - started < 2_000);
});
