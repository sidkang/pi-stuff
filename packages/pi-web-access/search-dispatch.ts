import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { searchWithExa } from "./exa.ts";
import { searchWithFirecrawl } from "./firecrawl.ts";
import type { SourceAttempt } from "./search-errors.ts";
import { OpenAIWebSearchSource } from "./openai-web-search.ts";
import { ResponsesClient, type SearchBackendResponse, type SearchContextSize, type WebSearchUserLocation } from "./responses-client.ts";
import type { WebAccessSettings, WebSearchSourceName } from "./settings.ts";
import { resolveSourceConfig, type ResolvedSourceConfig } from "./source-config.ts";
import { XaiWebSearchSource } from "./xai-web-search.ts";

export type WebSearchRequestParams = {
	query: string;
	limit?: number;
	search_context_size?: SearchContextSize;
	allowed_domains?: string[];
	user_location?: WebSearchUserLocation;
};

export function boundedAttempt(attempt: SourceAttempt): SourceAttempt {
	return { ...attempt, ...(attempt.error ? { error: attempt.error.slice(0, 1000) } : {}) };
}

export async function dispatchSearch(options: {
	source: WebSearchSourceName;
	ctx: ExtensionContext;
	settings: WebAccessSettings;
	env: NodeJS.ProcessEnv;
	params: WebSearchRequestParams;
	signal: AbortSignal;
}): Promise<{ response: SearchBackendResponse; resolved?: ResolvedSourceConfig }> {
	const { source, params, signal, env } = options;
	if (source === "exa") return { response: await searchWithExa({ ...params, signal }, env) };
	if (source === "firecrawl") return { response: await searchWithFirecrawl({ ...params, signal }, env) };
	const resolved = await resolveSourceConfig(options.ctx, source, options.settings[source]!, signal);
	try {
		const client = new ResponsesClient({ baseUrl: resolved.baseUrl, apiKey: resolved.apiKey, headers: resolved.headers });
		const request = {
			...params, model: resolved.model, signal,
			search_context_size: params.search_context_size ?? "high",
			...(resolved.reasoningEffort !== undefined ? { reasoningEffort: resolved.reasoningEffort } : {}),
		};
		const backend = source === "openai" ? new OpenAIWebSearchSource(client) : new XaiWebSearchSource(client);
		return { response: await backend.search(request), resolved };
	} catch (error) {
		throw new SearchDispatchError(error, resolved);
	}
}

export class SearchDispatchError extends Error {
	readonly resolved: ResolvedSourceConfig;
	override readonly cause: unknown;

	constructor(cause: unknown, resolved: ResolvedSourceConfig) {
		super(cause instanceof Error ? cause.message : String(cause), cause instanceof Error ? { cause } : undefined);
		this.name = "SearchDispatchError";
		this.resolved = resolved;
		this.cause = cause;
	}
}
