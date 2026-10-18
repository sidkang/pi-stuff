import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import fastMode, { applyFastServiceTier } from "./fast-mode.ts";
import { createMockContext, createMockFunction, createMockPi } from "../../tests/extension-harness.mjs";

const fastModeSettings = {
	eligibleModels: new Set(["gpt-5.5"]),
	defaultEnabledModels: new Set(),
};
const codexModel = { provider: "openai-codex", id: "gpt-5.5", api: "openai-codex-responses" };
const newapiModel = { provider: "newapi", id: "gpt-5.5", api: "openai-responses" };

async function withAgentSettings(settings, run) {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "codex-tools-fast-mode-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
		await run();
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
}

async function withEmptyAgentDir(run) {
	return withAgentSettings({}, run);
}

test("applyFastServiceTier injects priority for configured fast models", () => {
	const payload = { model: "gpt-5.5", input: [] };
	const result = applyFastServiceTier(payload, codexModel, true, fastModeSettings);

	assert.deepEqual(result, { model: "gpt-5.5", input: [], service_tier: "priority" });
	assert.equal(Object.hasOwn(payload, "service_tier"), false);
});

test("applyFastServiceTier supports configured openai-responses models", () => {
	const result = applyFastServiceTier({ model: "gpt-5.5" }, newapiModel, true, fastModeSettings);

	assert.equal(result?.service_tier, "priority");
	assert.equal(applyFastServiceTier({ model: "gpt-5.5" }, { ...newapiModel, api: "custom-response" }, true, fastModeSettings)?.service_tier, "priority");
});

test("applyFastServiceTier does nothing when fast mode is disabled", () => {
	const result = applyFastServiceTier({ model: "gpt-5.5" }, codexModel, false, fastModeSettings);

	assert.equal(result, undefined);
});

test("applyFastServiceTier does not override explicit service_tier", () => {
	const result = applyFastServiceTier({ model: "gpt-5.5", service_tier: "default" }, codexModel, true, fastModeSettings);

	assert.equal(result, undefined);
});

test("applyFastServiceTier requires payload model to match active model id", () => {
	const result = applyFastServiceTier({ model: "openai-codex/gpt-5.5" }, codexModel, true, fastModeSettings);

	assert.equal(result, undefined);
});

test("applyFastServiceTier rejects unsupported models and APIs", () => {
	assert.equal(applyFastServiceTier({ model: "gpt-5.4" }, { provider: "newapi", id: "gpt-5.4", api: "openai-responses" }, true, fastModeSettings), undefined);
	assert.equal(applyFastServiceTier({ model: "gpt-5.5" }, { provider: "newapi", id: "gpt-5.5", api: "openai-completions" }, true, fastModeSettings), undefined);
});

test("default enabled models apply fast mode across providers and can be disabled", async () => {
	await withAgentSettings({
		codexTools: { fastMode: { eligibleModels: ["gpt-5.5"], defaultEnabledModels: ["gpt-5.5"] } },
	}, async () => {
		const harness = createMockPi();
		fastMode(harness.pi);
		const ctx = createMockContext({ model: newapiModel });
		const beforeRequest = harness.handlers.get("before_provider_request")[0];

		assert.deepEqual(beforeRequest({ payload: { model: "gpt-5.5" } }, ctx), { model: "gpt-5.5", service_tier: "priority" });

		await harness.commands.get("unfast").handler([], ctx);
		assert.equal(beforeRequest({ payload: { model: "gpt-5.5" } }, ctx), undefined);
	});
});

test("eligible models not in defaultEnabledModels remain off", async () => {
	await withAgentSettings({
		codexTools: { fastMode: { eligibleModels: ["gpt-5.5"], defaultEnabledModels: [] } },
	}, async () => {
		const harness = createMockPi();
		fastMode(harness.pi);
		const ctx = createMockContext({ model: codexModel });
		const beforeRequest = harness.handlers.get("before_provider_request")[0];

		assert.equal(beforeRequest({ payload: { model: "gpt-5.5" } }, ctx), undefined);
	});
});

test("fast mode registers before thinking in the better footer", async () => {
	await withEmptyAgentDir(async () => {
		const harness = createMockPi();
		fastMode(harness.pi);
		const ctx = createMockContext({ model: codexModel });

		await harness.commands.get("fast").handler([], ctx);

		const registerCall = harness.pi.events.emit.calls.find(([event]) => event === "better-footer:register");
		assert.deepEqual(registerCall?.[1], {
			id: "codex-tools.fast",
			side: "right",
			position: "before",
			order: 0,
			render: "fast",
		});
		assert.deepEqual(ctx.ui.setStatus.calls, []);
	});
});

test("unfast removes the better footer item", async () => {
	await withEmptyAgentDir(async () => {
		const harness = createMockPi();
		fastMode(harness.pi);
		const ctx = createMockContext({ model: codexModel });

		await harness.commands.get("fast").handler([], ctx);
		await harness.commands.get("unfast").handler([], ctx);

		assert.equal(harness.pi.events.emit.calls.some(([event, id]) => event === "better-footer:unregister" && id === "codex-tools.fast"), true);
	});
});

test("unsupported model does not register footer when fast is enabled", async () => {
	await withEmptyAgentDir(async () => {
		const harness = createMockPi();
		fastMode(harness.pi);
		const ctx = createMockContext({ model: { provider: "homelab", id: "deepseek-v4-pro", api: "openai-completions" } });

		await harness.commands.get("fast").handler([], ctx);

		const registerCall = harness.pi.events.emit.calls.find(([event]) => event === "better-footer:register");
		assert.equal(registerCall, undefined);
		assert.equal(harness.pi.events.emit.calls.some(([event]) => event === "better-footer:unregister"), true);
	});
});

test("unconfigured fast-capable model does not register footer", async () => {
	await withEmptyAgentDir(async () => {
		const harness = createMockPi();
		fastMode(harness.pi);
		const ctx = createMockContext({ model: { provider: "newapi", id: "gpt-5.6", api: "openai-responses" } });

		await harness.commands.get("fast").handler([], ctx);

		assert.equal(harness.pi.events.emit.calls.some(([event]) => event === "better-footer:register"), false);
		assert.equal(harness.pi.events.emit.calls.some(([event, id]) => event === "better-footer:unregister" && id === "codex-tools.fast"), true);
	});
});

test("better footer ready unregisters stale fast item for unsupported model", async () => {
	await withEmptyAgentDir(async () => {
		const harness = createMockPi();
		fastMode(harness.pi);
		const ctx = createMockContext({ model: { provider: "homelab", id: "deepseek-v4-pro", api: "openai-completions" } });
		const api = { register: () => assert.fail("unsupported model must not register footer"), unregister: createMockFunction() };

		await harness.commands.get("fast").handler([], ctx);
		harness.pi.events.on.calls.find(([event]) => event === "better-footer:ready")?.[1](api);

		assert.equal(api.unregister.calls.length, 1);
		assert.deepEqual(api.unregister.calls[0], ["codex-tools.fast"]);
	});
});
