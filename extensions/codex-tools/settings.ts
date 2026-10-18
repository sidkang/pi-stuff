import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";

export const PLUGIN_SETTINGS_KEY = "codexTools";

const DEFAULT_FAST_MODELS = ["gpt-5.4", "gpt-5.5"];
const FAST_MODE_SETTING_KEY = "fastMode";
const FAST_MODE_ELIGIBLE_MODELS_SETTING_KEY = "eligibleModels";
const FAST_MODE_DEFAULT_ENABLED_MODELS_SETTING_KEY = "defaultEnabledModels";
const RESPONSES_COMPACTION_SETTING_KEY = "responsesCompaction";
const DEFAULT_RESPONSES_COMPACTION_PROVIDERS = ["newapi"];
const DEFAULT_REVIEW_PROVIDER = "newapi";
const DEFAULT_REVIEW_MODEL = "gpt-5.6-sol";
const DEFAULT_REVIEW_EFFORT = "high";
const DEFAULT_REVIEW_TIMEOUT_MS = 300_000;
const REVIEW_SETTING_KEY = "review";

export type ResponsesCompactionSettings = {
	enabled: boolean;
	providers: string[];
};

export type FastModeSettings = {
	eligibleModels: Set<string>;
	defaultEnabledModels: Set<string>;
};

export type ReviewSettings = {
	provider: string;
	model: string;
	effort: string;
	timeoutMs: number;
};

export type PluginSettingsContext = {
	cwd?: string;
	isProjectTrusted?: () => boolean;
};

export type CodexToolsSettings = {
	fastMode: FastModeSettings;
	responsesCompaction: ResponsesCompactionSettings;
	review: ReviewSettings;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function positiveInteger(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0 || value > 2_147_483_647) return undefined;
	return value;
}

function topLevelSettings(config: unknown): Record<string, unknown> {
	return isRecord(config) && isRecord(config[PLUGIN_SETTINGS_KEY]) ? config[PLUGIN_SETTINGS_KEY] : {};
}

function fastModeSettings(config: unknown): Record<string, unknown> {
	const settings = topLevelSettings(config);
	return isRecord(settings[FAST_MODE_SETTING_KEY]) ? settings[FAST_MODE_SETTING_KEY] : {};
}

function responsesCompactionSettings(config: unknown): Record<string, unknown> {
	const settings = topLevelSettings(config);
	return isRecord(settings[RESPONSES_COMPACTION_SETTING_KEY]) ? settings[RESPONSES_COMPACTION_SETTING_KEY] : {};
}

function reviewSettings(config: unknown): Record<string, unknown> {
	const settings = topLevelSettings(config);
	return isRecord(settings[REVIEW_SETTING_KEY]) ? settings[REVIEW_SETTING_KEY] : {};
}

function normalizeModelId(value: string): string | undefined {
	const id = value.trim();
	if (!id || id.includes("/")) return undefined;
	return id;
}

function modelIdsFromSetting(value: unknown): string[] | undefined {
	if (Array.isArray(value)) {
		if (value.length === 0) return [];
		const modelIds = value
			.filter((item): item is string => typeof item === "string")
			.map(normalizeModelId)
			.filter((item): item is string => !!item);
		return modelIds.length > 0 ? modelIds : undefined;
	}
	if (typeof value === "string") {
		const modelIds = value
			.split(/[\s,]+/)
			.map(normalizeModelId)
			.filter((item): item is string => !!item);
		return modelIds.length > 0 ? modelIds : undefined;
	}
	return undefined;
}

function readJsonFile(path: string): unknown | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

export function agentConfigDir(): string {
	return getAgentDir();
}

export function projectRoot(cwd: string): string {
	let current = resolve(cwd);
	for (;;) {
		if (existsSync(join(current, ".jj")) || existsSync(join(current, ".git")) || existsSync(join(current, CONFIG_DIR_NAME))) return current;
		const parent = dirname(current);
		if (parent === current) return resolve(cwd);
		current = parent;
	}
}

export function pluginSettingConfigs(ctx?: PluginSettingsContext): unknown[] {
	const configs = [readJsonFile(join(agentConfigDir(), "settings.json"))];
	if (ctx?.cwd && ctx.isProjectTrusted?.() === true) configs.push(readJsonFile(join(resolve(ctx.cwd), CONFIG_DIR_NAME, "settings.json")));
	return configs;
}

export function fastModeSettingsFromConfigs(configs: unknown[]): FastModeSettings {
	let eligibleModels: string[] | undefined;
	let defaultEnabledModels: string[] | undefined;
	for (const config of configs) {
		const fastMode = fastModeSettings(config);
		eligibleModels = modelIdsFromSetting(fastMode[FAST_MODE_ELIGIBLE_MODELS_SETTING_KEY]) ?? eligibleModels;
		defaultEnabledModels = modelIdsFromSetting(fastMode[FAST_MODE_DEFAULT_ENABLED_MODELS_SETTING_KEY]) ?? defaultEnabledModels;
	}
	const eligible = new Set(eligibleModels ?? DEFAULT_FAST_MODELS);
	return {
		eligibleModels: eligible,
		defaultEnabledModels: new Set((defaultEnabledModels ?? []).filter((model) => eligible.has(model))),
	};
}

export function fastModeSettingsFromConfig(config: unknown): FastModeSettings {
	return fastModeSettingsFromConfigs([config]);
}

function providerNames(value: unknown): string[] | undefined {
	if (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.length > 0)) return undefined;
	return [...value];
}

export function responsesCompactionSettingsFromConfigs(configs: unknown[]): ResponsesCompactionSettings {
	const result: ResponsesCompactionSettings = {
		enabled: false,
		providers: [...DEFAULT_RESPONSES_COMPACTION_PROVIDERS],
	};
	for (const config of configs) {
		const settings = responsesCompactionSettings(config);
		if (typeof settings.enabled === "boolean") result.enabled = settings.enabled;
		result.providers = providerNames(settings.providers) ?? result.providers;
	}
	return result;
}

export function responsesCompactionSettingsFromConfig(config: unknown): ResponsesCompactionSettings {
	return responsesCompactionSettingsFromConfigs([config]);
}

export function reviewSettingsFromConfigs(configs: unknown[]): ReviewSettings {
	const result: ReviewSettings = {
		provider: DEFAULT_REVIEW_PROVIDER,
		model: DEFAULT_REVIEW_MODEL,
		effort: DEFAULT_REVIEW_EFFORT,
		timeoutMs: DEFAULT_REVIEW_TIMEOUT_MS,
	};
	for (const config of configs) {
		const settings = reviewSettings(config);
		result.provider = nonEmptyString(settings.provider) ?? result.provider;
		result.model = nonEmptyString(settings.model) ?? result.model;
		if (settings.effort === "low" || settings.effort === "medium" || settings.effort === "high") result.effort = settings.effort;
		result.timeoutMs = positiveInteger(settings.timeoutMs) ?? result.timeoutMs;
	}
	return result;
}

export function reviewSettingsFromConfig(config: unknown): ReviewSettings {
	return reviewSettingsFromConfigs([config]);
}

export function readCodexToolsSettings(ctx?: PluginSettingsContext): CodexToolsSettings {
	const configs = pluginSettingConfigs(ctx);
	return {
		fastMode: fastModeSettingsFromConfigs(configs),
		responsesCompaction: responsesCompactionSettingsFromConfigs(configs),
		review: reviewSettingsFromConfigs(configs),
	};
}
