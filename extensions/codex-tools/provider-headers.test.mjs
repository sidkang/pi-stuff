import assert from "node:assert/strict";
import test from "node:test";
import { buildRequestHeaders, rawProviderHeaders } from "./provider-headers.ts";

test("rawProviderHeaders keeps null deletion markers and string headers", () => {
	assert.deepEqual(
		rawProviderHeaders({
			Authorization: null,
			"X-Test": "keep-me",
			"X-Empty": "",
			"X-Number": 1,
		}),
		{
			Authorization: null,
			"X-Test": "keep-me",
			"X-Empty": "",
		},
	);
});

test("rawProviderHeaders tolerates missing or non-object input", () => {
	assert.deepEqual(rawProviderHeaders(undefined), {});
	assert.deepEqual(rawProviderHeaders(null), {});
	assert.deepEqual(rawProviderHeaders("Authorization"), {});
	assert.deepEqual(rawProviderHeaders(["X-Test", "value"]), {});
});

test("buildRequestHeaders suppresses Authorization Bearer when ProviderHeaders deletes it", () => {
	const headers = buildRequestHeaders(
		{
			Authorization: null,
			"x-api-key": null,
			"cf-aig-authorization": "Bearer gateway-token",
			"X-Test": "kept",
		},
		"fallback-key",
		{ "Content-Type": "application/json" },
	);
	assert.equal(Object.hasOwn(headers, "Authorization"), false);
	assert.equal(Object.hasOwn(headers, "authorization"), false);
	assert.equal(Object.hasOwn(headers, "x-api-key"), false);
	assert.equal(headers["cf-aig-authorization"], "Bearer gateway-token");
	assert.equal(headers["X-Test"], "kept");
	assert.equal(headers["Content-Type"], "application/json");
	assert.equal(Object.values(headers).includes("null"), false);
});

test("buildRequestHeaders adds Authorization Bearer for empty headers and apiKey", () => {
	assert.deepEqual(buildRequestHeaders({}, "fallback-key"), {
		Authorization: "Bearer fallback-key",
	});
	assert.deepEqual(buildRequestHeaders(undefined, "fallback-key", { Accept: "application/json" }), {
		Authorization: "Bearer fallback-key",
		Accept: "application/json",
	});
});

test("buildRequestHeaders keeps an explicit Authorization string and does not replace it", () => {
	assert.deepEqual(
		buildRequestHeaders({ Authorization: "Bearer explicit" }, "fallback-key"),
		{ Authorization: "Bearer explicit" },
	);
});
