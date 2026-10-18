import assert from "node:assert/strict";
import test from "node:test";
import { initialContentSlice } from "./fetch-content.ts";
import {
	DEFAULT_MAX_INLINE_CHARS,
	normalizeMaxInlineChars,
	resolveCdpApiKey,
	resolveCdpEndpoint,
	webAccessSettingsFromConfig,
	webAccessSettingsFromConfigs,
} from "./settings.ts";

test("normalizeMaxInlineChars defaults and caps", () => {
	assert.equal(normalizeMaxInlineChars(undefined), DEFAULT_MAX_INLINE_CHARS);
	assert.equal(normalizeMaxInlineChars(0), DEFAULT_MAX_INLINE_CHARS);
	assert.equal(normalizeMaxInlineChars(-1), DEFAULT_MAX_INLINE_CHARS);
	assert.equal(normalizeMaxInlineChars(12_000), 12_000);
	assert.equal(normalizeMaxInlineChars(500_000), 200_000);
});

test("fetch settings leaf overlay for endpoint, maxInlineChars, extract.kernel, and extract.model", () => {
	assert.deepEqual(webAccessSettingsFromConfig({
		webAccess: {
			fetch: {
				cdp: { endpoint: "https://browser.example/json/version" },
				maxInlineChars: 12_000,
				extract: { kernel: "html-extractor", model: "newapi/gpt-extract" },
			},
		},
	}).settings, {
		fetchCdpEndpoint: "https://browser.example/json/version",
		fetchMaxInlineChars: 12_000,
		fetchExtractKernel: "html-extractor",
		fetchExtractModel: { provider: "newapi", modelId: "gpt-extract" },
	});

	assert.deepEqual(webAccessSettingsFromConfigs([
		{
			webAccess: {
				fetch: {
					cdp: { endpoint: "https://global.example/json/version" },
					maxInlineChars: 40_000,
					extract: { kernel: "html-extractor", model: "newapi/global-extract" },
				},
			},
		},
		{
			webAccess: {
				fetch: {
					maxInlineChars: 500_000,
				},
			},
		},
	]).settings, {
		fetchCdpEndpoint: "https://global.example/json/version",
		fetchMaxInlineChars: 200_000,
		fetchExtractKernel: "html-extractor",
		fetchExtractModel: { provider: "newapi", modelId: "global-extract" },
	});

	assert.deepEqual(webAccessSettingsFromConfigs([
		{
			webAccess: {
				fetch: {
					extract: { kernel: "html-extractor" },
				},
			},
		},
		{
			webAccess: {
				fetch: {
					extract: { kernel: "not-a-kernel" },
				},
			},
		},
	]).settings, {
		fetchExtractKernel: "defuddle",
	});

	assert.deepEqual(webAccessSettingsFromConfigs([
		{
			webAccess: {
				fetch: {
					extract: { kernel: "llm", model: "newapi/global-extract" },
				},
			},
		},
		{
			webAccess: {
				fetch: {
					maxInlineChars: 12_000,
					extract: { model: "" },
				},
			},
		},
	]).settings, {
		fetchExtractKernel: "llm",
		fetchMaxInlineChars: 12_000,
	});

	assert.deepEqual(webAccessSettingsFromConfigs([
		{
			webAccess: {
				fetch: {
					extract: { model: "newapi/global-extract" },
				},
			},
		},
		{
			webAccess: {
				fetch: {
					extract: { model: "not-a-qualified-model" },
				},
			},
		},
	]).settings, {});

	assert.deepEqual(webAccessSettingsFromConfig({
		webAccess: {
			fetch: {
				extract: { model: "newapi/gpt-extract:high" },
			},
		},
	}).settings, {
		fetchExtractModel: { provider: "newapi", modelId: "gpt-extract:high" },
	});
});

test("resolveCdpEndpoint prefers env over settings and has no localhost default", () => {
	assert.equal(resolveCdpEndpoint({}, {}), undefined);
	assert.equal(
		resolveCdpEndpoint({ fetchCdpEndpoint: "https://settings.example/json/version" }, {}),
		"https://settings.example/json/version",
	);
	assert.equal(
		resolveCdpEndpoint(
			{ fetchCdpEndpoint: "https://settings.example/json/version" },
			{ CDP_ENDPOINT: "https://env.example/json/version" },
		),
		"https://env.example/json/version",
	);
	assert.equal(resolveCdpApiKey({ CDP_API_KEY: " secret " }), "secret");
	assert.equal(resolveCdpApiKey({}), undefined);
});

test("initialContentSlice cuts on line breaks and marks truncation", () => {
	const content = `${"a".repeat(50)}\n${"b".repeat(50)}\n${"c".repeat(50)}`;
	const slice = initialContentSlice(content, 80);
	assert.equal(slice.truncated, true);
	assert.ok(slice.returnedChars <= 80);
	assert.equal(slice.totalChars, content.length);
	assert.equal(slice.text.includes("c"), false);
	assert.match(slice.text, /^a+\n/);
});
