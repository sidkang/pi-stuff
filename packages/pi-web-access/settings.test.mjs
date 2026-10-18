import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readWebAccessSettings, webAccessSettingsFromConfig, webAccessSettingsFromConfigs } from "./settings.ts";

const SAMPLE = {
	webAccess: {
		openai: { model: "newapi/gpt-5.4-mini" },
		xai: { model: "homelab/grok-4.5" },
	},
};

test("webAccessSettingsFromConfig reads provider-qualified models", () => {
	assert.deepEqual(webAccessSettingsFromConfig(SAMPLE), {
		settings: {
			openai: { provider: "newapi", modelId: "gpt-5.4-mini" },
			xai: { provider: "homelab", modelId: "grok-4.5" },
		},
		errors: [],
	});
});

test("webAccessSettingsFromConfig ignores removed Codex Tools search settings", () => {
	assert.deepEqual(webAccessSettingsFromConfig({
		codexTools: { webSearch: { provider: "newapi", model: "gpt-5.4-mini" } },
	}), { settings: {}, errors: [] });
});

test("webAccessSettingsFromConfigs overlays only present source models", () => {
	assert.deepEqual(webAccessSettingsFromConfigs([
		{ webAccess: { openai: { model: "newapi/global-openai" }, xai: { model: "homelab/global-xai" } } },
		{ webAccess: { openai: { model: "newapi/org/project-openai" } } },
	]), {
		settings: {
			openai: { provider: "newapi", modelId: "org/project-openai" },
			xai: { provider: "homelab", modelId: "global-xai" },
		},
		errors: [],
	});
});

test("invalid source models are reported and do not become configured sources", () => {
	assert.deepEqual(webAccessSettingsFromConfig({
		webAccess: { openai: { model: "no-slash" }, xai: { model: "/missing-provider" } },
	}), {
		settings: {},
		errors: [
			{ source: "openai", message: "Invalid webAccess.openai.model. Use a provider-qualified model such as newapi/gpt-5.4-mini or newapi/gpt-5.4-mini:high." },
			{ source: "xai", message: "Invalid webAccess.xai.model. Use a provider-qualified model such as newapi/gpt-5.4-mini or newapi/gpt-5.4-mini:high." },
		],
	});
});

test("a later valid source model replaces an earlier invalid one", () => {
	assert.deepEqual(webAccessSettingsFromConfigs([
		{ webAccess: { openai: { model: "bad" } } },
		{ webAccess: { openai: { model: "newapi/gpt-5.4-mini" } } },
	]), {
		settings: { openai: { provider: "newapi", modelId: "gpt-5.4-mini" } },
		errors: [],
	});
});

test("settings preserve thinking suffixes on search and extract models", () => {
	assert.deepEqual(webAccessSettingsFromConfig({
		webAccess: {
			openai: { model: "newapi/gpt-5.4-mini:high" },
			xai: { model: "homelab/grok-4.5:medium" },
			fetch: { extract: { model: "codex/gpt-5.6-luna:max" } },
		},
	}), {
		settings: {
			openai: { provider: "newapi", modelId: "gpt-5.4-mini:high" },
			xai: { provider: "homelab", modelId: "grok-4.5:medium" },
			fetchExtractModel: { provider: "codex", modelId: "gpt-5.6-luna:max" },
		},
		errors: [],
	});
});

test("removed search defaults and merge settings are ignored; fetch defaults still apply", () => {
	for (const defaultProvider of ["all", "fallback", "openai", "exa"]) {
		assert.deepEqual(webAccessSettingsFromConfigs([
			{ webAccess: { defaultProvider, merge: { enabled: true, model: "newapi/merge" } } },
			{ webAccess: { merge: { model: "invalid" }, fetch: { defaultProvider: "firecrawl" } } },
		]), { settings: { fetchDefaultProvider: "firecrawl" }, errors: [] });
	}
});

test("readWebAccessSettings reads cwd project settings only for trusted projects", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const temp = mkdtempSync(join(tmpdir(), "web-access-settings-"));
	try {
		const agentDir = join(temp, "agent");
		const cwd = join(temp, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			webAccess: { openai: { model: "newapi/global-openai" }, xai: { model: "homelab/global-xai" } },
		}));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			webAccess: { openai: { model: "newapi/project-openai" } },
		}));
		process.env.PI_CODING_AGENT_DIR = agentDir;

		const untrusted = readWebAccessSettings({ cwd, isProjectTrusted: () => false });
		assert.deepEqual(untrusted.settings.openai, { provider: "newapi", modelId: "global-openai" });
		assert.deepEqual(untrusted.settings.xai, { provider: "homelab", modelId: "global-xai" });

		const trusted = readWebAccessSettings({ cwd, isProjectTrusted: () => true });
		assert.deepEqual(trusted.settings.openai, { provider: "newapi", modelId: "project-openai" });
		assert.deepEqual(trusted.settings.xai, { provider: "homelab", modelId: "global-xai" });
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temp, { recursive: true, force: true });
	}
});
