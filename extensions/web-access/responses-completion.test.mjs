import assert from "node:assert/strict";
import test from "node:test";
import {
	buildResponsesTextCompletionBody,
	completeResponsesText,
	responsesReasoningEffort,
	RESPONSES_COMPLETION_API,
} from "./responses-completion.ts";
import { SearchBackendError } from "./responses-client.ts";

function registryCtx(models = {}, options = {}) {
	const authCalls = options.authCalls ?? [];
	return {
		modelRegistry: {
			find(provider, id) {
				const key = `${provider}/${id}`;
				if (key in models) return models[key];
				if (provider === "newapi" && id === "gpt-5.4-mini") {
					return {
						provider,
						id,
						baseUrl: "https://openai.example/v1",
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
				}
				return undefined;
			},
			async getApiKeyAndHeaders(model) {
				authCalls.push(model);
				if (typeof options.getApiKeyAndHeaders === "function") {
					return options.getApiKeyAndHeaders(model);
				}
				if (model?.failAuth) return { ok: false };
				return {
					ok: true,
					apiKey: "test-key",
					headers: { "X-Test": "1" },
					...(options.authBaseUrl ? { baseUrl: options.authBaseUrl } : {}),
				};
			},
		},
		_authCalls: authCalls,
	};
}

test("responsesReasoningEffort omits off and maps thinkingLevelMap", () => {
	const model = {
		id: "m",
		provider: "newapi",
		reasoning: true,
		thinkingLevelMap: { high: "xhigh-provider", off: "none" },
	};
	assert.equal(responsesReasoningEffort(model, "off"), undefined);
	assert.equal(responsesReasoningEffort(model, "high"), "xhigh-provider");
	assert.equal(responsesReasoningEffort({ id: "m", provider: "p" }, "medium"), "medium");
});

test("buildResponsesTextCompletionBody is tool-free and omits reasoning when off", () => {
	const body = buildResponsesTextCompletionBody({
		modelId: "gpt-5.4-mini",
		instructions: "do merge",
		userText: "merge these",
	});
	assert.equal(body.model, "gpt-5.4-mini");
	assert.equal(body.instructions, "do merge");
	assert.equal(body.stream, false);
	assert.equal(body.store, false);
	assert.equal(Object.hasOwn(body, "tools"), false);
	assert.equal(Object.hasOwn(body, "tool_choice"), false);
	assert.equal(Object.hasOwn(body, "reasoning"), false);
	assert.deepEqual(body.input, [{
		type: "message",
		role: "user",
		content: [{ type: "input_text", text: "merge these" }],
	}]);

	const withReasoning = buildResponsesTextCompletionBody({
		modelId: "gpt-5.4-mini",
		instructions: "do merge",
		userText: "merge these",
		reasoningEffort: "high",
	});
	assert.deepEqual(withReasoning.reasoning, { effort: "high" });
});

test("completeResponsesText posts through ResponsesClient with auth and omits reasoning for off", async () => {
	const posts = [];
	const authCalls = [];
	const ctx = registryCtx({}, { authCalls });
	const result = await completeResponsesText({
		ctx,
		configured: { provider: "newapi", modelId: "gpt-5.4-mini" },
		instructions: "fixed instruction",
		userText: "user payload",
		label: "merge",
		fetchImpl: async (input, init) => {
			posts.push({ url: String(input), body: JSON.parse(init.body), headers: init.headers });
			return new Response(JSON.stringify({ output_text: "  merged answer  " }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	assert.equal(result.text, "merged answer");
	assert.equal(result.api, RESPONSES_COMPLETION_API);
	assert.equal(result.thinkingLevel, "off");
	assert.equal(result.modelId, "gpt-5.4-mini");
	assert.equal(authCalls.length, 1);
	assert.equal(posts.length, 1);
	assert.equal(posts[0].url, "https://openai.example/v1/responses");
	assert.equal(posts[0].body.model, "gpt-5.4-mini");
	assert.equal(posts[0].body.instructions, "fixed instruction");
	assert.equal(Object.hasOwn(posts[0].body, "reasoning"), false);
	assert.equal(Object.hasOwn(posts[0].body, "tools"), false);
	assert.match(posts[0].headers.Authorization ?? posts[0].headers.authorization ?? "", /Bearer test-key/);
});

test("completeResponsesText sends mapped reasoning.effort for thinking suffix", async () => {
	const posts = [];
	const result = await completeResponsesText({
		ctx: registryCtx(),
		configured: { provider: "newapi", modelId: "gpt-5.4-mini:high" },
		instructions: "fixed",
		userText: "payload",
		label: "extract",
		fetchImpl: async (_input, init) => {
			posts.push(JSON.parse(init.body));
			return new Response(JSON.stringify({ output_text: "# From model" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	assert.equal(result.thinkingLevel, "high");
	assert.deepEqual(posts[0].reasoning, { effort: "high" });
	assert.equal(posts[0].model, "gpt-5.4-mini");
});

test("completeResponsesText uses auth baseUrl override", async () => {
	const posts = [];
	await completeResponsesText({
		ctx: registryCtx({}, { authBaseUrl: "https://proxy.example/v1" }),
		configured: { provider: "newapi", modelId: "gpt-5.4-mini" },
		instructions: "fixed",
		userText: "payload",
		label: "merge",
		fetchImpl: async (input) => {
			posts.push(String(input));
			return new Response(JSON.stringify({ output_text: "ok" }), {
				status: 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	assert.equal(posts[0], "https://proxy.example/v1/responses");
});

test("completeResponsesText rejects non-responses api and invalid thinking", async () => {
	await assert.rejects(
		() => completeResponsesText({
			ctx: registryCtx({
				"newapi/wrong-api": {
					provider: "newapi",
					id: "wrong-api",
					baseUrl: "https://openai.example/v1",
					api: "openai-completions",
				},
			}),
			configured: { provider: "newapi", modelId: "wrong-api" },
			instructions: "fixed",
			userText: "payload",
			label: "merge",
		}),
		(error) => error instanceof SearchBackendError
			&& error.code === "unsupported_model"
			&& /openai-responses/.test(error.message),
	);

	await assert.rejects(
		() => completeResponsesText({
			ctx: registryCtx(),
			configured: { provider: "newapi", modelId: "gpt-5.4-mini:exacto" },
			instructions: "fixed",
			userText: "payload",
			label: "merge",
		}),
		(error) => error instanceof SearchBackendError
			&& error.code === "missing_config"
			&& /Invalid thinking level/.test(error.message),
	);
});

test("completeResponsesText redacts auth failures and enforces empty/1MiB bounds", async () => {
	await assert.rejects(
		() => completeResponsesText({
			ctx: registryCtx({
				"newapi/gpt-5.4-mini": {
					provider: "newapi",
					id: "gpt-5.4-mini",
					baseUrl: "https://openai.example/v1",
					api: "openai-responses",
					failAuth: true,
				},
			}),
			configured: { provider: "newapi", modelId: "gpt-5.4-mini" },
			instructions: "fixed",
			userText: "payload",
			label: "merge",
		}),
		(error) => error instanceof SearchBackendError && error.code === "auth_failed",
	);

	await assert.rejects(
		() => completeResponsesText({
			ctx: registryCtx(),
			configured: { provider: "newapi", modelId: "gpt-5.4-mini" },
			instructions: "fixed",
			userText: "payload",
			label: "merge",
			fetchImpl: async () => new Response(JSON.stringify({ output_text: "   " }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		}),
		(error) => error instanceof SearchBackendError
			&& error.code === "invalid_response"
			&& /no answer/.test(error.message),
	);

	await assert.rejects(
		() => completeResponsesText({
			ctx: registryCtx(),
			configured: { provider: "newapi", modelId: "gpt-5.4-mini" },
			instructions: "fixed",
			userText: "payload",
			label: "merge",
			fetchImpl: async () => new Response("x".repeat(1024 * 1024 + 8), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		}),
		(error) => error instanceof SearchBackendError
			&& error.code === "invalid_response"
			&& /MiB size limit/i.test(error.message),
	);

	await assert.rejects(
		() => completeResponsesText({
			ctx: registryCtx(),
			configured: { provider: "newapi", modelId: "gpt-5.4-mini" },
			instructions: "fixed",
			userText: "payload",
			label: "extract",
			fetchImpl: async () => new Response(
				JSON.stringify({ error: { message: "401 unauthorized Authorization: Bearer sk-live-secret" } }),
				{ status: 401, headers: { "content-type": "application/json" } },
			),
		}),
		(error) => error instanceof SearchBackendError
			&& error.code === "auth_failed"
			&& !error.message.includes("sk-live-secret"),
	);
});
