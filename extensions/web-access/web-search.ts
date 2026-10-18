import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import { boundedAttempt, dispatchSearch, SearchDispatchError } from "./search-dispatch.ts";
import { classifySearchFailure, formatWebSearchFailureMessage } from "./search-errors.ts";
import { createSearchRenderers } from "./presentation.ts";
import { searchToolResult, SearchBackendError, type SearchToolResult } from "./responses-client.ts";
import {
	isAnsweringSearchSource,
	isSearchSourceConfigured,
	processEnvFromContext,
	readWebAccessSettings,
	searchSourceMissingMessage,
	SEARCH_SOURCE_ORDER,
	SOURCE_TIMEOUT_MS,
	type PluginSettingsContext,
} from "./settings.ts";
import type { ResolvedSourceConfig } from "./source-config.ts";
import { createSourceDeadline } from "./source-deadline.ts";
import { createToolErrorDetailsBridge } from "./tool-error-details.ts";
import { SearchOutputSchema, WEB_READ_ANNOTATIONS } from "./result-schema.ts";

const WebSearchParams = Type.Object({
	query: Type.String({ minLength: 1, description: "Natural-language web search query." }),
	provider: StringEnum(SEARCH_SOURCE_ORDER, { description: "Required source: openai or xai returns a model-written answer with citations; exa or firecrawl returns URLs and excerpts. Exa requires EXA_API_KEY; Firecrawl supports keyless access. No default or automatic source fallback." }),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20, description: "Maximum number of sources to return." })),
	search_context_size: Type.Optional(StringEnum(["low", "medium", "high"] as const)),
	allowed_domains: Type.Optional(Type.Array(Type.String(), { description: "Domain allowlist when supported by the backend." })),
	user_location: Type.Optional(Type.Object({
		type: Type.Optional(StringEnum(["approximate"] as const)),
		country: Type.Optional(Type.String({ description: "Two-letter ISO 3166-1 country code. Use CN for China, US for the United States, JP for Japan, GB for the United Kingdom, or DE for Germany. Do not use country names such as China or Japan." })),
		region: Type.Optional(Type.String()),
		city: Type.Optional(Type.String()),
		timezone: Type.Optional(Type.String()),
	}, { additionalProperties: false })),
}, { additionalProperties: false });

type WebSearchParams = Static<typeof WebSearchParams>;

function settingsContext(ctx: ExtensionContext): PluginSettingsContext {
	return {
		cwd: ctx.cwd,
		isProjectTrusted: typeof ctx.isProjectTrusted === "function" ? () => ctx.isProjectTrusted() : undefined,
	};
}

export default function webSearch(pi: ExtensionAPI) {
	const errorDetails = createToolErrorDetailsBridge("web_search");
	errorDetails.install(pi);
	const renderers = createSearchRenderers("web");

	pi.registerTool({
		name: "web_search",
		label: "Web Search",
		description: "Search the web using one explicitly selected source. Returns an answer with citations or URLs and excerpts.",
		promptSnippet: "Search the web using a required provider: openai, xai, exa, or firecrawl.",
		promptGuidelines: [
			"Use web_search when current or external web information is needed.",
			"Always include a clear natural-language query and specify provider.",
			"Choose openai or xai for a model-written answer with citations; choose exa or firecrawl for URLs and excerpts. Honor a source explicitly requested by the user; otherwise choose one appropriate to the task.",
			"Each call uses exactly one source. There is no all mode or automatic source fallback; decide whether to try another source only after inspecting a failure.",
			"Use allowed_domains when the user asks for specific primary sources or official docs.",
			"Treat results as read-only evidence; cite returned source URLs in the final answer when used.",
		],
		parameters: WebSearchParams,
		outputSchema: SearchOutputSchema,
		annotations: WEB_READ_ANNOTATIONS,
		renderShell: "self",
		async execute(toolCallId: string, params: WebSearchParams, signal: AbortSignal | undefined, onUpdate: ((result: SearchToolResult) => void) | undefined, ctx: ExtensionContext) {
			const startedAt = Date.now();
			const source = params.provider;
			// Validate direct callers too, before configuration, credentials, or network access.
			if (!SEARCH_SOURCE_ORDER.includes(source) || Object.hasOwn(params, "merge")) {
				const message = "Web search failed: provider is required and must be openai, xai, exa, or firecrawl; merge is not supported.";
				errorDetails.record(toolCallId, { ok: false, code: "invalid_input", error: message, elapsedMs: Date.now() - startedAt, timeoutMs: SOURCE_TIMEOUT_MS });
				throw new Error(message);
			}
			const { settings, errors } = readWebAccessSettings(settingsContext(ctx));
			const env = processEnvFromContext(ctx);
			const sourceStartedAt = Date.now();
			let resolved: ResolvedSourceConfig | undefined;
			const publishPartial = () => onUpdate?.({
				content: [{ type: "text", text: "Searching web..." }],
				details: { phase: "Searching web...", startedAt, elapsedMs: Date.now() - startedAt, timeoutMs: SOURCE_TIMEOUT_MS, source },
			});
			publishPartial();
			const ticker = setInterval(publishPartial, 1000);
			try {
				const configError = errors.find((error) => error.source === source);
				if (configError) throw new SearchBackendError("missing_config", configError.message);
				if (!isSearchSourceConfigured(source, settings, env)) {
					throw new SearchBackendError("missing_config", searchSourceMissingMessage(source));
				}
				const dispatched = await dispatchSearch({ source, ctx, settings, env, params, signal: createSourceDeadline(signal) });
				resolved = dispatched.resolved;
				const attempt = boundedAttempt({ source, ok: true, provider: resolved?.provider ?? source, model: resolved?.model, api: resolved?.api, elapsedMs: Date.now() - sourceStartedAt });
				return searchToolResult(params.query, dispatched.response, {
					provider: resolved?.provider ?? source, model: resolved?.model, api: resolved?.api, source,
					elapsedMs: Date.now() - startedAt, timeoutMs: SOURCE_TIMEOUT_MS, attempts: [attempt],
				});
			} catch (error) {
				const dispatchedError = error instanceof SearchDispatchError ? error : undefined;
				resolved = resolved ?? dispatchedError?.resolved;
				const classified = classifySearchFailure(signal?.aborted
					? new SearchBackendError("aborted", "web search was aborted")
					: dispatchedError?.cause ?? error);
				const message = formatWebSearchFailureMessage(classified.message);
				const attempt = boundedAttempt({
					source, ok: false, code: classified.code, status: classified.status, error: classified.message,
					provider: resolved?.provider ?? (isAnsweringSearchSource(source) ? undefined : source),
					model: resolved?.model, api: resolved?.api, elapsedMs: Date.now() - sourceStartedAt,
				});
				errorDetails.record(toolCallId, {
					ok: false, error: message, code: classified.code, status: classified.status, source,
					provider: resolved?.provider, model: resolved?.model, api: resolved?.api,
					elapsedMs: Date.now() - startedAt, timeoutMs: SOURCE_TIMEOUT_MS, attempts: [attempt],
				});
				throw new Error(message, { cause: error });
			} finally {
				clearInterval(ticker);
			}
		},
		renderCall: renderers.renderCall,
		renderResult: renderers.renderResult,
	});
}

export { webSearchCallPresentation, webSearchResultPresentation, renderWebSearchToolResult } from "./presentation.ts";
export { formatWebSearchFailureMessage } from "./search-errors.ts";
