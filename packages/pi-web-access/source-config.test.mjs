import assert from "node:assert/strict";
import test from "node:test";
import { SearchBackendError } from "./responses-client.ts";
import { resolveModelAccess, resolveSourceConfig } from "./source-config.ts";

function registry(model, auth) {
	return {
		find(provider, id) {
			if (provider === model.provider && id === model.id) return model;
			return undefined;
		},
		async getApiKeyAndHeaders() {
			return auth;
		},
	};
}

async function resolveSource(source, model, auth) {
	return resolveSourceConfig(
		{ modelRegistry: registry(model, auth) },
		source,
		{ provider: model.provider, modelId: model.id },
	);
}

async function resolveXai(model, auth) {
	return resolveSource("xai", model, auth);
}

async function resolveOpenai(model, auth) {
	return resolveSource("openai", model, auth);
}

test("xAI source rejects a direct official api.x.ai model endpoint", async () => {
	await assert.rejects(
		() => resolveXai(
			{ provider: "xai", id: "grok-4.5", baseUrl: "https://api.x.ai/v1", api: "openai-responses" },
			{ ok: true, apiKey: "key", headers: {} },
		),
		(error) => error instanceof SearchBackendError
			&& error.code === "missing_config"
			&& /CLIProxyAPI/.test(error.message)
			&& /api\.x\.ai/.test(error.message),
	);
});

test("xAI source rejects an auth baseUrl override to api.x.ai", async () => {
	await assert.rejects(
		() => resolveXai(
			{ provider: "xai", id: "grok-4.5", baseUrl: "https://cliproxy.example/v1", api: "openai-responses" },
			{ ok: true, apiKey: "key", headers: {}, baseUrl: "https://api.x.ai/v1" },
		),
		(error) => error instanceof SearchBackendError
			&& error.code === "missing_config"
			&& /CLIProxyAPI/.test(error.message),
	);
});

test("xAI source accepts a non-x.ai proxy even when the Pi provider name is xai", async () => {
	const resolved = await resolveXai(
		{ provider: "xai", id: "grok-4.5", baseUrl: "https://cliproxy.example/v1", api: "openai-responses" },
		{ ok: true, apiKey: "key", headers: {} },
	);
	assert.equal(resolved.provider, "xai");
	assert.equal(resolved.baseUrl, "https://cliproxy.example/v1");
	assert.equal(resolved.model, "grok-4.5");
});

test("xAI source uses the auth baseUrl override when it is a proxy", async () => {
	const resolved = await resolveXai(
		{ provider: "xai", id: "grok-4.5", baseUrl: "https://api.x.ai/v1", api: "openai-responses" },
		{ ok: true, apiKey: "key", headers: {}, baseUrl: "https://cliproxy.example/v1" },
	);
	assert.equal(resolved.baseUrl, "https://cliproxy.example/v1");
});

test("xAI source rejects a malformed resolved URL", async () => {
	await assert.rejects(
		() => resolveXai(
			{ provider: "xai", id: "grok-4.5", baseUrl: "not a url", api: "openai-responses" },
			{ ok: true, apiKey: "key", headers: {} },
		),
		(error) => error instanceof SearchBackendError
			&& error.code === "missing_config"
			&& /CLIProxyAPI/.test(error.message),
	);
});

function assertCredentialedBaseUrlRejected(error, source, candidate) {
	assert.ok(error instanceof SearchBackendError);
	assert.equal(error.code, "missing_config");
	assert.equal(error.message, `Invalid ${source} model base URL.`);
	assert.equal(error.message.includes(candidate), false);
	assert.equal(error.message.includes("user"), false);
	assert.equal(error.message.includes("secret"), false);
	return true;
}

test("openai and xAI sources reject base URLs that contain username or password without echoing them", async () => {
	const candidate = "https://user:secret@example.invalid/v1";
	await assert.rejects(
		() => resolveOpenai(
			{ provider: "openai", id: "gpt-5.4-mini", baseUrl: candidate, api: "openai-responses" },
			{ ok: true, apiKey: "key", headers: {} },
		),
		(error) => assertCredentialedBaseUrlRejected(error, "openai", candidate),
	);
	await assert.rejects(
		() => resolveXai(
			{ provider: "xai", id: "grok-4.5", baseUrl: candidate, api: "openai-responses" },
			{ ok: true, apiKey: "key", headers: {} },
		),
		(error) => assertCredentialedBaseUrlRejected(error, "xai", candidate),
	);
});

function multiModelRegistry(models, auth) {
	const byKey = new Map(models.map((model) => [`${model.provider}/${model.id}`, model]));
	return {
		find(provider, id) {
			return byKey.get(`${provider}/${id}`);
		},
		async getApiKeyAndHeaders() {
			return auth;
		},
	};
}

test("unsuffixed search models keep off thinking and omit reasoningEffort", async () => {
	const resolved = await resolveOpenai(
		{ provider: "openai", id: "gpt-5.4-mini", baseUrl: "https://openai.example/v1", api: "openai-completions" },
		{ ok: true, apiKey: "key", headers: {} },
	);
	assert.equal(resolved.api, "openai-completions");
	assert.equal(resolved.requestedThinkingLevel, "off");
	assert.equal(resolved.thinkingLevel, "off");
	assert.equal(Object.hasOwn(resolved, "reasoningEffort"), false);
});

test("thinking-suffixed search models map reasoning.effort and require openai-responses", async () => {
	const model = {
		provider: "xai",
		id: "grok-4.5",
		baseUrl: "https://cliproxy.example/v1",
		api: "openai-responses",
		reasoning: true,
		thinkingLevelMap: { high: "xhigh-provider" },
	};
	const resolved = await resolveSourceConfig(
		{ modelRegistry: multiModelRegistry([model], { ok: true, apiKey: "key", headers: {} }) },
		"xai",
		{ provider: "xai", modelId: "grok-4.5:high" },
	);
	assert.equal(resolved.model, "grok-4.5");
	assert.equal(resolved.requestedThinkingLevel, "high");
	assert.equal(resolved.thinkingLevel, "high");
	assert.equal(resolved.reasoningEffort, "xhigh-provider");

	const custom = await resolveSourceConfig(
		{ modelRegistry: multiModelRegistry([{ ...model, api: "custom-response" }], { ok: true, apiKey: "key", headers: {} }) },
		"xai",
		{ provider: "xai", modelId: "grok-4.5:high" },
	);
	assert.equal(custom.reasoningEffort, "xhigh-provider");
});

test("thinking-suffixed non-responses search models are rejected while unsuffixed legacy remains", async () => {
	const model = {
		provider: "openai",
		id: "gpt-5.4-mini",
		baseUrl: "https://openai.example/v1",
		api: "openai-completions",
		reasoning: true,
	};
	const registry = multiModelRegistry([model], { ok: true, apiKey: "key", headers: {} });
	const unsuffixed = await resolveSourceConfig(
		{ modelRegistry: registry },
		"openai",
		{ provider: "openai", modelId: "gpt-5.4-mini" },
	);
	assert.equal(unsuffixed.api, "openai-completions");
	assert.equal(Object.hasOwn(unsuffixed, "reasoningEffort"), false);

	await assert.rejects(
		() => resolveSourceConfig(
			{ modelRegistry: registry },
			"openai",
			{ provider: "openai", modelId: "gpt-5.4-mini:low" },
		),
		(error) => error instanceof SearchBackendError
			&& error.code === "unsupported_model"
			&& /must use openai-responses when a thinking level is set/.test(error.message),
	);
});

test("search model thinking resolution prefers full colon-bearing ids and rejects invalid suffixes boundedly", async () => {
	const colonId = {
		provider: "openai",
		id: "gpt-5.4-mini:exacto",
		baseUrl: "https://openai.example/v1",
		api: "openai-responses",
		reasoning: true,
	};
	const base = {
		provider: "openai",
		id: "gpt-5.4-mini",
		baseUrl: "https://openai.example/v1",
		api: "openai-responses",
		reasoning: true,
	};
	const registry = multiModelRegistry([colonId, base], { ok: true, apiKey: "key", headers: {} });

	const fullId = await resolveSourceConfig(
		{ modelRegistry: registry },
		"openai",
		{ provider: "openai", modelId: "gpt-5.4-mini:exacto" },
	);
	assert.equal(fullId.model, "gpt-5.4-mini:exacto");
	assert.equal(fullId.requestedThinkingLevel, "off");
	assert.equal(Object.hasOwn(fullId, "reasoningEffort"), false);

	await assert.rejects(
		() => resolveSourceConfig(
			{ modelRegistry: registry },
			"openai",
			{ provider: "openai", modelId: "gpt-5.4-mini:exacto-level" },
		),
		(error) => error instanceof SearchBackendError
			&& error.code === "missing_config"
			&& /Invalid thinking level in openai model \(exacto-level\)/.test(error.message)
			&& !error.message.includes("Authorization"),
	);
});

test("model access bounds and redacts thrown registry and authentication errors", async () => {
	const configured = { provider: "openai", modelId: "gpt-5.4-mini" };
	await assert.rejects(
		() => resolveModelAccess({
			modelRegistry: {
				find() {
					throw new Error(`Authorization: Bearer registry-secret ${"x".repeat(2000)}`);
				},
			},
		}, configured, { label: "merge" }),
		(error) => error instanceof SearchBackendError
			&& error.message.length <= 1000
			&& !error.message.includes("registry-secret"),
	);

	await assert.rejects(
		() => resolveModelAccess({
			modelRegistry: {
				find() {
					return { provider: "openai", id: "gpt-5.4-mini", baseUrl: "https://openai.example/v1", api: "openai-responses" };
				},
				async getApiKeyAndHeaders() {
					throw new Error(`api_key=auth-secret ${"y".repeat(2000)}`);
				},
			},
		}, configured, { label: "merge" }),
		(error) => error instanceof SearchBackendError
			&& error.message.length <= 1000
			&& !error.message.includes("auth-secret"),
	);
});
