import assert from "node:assert/strict";
import test from "node:test";
import { clampThinkingLevel as piClampThinkingLevel } from "@earendil-works/pi-ai";
import {
	clampThinkingLevel,
	formatQualifiedModel,
	isThinkingLevel,
	parseQualifiedModel,
	resolveThinkingAwareModel,
	THINKING_LEVELS,
} from "./models.ts";

test("parseQualifiedModel splits on the first slash only", () => {
	assert.deepEqual(parseQualifiedModel("newapi/gpt-5.4-mini"), {
		status: "ok",
		model: { provider: "newapi", modelId: "gpt-5.4-mini" },
	});
	assert.deepEqual(parseQualifiedModel(" homelab/org/grok-4.5 "), {
		status: "ok",
		model: { provider: "homelab", modelId: "org/grok-4.5" },
	});
});

test("parseQualifiedModel keeps colon-bearing model ids intact", () => {
	assert.deepEqual(parseQualifiedModel("openrouter/org/model:exacto"), {
		status: "ok",
		model: { provider: "openrouter", modelId: "org/model:exacto" },
	});
	assert.deepEqual(parseQualifiedModel("newapi/gpt-5.4-mini:high"), {
		status: "ok",
		model: { provider: "newapi", modelId: "gpt-5.4-mini:high" },
	});
});

test("parseQualifiedModel rejects empty provider or model parts", () => {
	assert.deepEqual(parseQualifiedModel(""), { status: "missing" });
	assert.deepEqual(parseQualifiedModel("   "), { status: "missing" });
	assert.deepEqual(parseQualifiedModel(undefined), { status: "missing" });
	assert.deepEqual(parseQualifiedModel("no-slash"), { status: "invalid" });
	assert.deepEqual(parseQualifiedModel("/model"), { status: "invalid" });
	assert.deepEqual(parseQualifiedModel("provider/"), { status: "invalid" });
	assert.deepEqual(parseQualifiedModel(12), { status: "invalid" });
});

test("isThinkingLevel accepts all Pi-native levels", () => {
	for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
	assert.equal(isThinkingLevel("exacto"), false);
	assert.equal(isThinkingLevel("HIGH"), false);
});

test("resolveThinkingAwareModel prefers full colon-bearing ids before suffix parsing", () => {
	const models = new Map([
		["openrouter/org/model:exacto", {
			provider: "openrouter",
			id: "org/model:exacto",
			api: "openai-responses",
			reasoning: true,
		}],
	]);
	const find = (provider, modelId) => models.get(`${provider}/${modelId}`);
	const resolved = resolveThinkingAwareModel(find, {
		provider: "openrouter",
		modelId: "org/model:exacto",
	});
	assert.equal(resolved.status, "ok");
	assert.equal(resolved.modelId, "org/model:exacto");
	assert.equal(resolved.requestedThinkingLevel, "off");
	assert.equal(resolved.thinkingLevel, "off");
});

test("resolveThinkingAwareModel accepts every native thinking level suffix", () => {
	const base = {
		provider: "newapi",
		id: "gpt-extract",
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
	const find = (provider, modelId) => {
		if (provider === "newapi" && modelId === "gpt-extract") return base;
		return undefined;
	};
	for (const level of THINKING_LEVELS) {
		const resolved = resolveThinkingAwareModel(find, {
			provider: "newapi",
			modelId: `gpt-extract:${level}`,
		});
		assert.equal(resolved.status, "ok", level);
		assert.equal(resolved.modelId, "gpt-extract", level);
		assert.equal(resolved.requestedThinkingLevel, level, level);
		assert.equal(resolved.thinkingLevel, level, level);
	}
});

test("resolveThinkingAwareModel rejects invalid thinking suffixes boundedly", () => {
	const find = (provider, modelId) => {
		if (provider === "newapi" && modelId === "gpt-extract") {
			return { provider, id: modelId, api: "openai-responses", reasoning: true };
		}
		return undefined;
	};
	const resolved = resolveThinkingAwareModel(find, {
		provider: "newapi",
		modelId: "gpt-extract:exacto",
	});
	assert.deepEqual(resolved, { status: "invalid_thinking", suffix: "exacto" });
});

test("resolveThinkingAwareModel clamps non-reasoning models to off", () => {
	const find = (provider, modelId) => {
		if (provider === "newapi" && modelId === "plain") {
			return { provider, id: modelId, api: "openai-responses", reasoning: false };
		}
		return undefined;
	};
	const resolved = resolveThinkingAwareModel(find, {
		provider: "newapi",
		modelId: "plain:high",
	});
	assert.equal(resolved.status, "ok");
	assert.equal(resolved.requestedThinkingLevel, "high");
	assert.equal(resolved.thinkingLevel, "off");
});

test("resolveThinkingAwareModel clamps sparse thinkingLevelMap with Pi-native nearest-level rules", () => {
	const sparse = {
		provider: "newapi",
		id: "sparse",
		api: "openai-responses",
		reasoning: true,
		// Only off and high are supported; xhigh/max require explicit map entries.
		thinkingLevelMap: {
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			// xhigh/max omitted => unsupported
		},
	};
	const find = (provider, modelId) => {
		if (provider === "newapi" && modelId === "sparse") return sparse;
		return undefined;
	};
	// Prove re-export is the native helper, not a local reimplementation.
	assert.equal(clampThinkingLevel, piClampThinkingLevel);
	assert.equal(piClampThinkingLevel(sparse, "xhigh"), "high");
	assert.equal(piClampThinkingLevel(sparse, "low"), "high");

	const high = resolveThinkingAwareModel(find, { provider: "newapi", modelId: "sparse:high" });
	assert.equal(high.status, "ok");
	assert.equal(high.thinkingLevel, piClampThinkingLevel(sparse, "high"));

	const xhigh = resolveThinkingAwareModel(find, { provider: "newapi", modelId: "sparse:xhigh" });
	assert.equal(xhigh.status, "ok");
	// Pi clamp searches upward first, then downward; with only high available, lands on high.
	assert.equal(xhigh.thinkingLevel, piClampThinkingLevel(sparse, "xhigh"));

	const low = resolveThinkingAwareModel(find, { provider: "newapi", modelId: "sparse:low" });
	assert.equal(low.status, "ok");
	assert.equal(low.thinkingLevel, piClampThinkingLevel(sparse, "low"));
});

test("formatQualifiedModel joins provider and modelId", () => {
	assert.equal(formatQualifiedModel({ provider: "newapi", modelId: "gpt-5.4-mini:high" }), "newapi/gpt-5.4-mini:high");
});
