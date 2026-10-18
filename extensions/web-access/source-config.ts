import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	formatQualifiedModel,
	resolveThinkingAwareModel,
	responsesReasoningEffort,
	type QualifiedModel,
	type ThinkingCapableModel,
	type ThinkingLevel,
} from "./models.ts";
import { rawProviderHeaders } from "./provider-headers.ts";
import { redactSensitiveText, SearchBackendError } from "./responses-client.ts";
import type { AnsweringSearchSourceName } from "./settings.ts";
import { raceWithSignal } from "./source-deadline.ts";

const XAI_ROUTE_MESSAGE =
	"xAI search only supports a CLIProxyAPI route. Direct official xAI endpoints such as api.x.ai are rejected; the Pi provider name may stay xai when the resolved URL is a proxy.";
const MAX_MODEL_ACCESS_ERROR_CHARS = 1000;
const RESPONSES_API = "openai-responses";

function safeModelAccessError(error: unknown, fallback: string): string {
	const message = error instanceof Error ? error.message : fallback;
	return redactSensitiveText(message, { baseUrl: "" }).slice(0, MAX_MODEL_ACCESS_ERROR_CHARS);
}

export type ResolvedModelAccess = {
	baseUrl: string;
	apiKey?: string;
	headers: Record<string, string | null>;
	provider: string;
	model: string;
	api: string;
};

export type ResolvedSourceConfig = ResolvedModelAccess & {
	source: AnsweringSearchSourceName;
	requestedThinkingLevel: ThinkingLevel;
	thinkingLevel: ThinkingLevel;
	/** Mapped Responses `reasoning.effort` when effective thinking is non-off. */
	reasoningEffort?: string;
};

export type ResolveModelAccessOptions = {
	label: string;
	signal?: AbortSignal;
	rejectOfficialXai?: boolean;
};

export async function resolveModelAccess(
	ctx: ExtensionContext,
	configured: QualifiedModel,
	options: ResolveModelAccessOptions,
): Promise<ResolvedModelAccess> {
	let model;
	try {
		model = ctx.modelRegistry.find(configured.provider, configured.modelId);
	} catch (error) {
		throw new SearchBackendError("missing_config", safeModelAccessError(error, `Failed to resolve ${options.label} model.`));
	}
	if (!model) {
		throw new SearchBackendError("missing_config", `Missing ${options.label} model ${formatQualifiedModel(configured)}.`);
	}

	let auth;
	try {
		auth = await raceWithSignal(ctx.modelRegistry.getApiKeyAndHeaders(model), options.signal);
	} catch (error) {
		if ((error instanceof DOMException && error.name === "AbortError") || (error instanceof Error && error.name === "TimeoutError")) {
			throw error;
		}
		throw new SearchBackendError("auth_failed", safeModelAccessError(error, `Failed to authenticate ${options.label} model.`));
	}
	if (!auth.ok) {
		throw new SearchBackendError("auth_failed", `Authentication failed for ${options.label} model ${formatQualifiedModel(configured)}.`);
	}

	const baseUrl = resolveModelBaseUrl(auth.baseUrl ?? model.baseUrl, options);
	return {
		baseUrl,
		apiKey: typeof auth.apiKey === "string" ? auth.apiKey : undefined,
		headers: rawProviderHeaders(auth.headers),
		provider: model.provider,
		model: model.id,
		api: model.api,
	};
}

function findThinkingCapableModel(
	ctx: ExtensionContext,
	provider: string,
	modelId: string,
): ThinkingCapableModel | undefined {
	try {
		return ctx.modelRegistry.find(provider, modelId) as ThinkingCapableModel | undefined;
	} catch {
		return undefined;
	}
}

/**
 * Resolve a hosted search source model with optional Pi thinking suffix.
 * Unsuffixed models keep legacy behavior and do not require openai-responses.
 * A thinking suffix requires openai-responses and may send reasoning.effort.
 */
export async function resolveSourceConfig(
	ctx: ExtensionContext,
	source: AnsweringSearchSourceName,
	configured: QualifiedModel,
	signal?: AbortSignal,
): Promise<ResolvedSourceConfig> {
	const thinking = resolveThinkingAwareModel(
		(provider, modelId) => findThinkingCapableModel(ctx, provider, modelId),
		configured,
	);
	if (thinking.status === "invalid_thinking") {
		throw new SearchBackendError(
			"missing_config",
			`Invalid thinking level in ${source} model (${thinking.suffix}). Use off, minimal, low, medium, high, xhigh, or max.`,
		);
	}
	if (thinking.status === "missing") {
		throw new SearchBackendError(
			"missing_config",
			`Missing ${source} model ${formatQualifiedModel(configured)}.`,
		);
	}

	const access = await resolveModelAccess(
		ctx,
		{ provider: thinking.provider, modelId: thinking.modelId },
		{
			label: source,
			signal,
			rejectOfficialXai: source === "xai",
		},
	);

	// Only thinking-suffixed search models require openai-responses.
	// Unsuffixed legacy source models keep prior acceptance rules.
	if (thinking.requestedThinkingLevel !== "off" && access.api !== RESPONSES_API && access.api !== "custom-response") {
		throw new SearchBackendError(
			"unsupported_model",
			`${source} model ${formatQualifiedModel({ provider: access.provider, modelId: access.model })} must use ${RESPONSES_API} when a thinking level is set.`,
		);
	}

	const reasoningEffort = responsesReasoningEffort(thinking.model, thinking.thinkingLevel);
	return {
		source,
		...access,
		requestedThinkingLevel: thinking.requestedThinkingLevel,
		thinkingLevel: thinking.thinkingLevel,
		...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
	};
}

function resolveModelBaseUrl(candidate: unknown, options: ResolveModelAccessOptions): string {
	if (typeof candidate !== "string" || !candidate.trim()) {
		throw missingRouteConfig(candidate, options);
	}
	let parsed: URL;
	try {
		parsed = new URL(candidate);
	} catch {
		throw missingRouteConfig(candidate, options);
	}
	if (parsed.username || parsed.password) {
		throw new SearchBackendError("missing_config", `Invalid ${options.label} model base URL.`);
	}
	if (options.rejectOfficialXai && isOfficialXaiHostname(parsed.hostname)) {
		throw new SearchBackendError("missing_config", XAI_ROUTE_MESSAGE);
	}
	return candidate;
}

function missingRouteConfig(candidate: unknown, options: ResolveModelAccessOptions): SearchBackendError {
	if (options.rejectOfficialXai) return new SearchBackendError("missing_config", XAI_ROUTE_MESSAGE);
	const rendered = typeof candidate === "string" && candidate.trim() ? candidate.trim() : "missing";
	return new SearchBackendError("missing_config", `Invalid ${options.label} model base URL: ${rendered}.`);
}

function isOfficialXaiHostname(hostname: string): boolean {
	const normalized = hostname.replace(/\.$/, "").toLowerCase();
	return normalized === "api.x.ai" || normalized.endsWith(".api.x.ai");
}
