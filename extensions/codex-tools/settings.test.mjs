import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fastModeSettingsFromConfig, fastModeSettingsFromConfigs, readCodexToolsSettings, responsesCompactionSettingsFromConfig, responsesCompactionSettingsFromConfigs, reviewSettingsFromConfig, reviewSettingsFromConfigs } from "./settings.ts";

test("readCodexToolsSettings reads cwd project settings only for trusted projects", () => {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const temp = mkdtempSync(join(tmpdir(), "codex-tools-settings-"));
	try {
		const agentDir = join(temp, "agent");
		const projectDir = join(temp, "project");
		const cwd = join(projectDir, "nested", "cwd");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".pi"), { recursive: true });
		mkdirSync(join(cwd, ".pi"), { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
			codexTools: {
				fastMode: { eligibleModels: ["global-model"], defaultEnabledModels: ["global-model"] },
			},
		}));
		writeFileSync(join(projectDir, ".pi", "settings.json"), JSON.stringify({
			codexTools: {
				fastMode: { eligibleModels: ["parent-project-model"] },
			},
		}));
		writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({
			codexTools: {
				fastMode: { eligibleModels: ["cwd-project-model"] },
			},
		}));
		process.env.PI_CODING_AGENT_DIR = agentDir;

		assert.deepEqual([...readCodexToolsSettings({ cwd, isProjectTrusted: () => false }).fastMode.eligibleModels], ["global-model"]);

		const trusted = readCodexToolsSettings({ cwd, isProjectTrusted: () => true });
		assert.deepEqual([...trusted.fastMode.eligibleModels], ["cwd-project-model"]);
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(temp, { recursive: true, force: true });
	}
});

test("fast mode settings match unqualified model IDs and constrain defaults to eligible models", () => {
	const settings = fastModeSettingsFromConfig({
		codexTools: {
			fastMode: {
				eligibleModels: ["gpt-5.4", "newapi/gpt-5.5", " gpt-5.5 "],
				defaultEnabledModels: ["gpt-5.5", "gpt-5.6", "openai/gpt-5.4"],
			},
		},
	});

	assert.deepEqual([...settings.eligibleModels], ["gpt-5.4", "gpt-5.5"]);
	assert.deepEqual([...settings.defaultEnabledModels], ["gpt-5.5"]);
});

test("fast mode ignores legacy and invalid allowlists but accepts an explicit empty allowlist", () => {
	assert.deepEqual([...fastModeSettingsFromConfig({
		codexTools: { fastModels: ["custom-model"] },
	}).eligibleModels], ["gpt-5.4", "gpt-5.5"]);
	assert.deepEqual([...fastModeSettingsFromConfig({
		codexTools: { fastMode: { eligibleModels: ["newapi/gpt-5.5"] } },
	}).eligibleModels], ["gpt-5.4", "gpt-5.5"]);
	assert.deepEqual([...fastModeSettingsFromConfig({
		codexTools: { fastMode: { eligibleModels: [] } },
	}).eligibleModels], []);
});

test("fast mode settings overlay each nested list independently", () => {
	const settings = fastModeSettingsFromConfigs([
		{ codexTools: { fastMode: { eligibleModels: ["gpt-5.4", "gpt-5.5"], defaultEnabledModels: ["gpt-5.5"] } } },
		{ codexTools: { fastMode: { eligibleModels: ["gpt-5.4"], defaultEnabledModels: ["gpt-5.4"] } } },
	]);

	assert.deepEqual([...settings.eligibleModels], ["gpt-5.4"]);
	assert.deepEqual([...settings.defaultEnabledModels], ["gpt-5.4"]);
});

test("review settings have constrained defaults and trusted-project overlay", () => {
	assert.deepEqual(reviewSettingsFromConfig({}), { provider: "newapi", model: "gpt-5.6-sol", effort: "high", timeoutMs: 300_000 });
	assert.deepEqual(reviewSettingsFromConfigs([
		{ codexTools: { review: { provider: "global", model: "gpt-global", effort: "medium", timeoutMs: 10_000 } } },
		{ codexTools: { review: { model: "gpt-project", timeoutMs: 20_000, ignored: "no" } } },
	]), { provider: "global", model: "gpt-project", effort: "medium", timeoutMs: 20_000 });
	assert.equal(reviewSettingsFromConfig({ codexTools: { review: { effort: "extreme" } } }).effort, "high");
	assert.equal(reviewSettingsFromConfig({ codexTools: { review: { timeoutMs: 0.5 } } }).timeoutMs, 300_000);
	assert.equal(reviewSettingsFromConfig({ codexTools: { review: { timeoutMs: 2_147_483_648 } } }).timeoutMs, 300_000);
});

test("responsesCompactionSettingsFromConfig defaults to disabled newapi only", () => {
	assert.deepEqual(responsesCompactionSettingsFromConfig({}), { enabled: false, providers: ["newapi"] });
	assert.deepEqual(responsesCompactionSettingsFromConfig({
		codexTools: { responsesCompaction: { enabled: false, providers: ["newapi", "proxy"] } },
	}), { enabled: false, providers: ["newapi", "proxy"] });
});

test("responsesCompaction settings overlay only valid enabled and providers fields", () => {
	assert.deepEqual(responsesCompactionSettingsFromConfigs([
		{ codexTools: { responsesCompaction: { enabled: false, providers: ["global"] } } },
		{ codexTools: { responsesCompaction: { enabled: "yes", providers: ["project"] } } },
	]), { enabled: false, providers: ["project"] });
	assert.deepEqual(responsesCompactionSettingsFromConfig({
		codexTools: { responsesCompaction: { enabled: true, providers: ["newapi", 1] } },
	}), { enabled: true, providers: ["newapi"] });
});

