import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { parseQualifiedModel, type QualifiedModel } from "./models.ts";
import { parseExtractionKernel, type ExtractionKernelName } from "./extract-kernels.ts";

export const PLUGIN_SETTINGS_KEY = "webAccess";
export const SOURCE_TIMEOUT_MS = 60_000;
export const FETCH_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_INLINE_CHARS = 30_000;
export const MAX_INLINE_CHARS = 200_000;
export const DEFAULT_FETCH_EXTRACT_KERNEL: ExtractionKernelName = "defuddle";

export const DEFAULT_FETCH_SOURCE: FetchSourceName = "cdp";

export const ANSWERING_SEARCH_SOURCES = ["openai", "xai"] as const;
export const RETRIEVAL_SEARCH_SOURCES = ["exa", "firecrawl"] as const;
export const SEARCH_SOURCE_ORDER = ["openai", "xai", "exa", "firecrawl"] as const;

export type AnsweringSearchSourceName = (typeof ANSWERING_SEARCH_SOURCES)[number];
export type RetrievalSearchSourceName = (typeof RETRIEVAL_SEARCH_SOURCES)[number];
export type WebSearchSourceName = AnsweringSearchSourceName | RetrievalSearchSourceName;
export type FetchSourceName = "cdp" | "exa" | "firecrawl";
export type { ExtractionKernelName };

export type WebAccessSettings = {
	openai?: QualifiedModel;
	xai?: QualifiedModel;
	fetchDefaultProvider?: FetchSourceName;
	fetchCdpEndpoint?: string;
	fetchMaxInlineChars?: number;
	fetchExtractKernel?: ExtractionKernelName;
	fetchExtractModel?: QualifiedModel;
};

export type PluginSettingsContext = {
	cwd?: string;
	isProjectTrusted?: () => boolean;
};

export type SourceConfigError = {
	source: WebSearchSourceName;
	message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function topLevelSettings(config: unknown): Record<string, unknown> {
	return isRecord(config) && isRecord(config[PLUGIN_SETTINGS_KEY]) ? config[PLUGIN_SETTINGS_KEY] : {};
}

function sourceModelSetting(settings: Record<string, unknown>, source: WebSearchSourceName): unknown {
	const block = settings[source];
	if (!isRecord(block) || !Object.hasOwn(block, "model")) return undefined;
	return block.model;
}

function fetchBlock(settings: Record<string, unknown>): Record<string, unknown> | undefined {
	const block = settings.fetch;
	return isRecord(block) ? block : undefined;
}

function fetchDefaultProviderSetting(settings: Record<string, unknown>): unknown {
	const fetch = fetchBlock(settings);
	if (!fetch || !Object.hasOwn(fetch, "defaultProvider")) return undefined;
	return fetch.defaultProvider;
}

function fetchCdpEndpointSetting(settings: Record<string, unknown>): unknown {
	const fetch = fetchBlock(settings);
	if (!fetch) return undefined;
	const cdp = fetch.cdp;
	if (!isRecord(cdp) || !Object.hasOwn(cdp, "endpoint")) return undefined;
	return cdp.endpoint;
}

function fetchMaxInlineCharsSetting(settings: Record<string, unknown>): unknown {
	const fetch = fetchBlock(settings);
	if (!fetch || !Object.hasOwn(fetch, "maxInlineChars")) return undefined;
	return fetch.maxInlineChars;
}

function fetchExtractKernelSetting(settings: Record<string, unknown>): unknown {
	const fetch = fetchBlock(settings);
	if (!fetch) return undefined;
	const extract = fetch.extract;
	if (!isRecord(extract) || !Object.hasOwn(extract, "kernel")) return undefined;
	return extract.kernel;
}

function fetchExtractModelSetting(settings: Record<string, unknown>): unknown {
	const fetch = fetchBlock(settings);
	if (!fetch) return undefined;
	const extract = fetch.extract;
	if (!isRecord(extract) || !Object.hasOwn(extract, "model")) return undefined;
	return extract.model;
}

export function normalizeMaxInlineChars(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value) || !Number.isInteger(value) || value <= 0) {
		return DEFAULT_MAX_INLINE_CHARS;
	}
	return Math.min(value, MAX_INLINE_CHARS);
}

export function resolveCdpEndpoint(settings: WebAccessSettings, env: NodeJS.ProcessEnv = process.env): string | undefined {
	const fromEnv = typeof env.CDP_ENDPOINT === "string" ? env.CDP_ENDPOINT.trim() : "";
	if (fromEnv) return fromEnv;
	const fromSettings = typeof settings.fetchCdpEndpoint === "string" ? settings.fetchCdpEndpoint.trim() : "";
	return fromSettings || undefined;
}

export function resolveCdpApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const key = typeof env.CDP_API_KEY === "string" ? env.CDP_API_KEY.trim() : "";
	return key || undefined;
}

export function processEnvFromContext(ctx?: object): NodeJS.ProcessEnv {
	if (ctx && "env" in ctx && ctx.env && typeof ctx.env === "object") {
		return ctx.env as NodeJS.ProcessEnv;
	}
	return process.env;
}

export function resolveExaApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const key = typeof env.EXA_API_KEY === "string" ? env.EXA_API_KEY.trim() : "";
	return key || undefined;
}

export function resolveFirecrawlApiKey(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const key = typeof env.FIRECRAWL_API_KEY === "string" ? env.FIRECRAWL_API_KEY.trim() : "";
	return key || undefined;
}

export function isAnsweringSearchSource(source: string): source is AnsweringSearchSourceName {
	return source === "openai" || source === "xai";
}

export function isSearchSourceConfigured(
	source: WebSearchSourceName,
	settings: WebAccessSettings,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (source === "openai" || source === "xai") return Boolean(settings[source]);
	if (source === "exa") return Boolean(resolveExaApiKey(env));
	return true;
}

export function isFetchSourceConfigured(
	source: FetchSourceName,
	settings: WebAccessSettings,
	env: NodeJS.ProcessEnv = process.env,
): boolean {
	if (source === "cdp") return Boolean(resolveCdpEndpoint(settings, env));
	if (source === "exa") return Boolean(resolveExaApiKey(env));
	return true;
}

export function searchSourceMissingMessage(source: WebSearchSourceName): string {
	if (source === "exa") return "No Exa search source is configured. Set EXA_API_KEY.";
	if (source === "firecrawl") return "No Firecrawl search source is configured.";
	return `No ${source} web search source is configured. Set webAccess.${source}.model.`;
}

export function fetchSourceMissingMessage(source: FetchSourceName): string {
	if (source === "exa") return "No Exa fetch source is configured. Set EXA_API_KEY.";
	if (source === "firecrawl") return "No Firecrawl fetch source is configured.";
	return "No CDP endpoint is configured. Set CDP_ENDPOINT or webAccess.fetch.cdp.endpoint.";
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

export function pluginSettingConfigs(ctx?: PluginSettingsContext): unknown[] {
	const configs = [readJsonFile(join(agentConfigDir(), "settings.json"))];
	if (ctx?.cwd && ctx.isProjectTrusted?.() === true) configs.push(readJsonFile(join(resolve(ctx.cwd), CONFIG_DIR_NAME, "settings.json")));
	return configs;
}

function applySourceModel(
	result: WebAccessSettings,
	errors: SourceConfigError[],
	source: WebSearchSourceName,
	value: unknown,
): void {
	if (value === undefined) return;
	for (let index = errors.length - 1; index >= 0; index--) {
		if (errors[index]?.source === source) errors.splice(index, 1);
	}
	const parsed = parseQualifiedModel(value);
	if (parsed.status === "missing") {
		delete result[source];
		return;
	}
	if (parsed.status === "invalid") {
		delete result[source];
		errors.push({
			source,
			message: `Invalid webAccess.${source}.model. Use a provider-qualified model such as newapi/gpt-5.4-mini or newapi/gpt-5.4-mini:high.`,
		});
		return;
	}
	result[source] = parsed.model;
}

function isFetchSourceName(value: unknown): value is FetchSourceName {
	return value === "cdp" || value === "exa" || value === "firecrawl";
}

function applyFetchSettings(
	result: WebAccessSettings,
	defaultProvider: unknown,
	endpoint: unknown,
	maxInlineChars: unknown,
	extractKernel: unknown,
	extractModel: unknown,
): void {
	if (defaultProvider !== undefined) {
		if (isFetchSourceName(defaultProvider)) result.fetchDefaultProvider = defaultProvider;
		else delete result.fetchDefaultProvider;
	}
	if (endpoint !== undefined) {
		if (typeof endpoint === "string" && endpoint.trim()) result.fetchCdpEndpoint = endpoint.trim();
		else delete result.fetchCdpEndpoint;
	}
	if (maxInlineChars !== undefined) {
		result.fetchMaxInlineChars = normalizeMaxInlineChars(maxInlineChars);
	}
	if (extractKernel !== undefined) {
		const parsed = parseExtractionKernel(extractKernel);
		if (parsed === undefined || parsed === "invalid") {
			// Explicit invalid/blank leaves clear inheritance and resolve to Defuddle.
			result.fetchExtractKernel = DEFAULT_FETCH_EXTRACT_KERNEL;
		} else {
			result.fetchExtractKernel = parsed;
		}
	}
	if (extractModel !== undefined) {
		const parsed = parseQualifiedModel(extractModel);
		if (parsed.status === "ok") {
			result.fetchExtractModel = parsed.model;
		} else {
			// Missing/blank/invalid project model clears an inherited extract model.
			delete result.fetchExtractModel;
		}
	}
}

export function webAccessSettingsFromConfigs(configs: unknown[]): {
	settings: WebAccessSettings;
	errors: SourceConfigError[];
} {
	const settings: WebAccessSettings = {};
	const errors: SourceConfigError[] = [];
	for (const config of configs) {
		const top = topLevelSettings(config);
		applySourceModel(settings, errors, "openai", sourceModelSetting(top, "openai"));
		applySourceModel(settings, errors, "xai", sourceModelSetting(top, "xai"));
		applyFetchSettings(
			settings,
			fetchDefaultProviderSetting(top),
			fetchCdpEndpointSetting(top),
			fetchMaxInlineCharsSetting(top),
			fetchExtractKernelSetting(top),
			fetchExtractModelSetting(top),
		);
	}
	return { settings, errors };
}

export function webAccessSettingsFromConfig(config: unknown): {
	settings: WebAccessSettings;
	errors: SourceConfigError[];
} {
	return webAccessSettingsFromConfigs([config]);
}

export function readWebAccessSettings(ctx?: PluginSettingsContext): {
	settings: WebAccessSettings;
	errors: SourceConfigError[];
} {
	return webAccessSettingsFromConfigs(pluginSettingConfigs(ctx));
}
